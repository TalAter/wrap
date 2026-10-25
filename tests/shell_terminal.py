#!/usr/bin/env python3
"""Shell process cleanup and termios restoration through the real-PTY harness.
Set WRAP_TEST_BASH to exercise an additional Bash binary.
"""
import os
import pathlib
import shutil
import signal
import stat
import shlex
import tempfile
import subprocess
import termios

import terminal as tty


def final_child_restores_terminal_modes():
    for shell in ['/bin/sh', '/bin/bash']:
        for confirmed in [False, True]:
            s = tty.Session(
                ['change terminal modes'],
                response=tty.command('stty -echo; echo FINISHED',
                                     risk='medium' if confirmed else 'low'),
                extra_env={'SHELL': shell},
                piped_stdin=b'attached input\n', redirect_stdout=True)
            try:
                if confirmed:
                    s.until('Run command?')
                    s.send('y')
                s.finish(0, alt=confirmed)
                assert s.stdout_file.read_bytes() == b'FINISHED\n', s.stdout_file.read_bytes()
            finally:
                s.close()


def failed_final_child_restores_terminal_modes():
    s = tty.Session(['failing command'], response=tty.command(
        'stty -echo; exit 3', risk='low'))
    try:
        s.finish(3, alt=False)
    finally:
        s.close()


def interrupted_final_child_restores_terminal_modes(shell='/bin/bash'):
    s = tty.Session(['interrupt command'], response=tty.command(
        '''sh -c 'stty -echo; echo ready > "$WRAP_HOME/child-ready"; exec sleep 20'; echo NOT_REACHED''', risk='low'),
        extra_env={'SHELL': shell})
    try:
        assert s.wait_screen(lambda: s.home_path('child-ready').exists(), 5), s.output[-3000:]
        s.send('\x03')
        assert s.wait_screen(lambda: s.process.poll() is not None, 5), s.output[-3000:]
        code = s.process.returncode
        assert code != 0, code
        entries = s.finish(code, alt=False)
        assert tty.final_turn(entries)[1]['exit_code'] == code
        assert b'NOT_REACHED\r\n' not in s.output
    finally:
        s.close()


def captured_child_keeps_tty_input(shell='/bin/bash'):
    step = '''sh -c 'modes=$(stty -g); stty sane; echo ready > "$WRAP_HOME/step-ready"; read -r answer; stty "$modes"; echo got-$answer' '''
    s = tty.Session(['interactive step'], responses=[
        tty.command(step, final=False), tty.command('echo done')],
        extra_env={'SHELL': shell}, piped_stdin=b'attached input\n',
        redirect_stdout=True)
    try:
        s.until('Run command?')
        s.send('y')
        assert s.wait_screen(lambda: s.home_path('step-ready').exists(), 5), s.output[-3000:]
        s.send('TTY_INPUT\n')
        s.until('got-TTY_INPUT')
        s.until('echo done')
        s.until('Run command?')
        s.send('n')
        entries = s.finish(0)
        steps = [turn for turn in entries[0]['turns'] if turn['kind'] == 'step']
        assert len(steps) == 1 and 'got-TTY_INPUT' in steps[0]['output'], steps
        assert s.stdout_file.read_bytes() == b''
    finally:
        s.close()


def captured_stderr_and_interrupt_are_preserved(shell):
    step = '''sh -c 'echo ready > "$WRAP_HOME/step-ready"; echo STEP_STDERR >&2; exec sleep 30'; echo NOT_REACHED'''
    s = tty.Session(['interrupt captured command'], responses=[
        tty.command(step, final=False), tty.command('echo AFTER_INTERRUPT')],
        extra_env={'SHELL': shell})
    try:
        s.until('Run command?')
        s.send('y')
        assert s.wait_screen(lambda: s.home_path('step-ready').exists(), 5)
        s.send('\x03')
        s.until('echo AFTER_INTERRUPT', timeout=5)
        s.send('n')
        entries = s.finish(0)
        steps = [turn for turn in entries[0]['turns'] if turn['kind'] == 'step']
        assert len(steps) == 1 and steps[0]['exit_code'] != 0, steps
        assert 'STEP_STDERR' in steps[0]['output'], steps
        assert 'NOT_REACHED' not in steps[0]['output'], steps
        assert 'no job control' not in steps[0]['output'], steps
    finally:
        s.close()


def explicit_interrupt_trap_is_preserved(shell):
    command = '''trap 'echo TRAPPED; exit 7' INT; sh -c 'echo ready > "$WRAP_HOME/child-ready"; exec sleep 30'; echo NOT_REACHED'''
    s = tty.Session(['command with interrupt trap'], response=tty.command(command, risk='low'),
                    extra_env={'SHELL': shell})
    try:
        assert s.wait_screen(lambda: s.home_path('child-ready').exists(), 5)
        s.send('\x03')
        entries = s.finish(7, alt=False, timeout=5)
        assert b'TRAPPED\r\n' in s.output, s.output[-1000:]
        assert b'NOT_REACHED\r\n' not in s.output
        assert tty.final_turn(entries)[1]['exit_code'] == 7
    finally:
        s.close()


def captured_startup_and_pipe_ownership(shell):
    with tempfile.TemporaryDirectory(prefix='wrap-shell-home-') as home:
        pathlib.Path(home, '.bashrc').write_text(
            'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$HOME/rc.pid"\n'
            "echo STARTUP_STDERR >&2\nalias wrap_test_alias='echo ALIAS_OUTPUT'\n")
        scratch = pathlib.Path(home, "scratch ' space")
        scratch.mkdir(mode=0o700)
        step = '''sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$WRAP_HOME/job.pid"; wrap_test_alias; echo COMMAND_STDERR >&2'''
        s = tty.Session(['capture with background child'], responses=[
            tty.command(step, risk='low', final=False), tty.reply('DONE')],
            extra_env={'SHELL': shell, 'HOME': home, 'TMPDIR': str(scratch)}, redirect_stdout=True)
        try:
            # A leaked capture descriptor in the background child would
            # keep the step's pipe open until its sleep finishes.
            entries = s.finish(0, alt=False, timeout=5)
            steps = [turn for turn in entries[0]['turns'] if turn['kind'] == 'step']
            assert len(steps) == 1 and steps[0]['exit_code'] == 0, steps
            assert 'ALIAS_OUTPUT' in steps[0]['output'], steps
            assert 'COMMAND_STDERR' in steps[0]['output'], steps
            assert 'STARTUP_STDERR' not in steps[0]['output'], steps
            assert b'STARTUP_STDERR' in s.output, s.output[-1000:]
            assert s.stdout_file.read_bytes() == b'DONE\n'
            assert not list(scratch.rglob('wrap-stderr-*')), 'capture FIFO leaked'
        finally:
            for path in [s.home_path('job.pid'), pathlib.Path(home, 'rc.pid')]:
                if path.exists():
                    try: os.kill(int(path.read_text()), signal.SIGKILL)
                    except ProcessLookupError: pass
            s.close()


def captured_startup_failure_and_cancel(shell):
    for cancel in [False, True]:
        with tempfile.TemporaryDirectory(prefix='wrap-shell-startup-') as home:
            startup = ("""sh -c 'echo $$ > "$WRAP_HOME/startup.pid"; exec sleep 30'"""
                       if cancel else 'exit 3')
            pathlib.Path(home, '.bashrc').write_text(startup + '\n')
            s = tty.Session(['startup never reaches command'], responses=[
                tty.command('echo NEVER_STARTED', risk='medium' if cancel else 'low', final=False),
                tty.reply('DONE')], extra_env={'SHELL': shell, 'HOME': home})
            try:
                if cancel:
                    s.until('Run command?')
                    s.send('y')
                    assert s.wait_screen(lambda: s.home_path('startup.pid').exists(), 5)
                    pid = int(s.home_path('startup.pid').read_text())
                    pipes = list(pathlib.Path(s.tmp.name).rglob('wrap-stderr-*'))
                    assert len(pipes) == 1 and stat.S_IMODE(pipes[0].stat().st_mode) == 0o600, pipes
                    os.kill(s.pid(), signal.SIGINT)
                    s.until('Run command?')
                    assert s.wait_screen(lambda: not live(pid), 3), 'startup child survived cancel'
                    s.send('n')
                entries = s.finish(0, alt=cancel, timeout=5)
                assert not list(pathlib.Path(s.tmp.name).rglob('wrap-stderr-*')), 'capture FIFO leaked'
                steps = [turn for turn in entries[0]['turns'] if turn['kind'] == 'step']
                if cancel:
                    assert not steps, steps
                else:
                    assert len(steps) == 1 and steps[0]['exit_code'] == 3, steps
                    assert 'NEVER_STARTED' not in steps[0]['output'], steps
            finally:
                s.close()


def captured_spawn_failure_cleans_pipe():
    with tempfile.TemporaryDirectory(prefix='wrap-missing-shell-') as home:
        s = tty.Session(['missing shell'], responses=[
            tty.command('echo NEVER_STARTED', risk='low', final=False), tty.reply('unused')],
            extra_env={'SHELL': str(pathlib.Path(home, 'bash'))})
        try:
            s.finish(1, alt=False, timeout=5)
            assert not list(pathlib.Path(s.tmp.name).rglob('wrap-stderr-*')), 'capture FIFO leaked'
        finally:
            s.close()


def live(pid):
    if pathlib.Path('/proc').is_dir():
        try:
            state = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
        except FileNotFoundError:
            return False
        return state != 'Z'
    result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)],
                            capture_output=True, text=True)
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')


def cancel_compound_step_ends_descendants(shell):
    sibling = 'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$WRAP_HOME/sibling.pid"'
    step = """sh -c 'echo $$ > "$WRAP_HOME/job.pid"; exec sleep 30'; echo AFTER > "$WRAP_HOME/after" """
    s = tty.Session(['cancel compound step'], responses=[
        tty.command(sibling, risk='low', final=False),
        tty.command(step, final=False), tty.reply('unused')],
        extra_env={'SHELL': shell})
    pids = []
    try:
        s.until('Run command?')
        sibling_pid = int(s.home_path('sibling.pid').read_text())
        pids.append(sibling_pid)
        s.send('y')
        assert s.wait_screen(lambda: s.home_path('job.pid').exists(), 5)
        job = int(s.home_path('job.pid').read_text())
        pids.append(job)
        s.pump_for(.2)
        if tty.foreground_of(s.pid()) == s.pid():
            assert os.getpgid(sibling_pid) == s.pid(), 'sibling must share Wrap group'
            s.send('\x1b')
        else:
            # Bash owns input; a signal reaches the dialog's cancel path.
            os.kill(s.pid(), signal.SIGINT)
        s.until('Run command?', timeout=5)
        assert s.wait_screen(lambda: not live(job), 2), f'{shell}: descendant survived cancel'
        assert live(sibling_pid), f'{shell}: unrelated sibling was killed'
        assert not s.home_path('after').exists(), 'shell advanced after cancellation'
        s.send('n')
        entries = s.finish(0)
        assert entries[-1]['outcome'] == 'cancelled', entries
    finally:
        for pid in pids:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        s.close()


def captured_step_restores_dialog_modes(shell, cancel=False):
    step = ('stty sane; echo ready > "$WRAP_HOME/step-ready"; sleep 30; echo AFTER'
            if cancel else 'stty sane; echo STEP')
    s = tty.Session(['step changes modes'], responses=[
        tty.command(step, final=False),
        tty.command('echo AFTER_MODES')], extra_env={'SHELL': shell})
    try:
        s.until('Run command?')
        s.send('y')
        if cancel:
            assert s.wait_screen(lambda: s.home_path('step-ready').exists(), 5)
            s.pump_for(.2)
            os.kill(s.pid(), signal.SIGINT)
            s.until('Run command?')
        else:
            s.until('echo AFTER_MODES')
        assert s.wait_screen(lambda: not termios.tcgetattr(s.slave)[3] &
                             (termios.ICANON | termios.ECHO), 2), f'{shell}: dialog modes leaked'
        s.send('n')
        s.finish(0, timeout=3)
    finally:
        s.close()


def inline_step_restores_terminal_modes(shell):
    s = tty.Session(['inline step changes modes'], responses=[
        tty.command('stty -echo; echo STEP', risk='low', final=False),
        tty.reply('FINISHED')], extra_env={'SHELL': shell})
    try:
        s.finish(0, alt=False)
    finally:
        s.close()


if __name__ == '__main__':
    tty.run('final child restores terminal modes', final_child_restores_terminal_modes)
    tty.run('failed final child restores terminal modes', failed_final_child_restores_terminal_modes)
    tty.run('interrupted final child restores terminal modes', interrupted_final_child_restores_terminal_modes)
    tty.run('captured child keeps tty input', captured_child_keeps_tty_input)
    tty.run('captured stderr and interrupt are preserved', lambda: captured_stderr_and_interrupt_are_preserved('/bin/bash'))
    tty.run('explicit interrupt trap is preserved', lambda: explicit_interrupt_trap_is_preserved('/bin/bash'))
    tty.run('captured startup and pipe ownership', lambda: captured_startup_and_pipe_ownership('/bin/bash'))
    tty.run('captured startup failure and cancel', lambda: captured_startup_failure_and_cancel('/bin/bash'))
    tty.run('captured spawn failure cleans pipe', captured_spawn_failure_cleans_pipe)
    for name in ['sh', 'bash', 'zsh']:
        shell = shutil.which(name)
        if not shell:
            print(f'SKIP {name} unavailable')
            continue
        tty.run(f'{name} compound cancel reaps descendants', lambda: cancel_compound_step_ends_descendants(shell))
        tty.run(f'{name} captured step restores dialog modes', lambda: captured_step_restores_dialog_modes(shell))
        tty.run(f'{name} cancelled step restores dialog modes', lambda: captured_step_restores_dialog_modes(shell, cancel=True))
        tty.run(f'{name} inline step restores terminal modes', lambda: inline_step_restores_terminal_modes(shell))
    if bash := os.environ.get('WRAP_TEST_BASH'):
        with tempfile.TemporaryDirectory(prefix='wrap-test-bash-') as directory:
            shell = pathlib.Path(directory) / 'bash'
            shell.write_text(f'#!/bin/sh\nexec {shlex.quote(bash)} --noprofile --norc "$@"\n')
            shell.chmod(0o700)
            for test in [interrupted_final_child_restores_terminal_modes,
                         captured_child_keeps_tty_input,
                         captured_stderr_and_interrupt_are_preserved,
                         explicit_interrupt_trap_is_preserved,
                         cancel_compound_step_ends_descendants,
                         captured_step_restores_dialog_modes,
                         inline_step_restores_terminal_modes]:
                tty.run(f'{bash}: {test.__name__}', lambda: test(str(shell)))
            tty.run(f'{bash}: cancelled step restores dialog modes', lambda: captured_step_restores_dialog_modes(str(shell), cancel=True))
            tty.run(f'{bash}: startup and pipe ownership', lambda: captured_startup_and_pipe_ownership(bash))
            tty.run(f'{bash}: startup failure and cancel', lambda: captured_startup_failure_and_cancel(bash))
    tty.server.shutdown()
    if tty.FAILED:
        raise SystemExit(1)
