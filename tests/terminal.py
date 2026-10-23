#!/usr/bin/env python3
"""Real-terminal contracts; stdlib only. Runs with a disposable home and local HTTP."""
import ast, codecs, fcntl, http.server, json, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, threading, time, unicodedata

BINARY = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/debug/wrap').resolve())

def _model(date): return {'tool_call': True, 'modalities': {'input': ['text'], 'output': ['text']}, 'release_date': date}
# Sonnet is dated oldest so the recommended row is visibly moved to the top.
CATALOG = {'anthropic': {'models': {'claude-opus-4-1': _model('2025-08-05'), 'claude-sonnet-4-6': _model('2025-05-01'), 'claude-haiku-4-5': _model('2025-10-15')}},
           'openai': {'models': {'gpt-5': _model('2025-08-07')}}, 'ollama': {'models': {'llama3': _model('2024-04-18')}}}

class Server(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/models.json':
            body = json.dumps(CATALOG).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_error(404)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}'
UNROUTABLE = 'http://127.0.0.1:1/'

MEMORY_SEED = {'/': [{'fact': 'Linux'}]}
SCRUB = ('WRAP_CONFIG', 'WRAP_TEST_RESPONSE', 'WRAP_TEST_RESPONSES', 'WRAP_HOME', 'WRAP_THEME', 'WRAP_NO_ANIMATION', 'WRAP_VERBOSE', 'WRAP_YOLO',
         'WRAP_MODEL', 'WRAP_TEMP_DIR', 'WRAP_MODELS_URL', 'WRAP_NERD_FONTS', 'WRAP_CONTINUE', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'VISUAL', 'EDITOR', 'TMPDIR')

def command(content, risk='medium', final=True, explanation=None, plan=None):
    response = {'type': 'command', 'content': content, 'risk_level': risk, 'final': final, '_scratchpad': 'thinking'}
    if explanation is not None: response['explanation'] = explanation
    if plan is not None: response['plan'] = plan
    return response
def reply(content): return {'type': 'reply', 'content': content, 'risk_level': 'low'}

ESCAPE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[^\[\]()]|\x1b\[[0-?]*[ -/]*$|\x1b\][^\x07\x1b]*$|\x1b$|[^\x1b]')

class Screen:
    """Enough of a VT emulator to read back what Ratatui painted: a main and an
    alternate grid, absolute/relative cursor moves, erases, wide glyphs."""
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.main = self.blank(); self.alt = self.blank(); self.grid = self.main
        self.row = self.col = 0
        self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace'); self.pending = ''
    def blank(self): return [[' '] * self.width for _ in range(self.height)]
    def resize(self, width, height):
        def fit(grid): return [(row + [' '] * width)[:width] for row in (grid + [[' '] * width for _ in range(height)])[:height]]
        self.main, self.alt = fit(self.main), fit(self.alt); self.grid = self.alt if self.grid is not self.main else self.main
        self.width, self.height = width, height; self.row = min(self.row, height - 1); self.col = min(self.col, width - 1)
    def text(self): return '\n'.join(''.join(row).rstrip() for row in self.grid)
    def feed(self, data):
        text = self.pending + self.decoder.decode(data); self.pending = ''
        for token in ESCAPE.findall(text):
            if token.startswith('\x1b'):
                if token in ('\x1b', '\x1b[', '\x1b]') or token[-1] not in '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\x07' or (token.startswith('\x1b[') and len(token) > 2 and token[-1] in '0123456789;?'):
                    self.pending = token; continue
                if token.startswith('\x1b['): self.csi(token)
            elif token == '\r': self.col = 0
            elif token == '\n': self.linefeed()
            elif token == '\b': self.col = max(0, self.col - 1)
            elif token == '\t': self.col = min(self.width - 1, (self.col // 8 + 1) * 8)
            elif token >= ' ': self.put(token)
    def linefeed(self):
        if self.row + 1 >= self.height: self.grid.append([' '] * self.width); del self.grid[0]
        else: self.row += 1
    def put(self, ch):
        if unicodedata.combining(ch) or unicodedata.category(ch) in ('Mn', 'Me', 'Cf'): return
        width = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
        if self.col + width > self.width: self.col = 0; self.linefeed()
        self.grid[self.row][self.col] = ch
        if width == 2 and self.col + 1 < self.width: self.grid[self.row][self.col + 1] = ''
        self.col += width
    def csi(self, token):
        final = token[-1]; body = token[2:-1]; private = body.startswith('?')
        params = [int(p) if p.isdigit() else 0 for p in body.lstrip('?>=<').split(';')] if body.lstrip('?>=<') else []
        n = params[0] if params and params[0] else 1
        if final in 'Hf':
            row = (params[0] if params and params[0] else 1) - 1; col = (params[1] if len(params) > 1 and params[1] else 1) - 1
            self.row = min(max(row, 0), self.height - 1); self.col = min(max(col, 0), self.width - 1)
        elif final == 'A': self.row = max(0, self.row - n)
        elif final == 'B': self.row = min(self.height - 1, self.row + n)
        elif final == 'C': self.col = min(self.width - 1, self.col + n)
        elif final == 'D': self.col = max(0, self.col - n)
        elif final == 'G': self.col = min(max(n - 1, 0), self.width - 1)
        elif final == 'd': self.row = min(max(n - 1, 0), self.height - 1)
        elif final == 'J':
            mode = params[0] if params else 0
            if mode in (2, 3): self.grid[:] = self.blank()
            elif mode == 0:
                self.grid[self.row][self.col:] = [' '] * (self.width - self.col)
                for r in range(self.row + 1, self.height): self.grid[r] = [' '] * self.width
            elif mode == 1:
                self.grid[self.row][:self.col + 1] = [' '] * (self.col + 1)
                for r in range(self.row): self.grid[r] = [' '] * self.width
        elif final == 'K':
            mode = params[0] if params else 0
            if mode == 0: self.grid[self.row][self.col:] = [' '] * (self.width - self.col)
            elif mode == 1: self.grid[self.row][:self.col + 1] = [' '] * (self.col + 1)
            else: self.grid[self.row] = [' '] * self.width
        elif final in 'hl' and private and params and params[0] in (47, 1047, 1049):
            if final == 'h': self.alt = self.blank(); self.grid = self.alt
            else: self.grid = self.main
            self.row = self.col = 0

class Session:
    def __init__(self, args=(), responses=None, response=None, config=None, extra_env=None, piped_stdin=None, redirect_stdout=False,
                 wizard=False, memory=True, size=(100, 32)):
        self.home = tempfile.TemporaryDirectory(prefix='wrap-pty-')
        self.tmp = tempfile.TemporaryDirectory(prefix='wrap-pty-tmp-')
        if memory: self.home_path('memory.json').write_text(json.dumps(MEMORY_SEED))
        self.master, self.slave = pty.openpty()
        self.initial = termios.tcgetattr(self.slave)
        self.screen = Screen(*size); self.output = b''
        self.resize(*size)
        env = {k: v for k, v in os.environ.items() if k not in SCRUB}
        env.update(WRAP_HOME=self.home.name, WRAP_THEME='dark', TERM='xterm-256color', COLORTERM='truecolor', TMPDIR=self.tmp.name, SHELL='/bin/sh')
        if not wizard: env['WRAP_CONFIG'] = json.dumps(config if config is not None else {})
        elif config is not None: env['WRAP_CONFIG'] = json.dumps(config)
        if responses is not None: env['WRAP_TEST_RESPONSES'] = json.dumps(responses)
        if response is not None: env['WRAP_TEST_RESPONSE'] = json.dumps(response)
        env.update(extra_env or {})
        self.stdout_file = self.home_path('stdout.txt')
        self.termios_result = self.home_path('terminal-state.txt')
        stdin_arg = 'subprocess.PIPE' if piped_stdin is not None else 'None'
        stdout_arg = f'open({str(self.stdout_file)!r},"wb")' if redirect_stdout else 'None'
        feed = f'p.stdin.write({piped_stdin!r}); p.stdin.close(); ' if piped_stdin is not None else ''
        # The wrapper stands in for the user's shell: it owns the terminal, survives a
        # keyboard Ctrl+C aimed at the foreground job, and records the terminal state
        # wrap leaves behind. Its handler (not SIG_IGN) resets to default across exec.
        wrapper = ('import subprocess,termios,fcntl,sys,os,signal; fcntl.ioctl(0,termios.TIOCSCTTY,0); signal.signal(signal.SIGINT,lambda *a:None); '
                   f'p=subprocess.Popen(sys.argv[2:],stdin={stdin_arg},stdout={stdout_arg}); '
                   'open(sys.argv[1]+".pid","w").write(str(p.pid)); ' + feed +
                   'p.wait(); open(sys.argv[1]+".foreground","w").write(str(os.tcgetpgrp(0))); '
                   'open(sys.argv[1],"w").write(repr(termios.tcgetattr(0))); sys.exit(p.returncode)')
        self.process = subprocess.Popen([sys.executable, '-c', wrapper, str(self.termios_result), BINARY, *args],
                                        stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env, start_new_session=True)
    def home_path(self, name): return pathlib.Path(self.home.name) / name
    def pid(self):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try: return int(pathlib.Path(str(self.termios_result) + '.pid').read_text())
            except (FileNotFoundError, ValueError): time.sleep(.01)
        raise AssertionError('wrap never started')
    def resize(self, w, h):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', h, w, 0, 0)); self.screen.resize(w, h)
        if hasattr(self, 'process'): os.killpg(self.process.pid, signal.SIGWINCH)
    def pump(self, timeout=.1):
        if select.select([self.master], [], [], timeout)[0]:
            try: data = os.read(self.master, 65536)
            except OSError: return
            self.output += data; self.screen.feed(data)
    def pump_for(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end: self.pump(.02)
    def visible(self):
        # Ratatui skips blank cells with cursor movements, so compare without whitespace.
        return re.sub(r'\s+', '', self.screen.text())
    def wait_screen(self, predicate, timeout):
        end = time.monotonic() + timeout
        while not predicate() and time.monotonic() < end:
            self.pump()
            if self.process.poll() is not None:
                for _ in range(3): self.pump(.05)
                break
        return predicate()
    def until(self, needle, timeout=8):
        wanted = re.sub(r'\s+', '', needle)
        assert self.wait_screen(lambda: wanted in self.visible(), timeout), (needle, self.screen.text(), self.output[-3000:])
    def until_gone(self, needle, timeout=8):
        wanted = re.sub(r'\s+', '', needle)
        assert self.wait_screen(lambda: wanted not in self.visible(), timeout), (needle, self.screen.text())
    def absent(self, needle): assert re.sub(r'\s+', '', needle) not in self.visible(), (needle, self.screen.text())
    def until_output(self, needle, timeout=8):
        assert self.wait_screen(lambda: needle in self.output, timeout), (needle, self.output[-3000:])
    def send(self, text): os.write(self.master, text.encode())
    def log(self):
        path = self.home_path('logs/wrap.jsonl')
        if not path.exists(): return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    def finish(self, code, alt=True, timeout=10):
        end = time.monotonic() + timeout
        while self.process.poll() is None and time.monotonic() < end: self.pump()
        if self.process.poll() is None: raise AssertionError(('terminal stalled', self.screen.text(), self.output[-3000:]))
        for _ in range(3): self.pump(.02)
        assert self.process.returncode == code, (self.process.returncode, self.output[-6000:])
        assert int(pathlib.Path(str(self.termios_result) + '.foreground').read_text()) == self.process.pid, 'terminal foreground group not restored'
        restored = ast.literal_eval(self.termios_result.read_text())
        # macOS sets kernel-owned PENDIN when canonical mode resumes.
        expected = self.initial.copy(); expected[3] &= ~getattr(termios, 'PENDIN', 0); restored[3] &= ~getattr(termios, 'PENDIN', 0)
        assert restored == expected, ('terminal attributes not restored', expected, restored)
        if alt:
            assert b'\x1b[?1049h' in self.output, 'dialog never opened the alternate screen'
            assert b'\x1b[?1049l' in self.output, 'alternate screen not restored'
            assert self.output.rfind(b'\x1b[?1049l') > self.output.rfind(b'\x1b[?1049h'), 'alternate screen still active'
            assert self.output.rfind(b'\x1b[?2004l') > self.output.rfind(b'\x1b[?2004h'), 'bracketed paste still enabled'
        if b'\x1b[?25l' in self.output:
            assert self.output.rfind(b'\x1b[?25h') > self.output.rfind(b'\x1b[?25l'), 'cursor left hidden'
        if b'\x1b[>1u' in self.output:
            assert max(self.output.rfind(b'\x1b[<1u'), self.output.rfind(b'\x1b[<u')) > self.output.rfind(b'\x1b[>1u'), 'kitty keyboard flags left pushed'
        os.close(self.master); os.close(self.slave)
        return self.log()
    def close(self):
        try:
            foreground = os.tcgetpgrp(self.slave)
            if foreground > 0 and foreground != self.process.pid: os.killpg(foreground, signal.SIGKILL)
        except OSError: pass
        try: os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: self.process.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
        for fd in (self.master, self.slave):
            try: os.close(fd)
            except OSError: pass
        self.home.cleanup(); self.tmp.cleanup()

def kinds_of(entry): return [t['kind'] for t in entry['turns'] if t['kind'] != 'probe']

def final_turn(entries):
    assert len(entries) == 1, entries
    turns = entries[0]['turns']
    assert turns[-1]['kind'] == 'final', turns
    return entries[0], turns[-1]

ONLY = sys.argv[2] if len(sys.argv) > 2 else ''
FAILED = []
def run(name, fn):
    if ONLY not in name: return
    try: fn(); print('PASS', name, flush=True)
    except Exception as e:
        FAILED.append(name); print('FAIL', name, flush=True)
        import traceback; traceback.print_exc()

RIGHT, LEFT, DOWN = '\x1b[C', '\x1b[D', '\x1b[B'

# --- Confirmation dialog -------------------------------------------------------
def medium_confirm_runs():
    s = Session(['make it so'], response=command('echo RAN_MEDIUM; exit 3', explanation='Prints a marker and fails.'))
    try:
        s.until('medium risk'); s.until('echo RAN_MEDIUM; exit 3'); s.until('Prints a marker and fails.'); s.until('Run command?')
        assert b'RAN_MEDIUM\r\n' not in s.output
        s.send('y'); entries = s.finish(3)
        assert s.output.index(b'\x1b[?1049l') < s.output.index(b'RAN_MEDIUM\r\n'), 'command output landed in the alternate screen'
        entry, final = final_turn(entries)
        assert (final['command'], final['exit_code'], final['source']) == ('echo RAN_MEDIUM; exit 3', 3, 'model'), final
        assert entry['outcome'] == 'error' and entry['input_source'] == 'argv', entry
    finally: s.close()

def cancel_key(key):
    s = Session(['make it so'], response=command('echo NEVER_RUNS'))
    try:
        s.until('Run command?'); s.send(key); entries = s.finish(0)
        assert b'NEVER_RUNS\r\n' not in s.output
        entry, final = final_turn(entries)
        assert (final['command'], final['exit_code'], final['source']) == ('echo NEVER_RUNS', None, 'cancelled'), final
        assert entry['outcome'] == 'cancelled', entry
    finally: s.close()

def arrow_select_yes():
    s = Session(['make it so'], response=command('echo ARROW_YES'))
    try:
        s.until('Run command?'); s.send(RIGHT); s.send('\r'); entries = s.finish(0)
        assert b'ARROW_YES\r\n' in s.output
        assert final_turn(entries)[1]['source'] == 'model'
    finally: s.close()

def arrow_clamp_no_wraparound():
    # Left from the first item stays on No; Right past the last item stays there (not Yes).
    s = Session(['make it so'], response=command('echo CLAMPED'), extra_env={'PATH': '/nonexistent'})
    try:
        s.until('Run command?'); s.send(LEFT * 3); s.send('\r'); entries = s.finish(0)
        assert b'CLAMPED\r\n' not in s.output and final_turn(entries)[1]['source'] == 'cancelled'
    finally: s.close()
    s = Session(['make it so'], response=command('echo CLAMPED'), extra_env={'PATH': '/nonexistent'})
    try:
        s.until('Run command?'); s.send(RIGHT * 12); s.send('\r')
        # The last item is Follow-up (no clipboard tool on an empty PATH): the composer opens.
        s.until('actually...'); s.send('\x1b'); s.until_gone('actually...'); s.until('Run command?'); s.send('n'); entries = s.finish(0)
        assert b'CLAMPED\r\n' not in s.output and final_turn(entries)[1]['source'] == 'cancelled'
    finally: s.close()

# --- High risk and editing -----------------------------------------------------
def high_risk_edit_runs_override():
    s = Session(['do the risky thing'], response=command('echo ORIGINAL', 'high'))
    try:
        s.until('high risk'); s.until('Run command?'); s.send('e'); s.until('to run'); s.until('to discard changes')
        s.send('_EDITED'); s.until('echo ORIGINAL_EDITED'); s.send('\r'); entries = s.finish(0)
        assert b'ORIGINAL_EDITED\r\n' in s.output and s.output.index(b'\x1b[?1049l') < s.output.index(b'ORIGINAL_EDITED\r\n')
        entry, final = final_turn(entries)
        assert (final['command'], final['exit_code'], final['source']) == ('echo ORIGINAL_EDITED', 0, 'user_override'), final
        assert entry['outcome'] == 'success'
    finally: s.close()

def edit_esc_restores_original():
    s = Session(['do the risky thing'], response=command('echo ORIGINAL', 'high'))
    try:
        s.until('Run command?'); s.send('e'); s.until('to discard changes'); s.send(' && echo MORE'); s.until('echo ORIGINAL && echo MORE')
        s.send('\x1b'); s.until_gone('echo MORE'); s.until('Run command?'); s.until('high risk'); s.until('echo ORIGINAL')
        s.send('y'); entries = s.finish(0)
        assert b'ORIGINAL\r\n' in s.output and b'MORE\r\n' not in s.output
        assert final_turn(entries)[1]['command'] == 'echo ORIGINAL'
    finally: s.close()

# --- Follow-up -----------------------------------------------------------------
def followup_replaces_command():
    # The second round is a slow inline step so the processing state is observable.
    responses = [command('echo FIRST'), command('sleep 1; echo STEP_DONE', 'low', final=False, explanation='Checking something slow'), command('echo SECOND')]
    s = Session(['first attempt'], responses=responses)
    try:
        s.until('echo FIRST'); s.until('Run command?'); s.send('f'); s.until('actually...'); s.until('to send')
        s.send('make it second'); s.until('make it second'); s.send('\r')
        s.until('to abort')
        # The bottom border carries the spinner status: the fallback until the step's chrome line lands.
        assert s.wait_screen(lambda: 'Reticulatingsplines...' in s.visible() or 'Checkingsomethingslow' in s.visible(), 5), s.screen.text()
        s.until('echo SECOND', timeout=12); s.until('Run command?'); s.until('Output:'); s.until('STEP_DONE'); s.until_gone('echo FIRST')
        s.send('y'); entries = s.finish(0)
        assert b'SECOND\r\n' in s.output
        entry, final = final_turn(entries)
        assert final['command'] == 'echo SECOND'
        assert kinds_of(entry) == ['user', 'assistant', 'user', 'assistant', 'step', 'assistant', 'final'], kinds_of(entry)
        assert [t for t in entry['turns'] if t['kind'] == 'user'][1]['text'] == 'make it second'
    finally: s.close()

def followup_esc_keeps_draft():
    responses = [command('echo FIRST'), command('sleep 2; echo SLOW_STEP_OUTPUT', 'low', final=False, explanation='A slow step'), command('echo SECOND')]
    s = Session(['first attempt'], responses=responses)
    try:
        s.until('Run command?'); s.send('f'); s.until('actually...'); s.send('keep this draft'); s.until('keep this draft')
        s.send('\r'); s.until('to abort')
        s.send('\x1b'); s.until('to send'); s.until('keep this draft'); s.absent('to abort')
        s.send('\x1b'); s.until_gone('keep this draft'); s.until('Run command?'); s.send('n'); entries = s.finish(0)
        # The aborted step's chrome line flushes to scrollback on teardown; its output never does.
        assert b'A slow step\r\n' in s.output and b'SLOW_STEP_OUTPUT\r\n' not in s.output, s.output[-2000:]
        entry, final = final_turn(entries)
        assert final['source'] == 'cancelled' and final['command'] == 'echo FIRST', final
        assert kinds_of(entry) == ['user', 'assistant', 'user', 'assistant', 'final'], kinds_of(entry)
    finally: s.close()

# --- Interactive composer ------------------------------------------------------
PLACEHOLDERS = ['list all markdown files here', 'delete all .DS_Store files in this project', 'add .env to git ignore']
def has_placeholder(s): return any(re.sub(r'\s+', '', p) in s.visible() for p in PLACEHOLDERS)
def interactive_compose_submits():
    s = Session([], response=command('echo FROM_TUI'))
    try:
        s.until('compose'); s.until('send')
        assert s.wait_screen(lambda: has_placeholder(s), 3), s.screen.text()
        s.send('first line'); s.until('first line'); assert not has_placeholder(s), s.screen.text()
        s.send('\n'); s.send('second line'); s.until('second line')
        assert s.wait_screen(lambda: s.screen.text().find('first line') < s.screen.text().find('second line') and
                             s.screen.text()[s.screen.text().find('first line'):s.screen.text().find('second line')].count('\n') == 1, 2), s.screen.text()
        s.send('\r'); s.until('echo FROM_TUI'); s.until('Run command?')
        s.send('y'); entries = s.finish(0)
        assert b'FROM_TUI\r\n' in s.output
        entry, final = final_turn(entries)
        assert entry['input_source'] == 'tui', entry['input_source']
        user = [t for t in entry['turns'] if t['kind'] == 'user'][0]
        assert user['text'] == 'first line\nsecond line', user
    finally: s.close()

def interactive_esc_cancels():
    s = Session([], response=command('echo FROM_TUI'))
    try:
        s.until('compose'); s.send('\x1b'); entries = s.finish(0)
        assert b'FROM_TUI\r\n' not in s.output
        entry, final = final_turn(entries)
        assert final['source'] == 'cancelled' and entry['outcome'] == 'cancelled', entry
    finally: s.close()

# --- Multi-step ------------------------------------------------------------------
def low_step_runs_before_dialog():
    responses = [command('echo STEP_OUTPUT_1', 'low', final=False, explanation='Looking around'), command('echo FINAL_CMD', explanation='Finishing up')]
    s = Session(['do it in two steps'], responses=responses)
    try:
        s.until('echo FINAL_CMD'); s.until('Run command?')
        assert b'Looking around' in s.output and s.output.index(b'Looking around') < s.output.index(b'\x1b[?1049h'), 'step chrome should precede the dialog'
        s.send('y'); entries = s.finish(0)
        assert b'FINAL_CMD\r\n' in s.output
        entry, final = final_turn(entries)
        assert kinds_of(entry) == ['user', 'assistant', 'step', 'assistant', 'final'], kinds_of(entry)
        step = [t for t in entry['turns'] if t['kind'] == 'step'][0]
        assert step['output'].strip() == 'STEP_OUTPUT_1' and step['exit_code'] == 0 and step['source'] == 'model', step
    finally: s.close()

def confirmed_medium_step_shows_running():
    responses = [command('sleep 1; echo SLOW_STEP', final=False, explanation='A slow medium step'), command('echo AFTER_STEP')]
    s = Session(['two confirmations'], responses=responses)
    try:
        s.until('sleep 1; echo SLOW_STEP'); s.until('Run command?'); s.send('y')
        s.until('Running step...'); s.until('to abort step')
        s.until('echo AFTER_STEP', timeout=12); s.until('Output:'); s.until('SLOW_STEP'); s.until('Run command?')
        s.send('n'); entries = s.finish(0)
        assert b'AFTER_STEP\r\n' not in s.output
        entry, final = final_turn(entries)
        assert kinds_of(entry) == ['user', 'assistant', 'step', 'assistant', 'final'], kinds_of(entry)
        step = [t for t in entry['turns'] if t['kind'] == 'step'][0]
        assert step['source'] == 'model' and step['output'].strip() == 'SLOW_STEP' and final['source'] == 'cancelled'
    finally: s.close()

# --- Resize ----------------------------------------------------------------------
def resize_folds_and_restores():
    # 52-column lines: one row each at 100 columns, two rows each (28 > the 25-row budget) at 50.
    lines = [f'echo line{i:02d} ' + 'x' * 40 for i in range(14)]
    s = Session(['long one'], response=command('\n'.join(lines)))
    try:
        s.until('Run command?'); s.until('line13'); s.absent('lines hidden')
        s.resize(50, 32); s.until('lines hidden'); s.until('Run command?')
        s.resize(100, 32); s.until_gone('lines hidden'); s.until('line13'); s.until('Run command?')
        s.send('n'); assert final_turn(s.finish(0))[1]['source'] == 'cancelled'
    finally: s.close()

# --- Input hygiene ---------------------------------------------------------------
def early_keystroke_does_not_confirm():
    responses = [command('sleep 1', 'low', final=False), command('echo PREMATURE')]
    s = Session(['slow start'], responses=responses)
    try:
        s.send('y'); s.until('Run command?', timeout=12); s.pump_for(.5)
        assert s.process.poll() is None and b'PREMATURE\r\n' not in s.output, s.output[-3000:]
        s.send('n'); assert final_turn(s.finish(0))[1]['source'] == 'cancelled'
    finally: s.close()

# --- Handoff ---------------------------------------------------------------------
def tty_handoff():
    s = Session(['ask me'], response=command("printf 'ANSWER? ' >/dev/tty; read a </dev/tty; echo got-$a"))
    try:
        s.until('Run command?'); s.send('y')
        assert s.wait_screen(lambda: b'\x1b[?1049l' in s.output and b'ANSWER? ' in s.output[s.output.rfind(b'\x1b[?1049l'):], 8), s.output[-3000:]
        s.send('hello\r'); entries = s.finish(0)
        assert b'got-hello' in s.output and final_turn(entries)[1]['exit_code'] == 0
    finally: s.close()

def child_alt_screen_leaves_terminal_sane():
    s = Session(['fullscreen'], response=command("printf '\\033[?1049h'; sleep 0.2; printf '\\033[?1049l'; echo SANE"))
    try:
        s.until('Run command?'); s.send('y'); entries = s.finish(0)
        assert b'SANE\r\n' in s.output and s.output.count(b'\x1b[?1049h') == 2 and s.output.count(b'\x1b[?1049l') == 2
    finally: s.close()

# --- Signals ---------------------------------------------------------------------
def signal_during_dialog(sig, extra_env=None):
    # A graceful cancel (log entry, terminal restored) that still exits 128+signal for wrappers and CI.
    s = Session(['wait for me'], response=command('echo NEVER'), extra_env=extra_env)
    try:
        s.until('Run command?'); os.kill(s.pid(), sig); entries = s.finish(128 + int(sig))
        assert b'NEVER\r\n' not in s.output
        entry, final = final_turn(entries)
        assert final['source'] == 'cancelled' and entry['outcome'] == 'cancelled', entry
    finally: s.close()

def signal_during_composer(sig):
    # No spinner ran before this dialog, so it is the first thing to touch the signal handlers.
    s = Session([], response=command('echo NEVER'))
    try:
        s.until('compose'); os.kill(s.pid(), sig); entries = s.finish(128 + int(sig))
        assert b'NEVER\r\n' not in s.output
        entry, final = final_turn(entries)
        assert final['source'] == 'cancelled' and entry['outcome'] == 'cancelled', entry
    finally: s.close()

def signal_during_wizard_welcome(sig):
    s = Wizard(['hello'])
    try:
        s.until('~45 seconds.'); os.kill(s.pid(), sig); s.finish(128 + int(sig))
        assert not s.home_path('config.jsonc').exists() and not s.home_path('config.schema.json').exists()
        assert not s.home_path('logs').exists()
    finally: s.close()

def signal_during_forget(sig):
    s = Session(['--forget'])
    try:
        seed_forget(s); s.until('Temp files'); os.kill(s.pid(), sig); s.finish(128 + int(sig))
        assert b'Forgotten.' not in s.output
        for name in ('memory.json', 'logs/wrap.jsonl', 'cache/appearance.json'): assert s.home_path(name).exists(), name
    finally: s.close()

def keyboard_interrupt_kills_child():
    # An interactive dash returns to its prompt after SIGINT instead of exiting, so this
    # scenario runs under bash, the shell whose semantics users actually see. The marker is
    # printed by the foreground job itself, so Ctrl+C can only arrive once that job owns the
    # terminal; a keystroke between jobs would be deferred by bash until the sleep finished.
    s = Session(['long running'], response=command("sh -c 'echo STARTED; exec sleep 5'; echo NOT_REACHED"), extra_env={'SHELL': '/bin/bash'})
    try:
        s.until('Run command?'); s.send('y')
        assert s.wait_screen(lambda: b'STARTED\r\n' in s.output, 5)
        started = time.monotonic(); s.send('\x03')
        end = started + 8
        while s.process.poll() is None and time.monotonic() < end: s.pump()
        assert s.process.poll() is not None, ('wrap did not exit after Ctrl+C', s.output[-3000:])
        assert time.monotonic() - started < 4, ('Ctrl+C did not interrupt the child; it ran to completion', s.output[-500:])
        assert b'NOT_REACHED\r\n' not in s.output, s.output[-500:]
        code = s.process.returncode
        assert code != 0, code
        entries = s.finish(code)
        entry, final = final_turn(entries)
        assert final['exit_code'] == code and final['source'] == 'model' and entry['outcome'] == 'error', entry
    finally: s.close()

# --- Streams ---------------------------------------------------------------------
def piped_stdin_with_tty():
    s = Session(['count the lines'], response=command('echo PIPED_OK'), piped_stdin=b'x\ny\n')
    try:
        s.until('Run command?'); s.send('y'); entries = s.finish(0)
        assert b'PIPED_OK\r\n' in s.output
        entry, final = final_turn(entries)
        assert entry['attached_input']['size'] == 4, entry['attached_input']
    finally: s.close()

def redirected_stdout():
    s = Session(['write it'], response=command('echo TO_FILE'), redirect_stdout=True)
    try:
        s.until('medium risk'); s.until('Run command?'); s.send('y'); s.finish(0)
        assert s.stdout_file.read_bytes() == b'TO_FILE\n', s.stdout_file.read_bytes()
        assert b'TO_FILE\r\n' not in s.output
    finally: s.close()

def redirected_answer():
    s = Session(['what is the answer'], response=reply('forty-two'), redirect_stdout=True)
    try:
        s.finish(0, alt=False)
        assert s.stdout_file.read_bytes() == b'forty-two\n' and b'forty-two' not in s.output
    finally: s.close()

# --- Forget ----------------------------------------------------------------------
def seed_forget(s):
    s.home_path('logs').mkdir(); s.home_path('logs/wrap.jsonl').write_text('{"id":"a"}\n{"id":"b"}\n')
    s.home_path('cache').mkdir(); s.home_path('cache/appearance.json').write_text('{}')
    (pathlib.Path(s.tmp.name) / 'wrap-scratch-1').mkdir()

def forget_toggle_and_delete():
    s = Session(['--forget'])
    try:
        seed_forget(s)
        s.until('Memory'); s.until('(1 fact,'); s.until('Logs'); s.until('(2 entries,'); s.until('Cache'); s.until('(1 file,'); s.until('Temp files'); s.until('(1 dir,')
        s.until('Space toggle'); s.until('forget')
        assert s.wait_screen(lambda: s.visible().count('[✓]') == 4, 3), s.screen.text()
        s.send(' '); assert s.wait_screen(lambda: s.visible().count('[✓]') == 3 and '[]' in s.visible(), 3), s.screen.text()
        assert re.search(r'❯\s*\[ \]\s*Memory', s.screen.text()), s.screen.text()
        s.send('\r'); s.finish(0)
        assert b'Forgotten.' in s.output
        assert s.home_path('memory.json').exists(), 'unchecked memory bucket was deleted'
        assert not s.home_path('logs').exists() and not s.home_path('cache').exists() and not (pathlib.Path(s.tmp.name) / 'wrap-scratch-1').exists()
    finally: s.close()

def forget_esc_deletes_nothing():
    s = Session(['--forget'])
    try:
        seed_forget(s); s.until('Temp files'); s.send('\x1b'); s.finish(0)
        assert b'Forgotten.' not in s.output
        for name in ('memory.json', 'logs/wrap.jsonl', 'cache/appearance.json'): assert s.home_path(name).exists(), name
        assert (pathlib.Path(s.tmp.name) / 'wrap-scratch-1').exists()
    finally: s.close()

# --- Wizard ----------------------------------------------------------------------
class Wizard(Session):
    """No config at all; PATH is an empty bin dir so no coding-agent row appears."""
    def __init__(self, args=(), models_url=None, **kw):
        self.bin = tempfile.TemporaryDirectory(prefix='wrap-wizard-bin-')
        env = {'PATH': self.bin.name, 'WRAP_MODELS_URL': models_url or UNROUTABLE}
        env.update(kw.pop('extra_env', None) or {})
        super().__init__(args, wizard=True, extra_env=env, **kw)
    def to_providers(self, nerd=False):
        self.until('~45 seconds.'); self.send('\r'); self.until('four icons')
        if not nerd: self.send(DOWN)
        self.send('\r'); self.until('SELECT API PROVIDER(S)')
    def close(self):
        super().close(); self.bin.cleanup()

def wizard_completes():
    s = Wizard([], models_url=URL + '/models.json')
    try:
        s.to_providers(nerd=False); s.until('Anthropic'); s.send(' '); s.until('[✓]'); s.send('\r'); s.until('Anthropic API key')
        s.send('sk-ant-test'); s.until('•' * len('sk-ant-test')); s.send('\r'); s.until('Anthropic model'); s.until('claude-sonnet-4-6'); s.send('\r')
        s.finish(0)
        assert b'Configuration saved' in s.output and b'wrap configured' in s.output, s.output[-3000:]
        config = json.loads(s.home_path('config.jsonc').read_text())
        assert config == {'$schema': './config.schema.json', 'providers': {'anthropic': {'apiKey': 'sk-ant-test', 'model': 'claude-sonnet-4-6'}},
                          'defaultProvider': 'anthropic', 'nerdFonts': False}, config
        assert json.loads(s.home_path('config.schema.json').read_text())['type'] == 'object'
        assert b'sk-ant-test' not in s.output, 'API key echoed to the terminal'
    finally: s.close()

def wizard_esc_on_welcome():
    s = Wizard(['hello'])
    try:
        s.until('~45 seconds.'); s.send('\x1b'); s.finish(0)
        assert not s.home_path('config.jsonc').exists() and not s.home_path('config.schema.json').exists()
        assert not s.home_path('logs').exists()
    finally: s.close()

def wizard_without_terminal_is_a_config_error():
    with tempfile.TemporaryDirectory(prefix='wrap-nottty-') as home:
        env = {k: v for k, v in os.environ.items() if k not in SCRUB}
        env.update(WRAP_HOME=home, WRAP_THEME='dark', TERM='xterm-256color')
        p = subprocess.run([BINARY, 'hello'], stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=20)
        assert p.returncode == 1 and p.stdout == b'', (p.returncode, p.stdout)
        assert b'Config error: no config found. Run wrap in a terminal to set one up.' in p.stderr, p.stderr
        assert not (pathlib.Path(home) / 'config.jsonc').exists()

# --- Color levels ----------------------------------------------------------------
def no_color_dialog():
    s = Session(['plain'], response=command('echo PLAIN'), extra_env={'NO_COLOR': '1', 'FORCE_COLOR': '3'})
    try:
        s.until('medium risk'); s.until('echo PLAIN'); s.until('Run command?'); s.send('n'); s.finish(0)
        assert not re.search(rb'\x1b\[[0-9;]*(?:38;|48;)', s.output), 'colour escapes under NO_COLOR'
    finally: s.close()

def basic_color_dialog():
    s = Session(['basic'], response=command('echo BASIC', 'high'), extra_env={'FORCE_COLOR': '1'})
    try:
        s.until('high risk'); s.until('echo BASIC'); s.until('Run command?'); s.send('y'); s.finish(0)
        assert b'BASIC\r\n' in s.output
        # Crossterm writes the 16 ANSI colours as 38;5;0-15; anything above is a leak.
        assert not re.search(rb'\x1b\[[0-9;]*(?:38;2;|48;2;)', s.output), 'truecolor escapes at 16 colours'
        indexed = [int(n) for n in re.findall(rb'\x1b\[[0-9;]*[34]8;5;(\d+)', s.output)]
        assert indexed and max(indexed) < 16, ('256-colour escapes at 16 colours', sorted(set(indexed)))
    finally: s.close()

SCENARIOS = [
    ('medium confirm runs', medium_confirm_runs), ('cancel with n', lambda: cancel_key('n')), ('cancel with Esc', lambda: cancel_key('\x1b')),
    ('cancel with q', lambda: cancel_key('q')), ('cancel with Ctrl+C', lambda: cancel_key('\x03')), ('arrow select yes', arrow_select_yes),
    ('arrow clamp no wraparound', arrow_clamp_no_wraparound),
    ('high risk edit runs override', high_risk_edit_runs_override), ('edit esc restores original', edit_esc_restores_original),
    ('followup replaces command', followup_replaces_command), ('followup esc keeps draft', followup_esc_keeps_draft),
    ('interactive compose submits', interactive_compose_submits), ('interactive esc cancels', interactive_esc_cancels),
    ('low step runs before dialog', low_step_runs_before_dialog), ('confirmed medium step shows running', confirmed_medium_step_shows_running),
    ('resize folds and restores', resize_folds_and_restores), ('early keystroke does not confirm', early_keystroke_does_not_confirm),
    ('tty handoff', tty_handoff), ('child alt screen leaves terminal sane', child_alt_screen_leaves_terminal_sane),
    ('SIGINT during dialog', lambda: signal_during_dialog(signal.SIGINT)), ('SIGTERM during dialog', lambda: signal_during_dialog(signal.SIGTERM)),
    ('SIGINT during dialog without animation', lambda: signal_during_dialog(signal.SIGINT, {'WRAP_NO_ANIMATION': '1'})),
    ('SIGINT during composer', lambda: signal_during_composer(signal.SIGINT)), ('SIGTERM on wizard welcome', lambda: signal_during_wizard_welcome(signal.SIGTERM)),
    ('SIGINT during forget', lambda: signal_during_forget(signal.SIGINT)),
    ('keyboard interrupt kills child', keyboard_interrupt_kills_child),
    ('piped stdin with tty', piped_stdin_with_tty), ('redirected stdout', redirected_stdout), ('redirected answer', redirected_answer),
    ('forget toggle and delete', forget_toggle_and_delete), ('forget esc deletes nothing', forget_esc_deletes_nothing),
    ('wizard completes', wizard_completes), ('wizard esc on welcome', wizard_esc_on_welcome), ('wizard without terminal is a config error', wizard_without_terminal_is_a_config_error),
    ('NO_COLOR dialog', no_color_dialog), ('basic color dialog', basic_color_dialog),
]
if __name__ == '__main__':
    for name, fn in SCENARIOS: run(name, fn)
    server.shutdown()
    if FAILED: print('FAILED:', ', '.join(FAILED)); sys.exit(1)
