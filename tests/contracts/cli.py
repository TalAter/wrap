"""Public CLI contracts; WRAP_COMMAND selects a reference or native executable."""
import json
import os
from pathlib import Path
import shlex
import re
import signal
import subprocess
import tempfile
import unittest

VERSION = re.search(r'^version\s*=\s*"([^"]+)"', Path('Cargo.toml').read_text(), re.M)[1]
COMMAND = shlex.split(os.environ.get('WRAP_COMMAND', 'target/debug/wrap'))
COMMAND[0] = str(Path(COMMAND[0]).resolve()) if '/' in COMMAND[0] else COMMAND[0]


class CliContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wrap-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'data'
        self.home.mkdir()
        (self.home / 'memory.json').write_text('{"/":[{"fact":"fixture"}]}')
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith('WRAP_') and k not in ('FORCE_COLOR', 'BASH_ENV', 'ENV')}
        self.env.update(HOME=str(self.root), WRAP_HOME=str(self.home),
                        TMPDIR=str(self.root), WRAP_CONFIG='{}', SHELL='/bin/bash',
                        NO_COLOR='1', WRAP_NO_ANIMATION='1')

    def run_wrap(self, *args, responses=None, stdin=b'', config=None):
        env = self.env.copy()
        if responses is not None:
            env['WRAP_TEST_RESPONSES'] = json.dumps(responses)
        if config is not None:
            env['WRAP_CONFIG'] = json.dumps(config)
        return subprocess.run(COMMAND + list(args), input=stdin, capture_output=True,
                              env=env, timeout=15)

    def entries(self):
        return [json.loads(line) for line in
                (self.home / 'logs/wrap.jsonl').read_text().splitlines()]

    def test_dispatch_does_not_load_invalid_config(self):
        self.env['WRAP_CONFIG'] = '{broken'
        result = self.run_wrap('--version')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, (VERSION + '\n').encode(), b''))
        self.assertFalse((self.home / 'logs').exists())
        result = self.run_wrap('--help')
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'Usage:', result.stdout)
        self.assertEqual(result.stderr, b'')

    def test_leading_modifiers_stop_at_prompt(self):
        result = self.run_wrap('describe', '--model', 'literal', responses=[reply('ok')])
        self.assertEqual(result.stdout, b'ok\n')
        users = [t['text'] for t in self.entries()[0]['turns'] if t['kind'] == 'user']
        self.assertEqual(users, ['describe --model literal'])

    def test_invalid_modifier_has_no_side_effects(self):
        result = self.run_wrap('--verbose=true', 'hello')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'does not take a value', result.stderr)
        self.assertFalse((self.home / 'logs').exists())

    def test_answer_is_only_stdout_and_logged(self):
        result = self.run_wrap('question', responses=[reply('42')])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'42\n', b''))
        entry = self.entries()[0]
        self.assertEqual(entry['outcome'], 'success')
        self.assertEqual(entry['input_source'], 'argv')
        self.assertFalse(any(t['kind'] == 'final' for t in entry['turns']))

    def test_final_shell_exit_and_streams(self):
        result = self.run_wrap('fixture', responses=[command('printf useful; printf diagnostic >&2; exit 7')])
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, b'useful')
        self.assertIn(b'diagnostic', result.stderr)
        final = self.entries()[0]['turns'][-1]
        self.assertEqual((final['kind'], final['exit_code'], final['source']), ('final', 7, 'model'))

    def test_intermediate_output_is_captured(self):
        result = self.run_wrap('fixture', responses=[command('printf probe', final=False), reply('done')])
        self.assertEqual((result.returncode, result.stdout), (0, b'done\n'))
        steps = [t for t in self.entries()[0]['turns'] if t['kind'] == 'step']
        self.assertEqual(len(steps), 1)
        self.assertIn('probe', steps[0]['output'])

    def test_nonfinal_last_round_is_not_executed(self):
        result = self.run_wrap('fixture', responses=[command('printf never', final=False)], config={'maxRounds': 1})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        entry = self.entries()[0]
        self.assertEqual(entry['outcome'], 'max_rounds')
        self.assertFalse(any(t['kind'] == 'step' for t in entry['turns']))

    def test_binary_pipe_is_materialized_private_and_intact(self):
        content = b'\x00\xff\x80fixture\n'
        result = self.run_wrap('fixture', stdin=content, responses=[command('cat "$WRAP_TEMP_DIR/input"')])
        self.assertEqual((result.returncode, result.stdout), (0, content))
        attachment = self.entries()[0]['attached_input']
        self.assertEqual(attachment['size'], len(content))
        self.assertIn('Binary content', attachment['preview'])
        path = Path(attachment['path'])
        self.assertEqual(path.read_bytes(), content)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_continue_rejects_missing_parent_before_reading_config(self):
        self.env['WRAP_CONFIG'] = '{broken'
        result = self.run_wrap('-c', 'again')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'Continue error: no previous wrap run found.', result.stderr)
        self.assertFalse((self.home / 'logs').exists())

    def test_log_limit_counts_physical_lines_and_search_counts_matches(self):
        logs = self.home / 'logs'
        logs.mkdir()
        (logs / 'wrap.jsonl').write_text('{"text":"match first"}\n{broken\n{"text":"match last"}\n')
        result = self.run_wrap('--log', '2')
        self.assertEqual([json.loads(x) for x in result.stdout.splitlines()], [{'text': 'match last'}])
        self.assertIn(b'skipped 1 corrupt', result.stderr)
        result = self.run_wrap('--log', 'match', '1')
        self.assertEqual([json.loads(x) for x in result.stdout.splitlines()], [{'text': 'match last'}])

    def test_medium_command_is_blocked_without_tty_and_yolo_executes(self):
        response = command('printf approved')
        response['risk_level'] = 'medium'
        result = self.run_wrap('fixture', responses=[response])
        self.assertEqual((result.returncode, result.stdout), (1, b''))
        self.assertEqual(self.entries()[-1]['outcome'], 'blocked')
        result = self.run_wrap('--yolo', 'fixture', responses=[response])
        self.assertEqual((result.returncode, result.stdout), (0, b'approved'))

    def test_parse_retry_is_one_round_with_two_attempts(self):
        result = self.run_wrap('fixture', responses=['not json', reply('recovered')])
        self.assertEqual((result.returncode, result.stdout), (0, b'recovered\n'))
        turns = [t for t in self.entries()[0]['turns'] if t['kind'] == 'assistant']
        self.assertEqual(len(turns), 1)
        self.assertEqual(len(turns[0]['attempts']), 2)
        self.assertEqual(turns[0]['attempts'][0]['error']['kind'], 'parse')
        self.assertEqual(turns[0]['attempts'][0]['raw_response'], 'not json')

    def test_trace_data_is_sidecar_and_parent_history_remains_readable(self):
        result = self.run_wrap('--log-traces', 'first', responses=[reply('one')])
        self.assertEqual(result.returncode, 0)
        parent = self.entries()[0]
        sidecar = json.loads((self.home / 'logs/traces' / (parent['id'] + '.json')).read_text())
        self.assertEqual(sidecar['entry_id'], parent['id'])
        result = self.run_wrap('-c', 'second', responses=[reply('two')])
        self.assertEqual((result.returncode, result.stdout), (0, b'two\n'))
        child = self.entries()[1]
        self.assertEqual(child['parent_id'], parent['id'])
        self.assertEqual([t['text'] for t in child['turns'] if t['kind'] == 'user'], ['second'])

    def test_memory_initialization_shares_provider_playback(self):
        (self.home / 'memory.json').unlink()
        result = self.run_wrap('fixture', responses=[{'facts': ['  Linux fixture  ', '']}, reply('ready')])
        self.assertEqual((result.returncode, result.stdout), (0, b'ready\n'))
        self.assertIn(b'Learning about your system...', result.stderr)
        self.assertIn(b'Detected OS and shell', result.stderr)
        self.assertEqual(json.loads((self.home / 'memory.json').read_text()), {'/': [{'fact': 'Linux fixture'}]})
        self.assertEqual(len([t for t in self.entries()[0]['turns'] if t['kind'] == 'assistant']), 1)

    def test_updates_are_saved_even_when_command_is_blocked(self):
        response = command('printf blocked')
        response.update(risk_level='medium', memory_updates=[{'scope': '/', 'fact': 'new fixture fact'}], watchlist_additions=['fixture-tool'])
        result = self.run_wrap('fixture', responses=[response])
        self.assertEqual(result.returncode, 1)
        self.assertIn({'fact': 'new fixture fact'}, json.loads((self.home / 'memory.json').read_text())['/'])
        self.assertEqual(json.loads((self.home / 'tool-watchlist.json').read_text())[0]['tool'], 'fixture-tool')

    def test_high_risk_scratchpad_retry_cannot_auto_approve(self):
        response = command('printf blocked')
        response['risk_level'] = 'high'
        result = self.run_wrap('fixture', responses=[response, response])
        self.assertEqual((result.returncode, result.stdout), (1, b''))
        turns = [t for t in self.entries()[0]['turns'] if t['kind'] == 'assistant']
        self.assertEqual(len(turns[0]['attempts']), 2)
        self.assertEqual(self.entries()[0]['outcome'], 'blocked')

    def test_provider_failure_records_partial_attempt(self):
        result = self.run_wrap('fixture', responses=['ERROR:fixture unavailable'])
        self.assertEqual((result.returncode, result.stdout), (1, b''))
        entry = self.entries()[0]
        self.assertEqual(entry['outcome'], 'error')
        self.assertEqual(entry['turns'][-1]['source'], 'error')
        turn = next(t for t in entry['turns'] if t['kind'] == 'assistant')
        self.assertEqual(turn['attempts'][0]['error']['kind'], 'provider')

    def test_piped_parent_cannot_be_continued(self):
        self.run_wrap('first', stdin=b'input', responses=[reply('one')])
        result = self.run_wrap('-c', 'second', responses=[reply('two')])
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'previous run had piped input', result.stderr)
        self.assertEqual(len(self.entries()), 1)

    def test_memory_init_accepts_complete_json_fences(self):
        (self.home / 'memory.json').unlink()
        result = self.run_wrap('fixture', responses=['```json\n{"facts":["fixture"]}\n```', reply('ready')])
        self.assertEqual((result.returncode, result.stdout), (0, b'ready\n'))

    def test_signal_cancels_an_open_stdin_pipe(self):
        import time
        process = subprocess.Popen(COMMAND + ['fixture'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        try:
            time.sleep(0.15)
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=1)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(process.stdout.read(), b'')
            self.assertFalse((self.home / 'logs').exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()


def reply(content):
    return {'type': 'reply', 'content': content, 'risk_level': 'low'}


def command(content, final=True):
    return {'type': 'command', 'content': content, 'risk_level': 'low', 'final': final}


if __name__ == '__main__':
    unittest.main()
