#!/usr/bin/env python3
"""Help presentation in a real PTY, with disposable homes and no network."""
import fcntl, os, pathlib, pty, re, select, struct, subprocess, sys, tempfile, termios, time

binary = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/debug/wrap').resolve())
SCRUB = ('NO_COLOR', 'FORCE_COLOR', 'CI', 'WRAP_NO_ANIMATION', 'WRAP_CONFIG', 'WRAP_HOME', 'WRAP_THEME')
CURSOR = re.compile(rb'\x1b\[\?25[hl]')

def run_help(args, width, height, overrides, resize=False):
    """Runs `wrap --help …` with stdout on a PTY and stderr on a pipe; returns (stdout bytes, stderr bytes, exit code, termios unchanged)."""
    with tempfile.TemporaryDirectory() as home:
        master, slave = pty.openpty()
        try:
            initial = termios.tcgetattr(slave)
            os.set_blocking(master, False)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            env = {k: v for k, v in os.environ.items() if k not in SCRUB}
            env.update(WRAP_HOME=home, WRAP_THEME='dark', TERM='xterm-256color', COLORTERM='truecolor')
            env.update(overrides)
            process = subprocess.Popen([binary, *args], stdin=slave, stdout=slave, stderr=subprocess.PIPE, env=env)
            data = b''
            deadline = time.monotonic() + 8
            while process.poll() is None:
                if time.monotonic() > deadline:
                    process.kill()
                    raise AssertionError((args, 'help stalled'))
                if select.select([master], [], [], .1)[0]:
                    try: chunk = os.read(master, 65536)
                    except OSError: break
                    if not chunk: break
                    data += chunk
                    if resize:
                        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 10, 20, 0, 0))
            while select.select([master], [], [], .05)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: break
                if not chunk: break
                data += chunk
            code = process.wait(timeout=3)
            stderr = process.stderr.read()
            assert termios.tcgetattr(slave) == initial, 'help changed the terminal modes'
            assert not os.listdir(home), ('help wrote into WRAP_HOME', os.listdir(home))
            return data, stderr, code
        finally:
            os.close(master)
            os.close(slave)

def check(name, width, height, overrides, color, animation, resize=False):
    data, stderr, code = run_help(['--help'], width, height, overrides, resize)
    assert code == 0, (name, code, stderr)
    assert (b'\x1b[' in data) == color, (name, data[:400])
    if name in ('dumb terminal static', 'basic color static'):
        assert not re.search(rb'\x1b\[[0-9;]*(?:38;2;|48;2;|38;5;|48;5;)', data), (name, 'colour beyond the terminal level')
    movements = re.findall(rb'\x1b\[\d+A', data)
    if not resize:
        assert bool(movements) == animation, (name, movements[:3], data[:400])
    assert b'Commands:' in data and b'Examples:' in data and b'Options:' in data, name
    assert b'--forget' in data and b'--log' in data, name
    assert b'\x1b[?1049h' not in data and b'\x1b[?1049h' not in stderr, (name, 'help must not use the alternate screen')
    # Chrome (cursor hide/show for the shine) is the only thing allowed on stderr, and the cursor must end visible.
    assert CURSOR.sub(b'', stderr) == b'', (name, stderr)
    toggles = CURSOR.findall(stderr)
    assert bool(toggles) == animation or resize, (name, toggles)
    if toggles: assert toggles[-1] == b'\x1b[?25h', (name, 'help left the cursor hidden', toggles)
    if name in ('truecolor shine', 'light theme shine'):
        first_frame = re.search(rb'\x1b\[\d+A', data)
        before = data[:first_frame.start()]
        assert screen(before) == screen(data), 'shine changed help contents or cursor position'
    print('PASS', name, flush=True)

def screen(data):
    rows = [[' '] * 160 for _ in range(80)]
    row = col = 0
    for token in re.findall(r'\x1b\[[0-9;]*[A-Za-z]|[^\x1b]', data.decode()):
        if token.startswith('\x1b['):
            code = token[-1]
            value = int(token[2:-1] or '1') if code in 'ABC' else 0
            if code == 'A': row -= value
            if code == 'B': row += value
            if code == 'C': col += value
        elif token == '\r': col = 0
        elif token == '\n': row += 1
        else:
            rows[row][col] = token
            col += 1
    return rows, row, col

def check_pipe():
    with tempfile.TemporaryDirectory() as home:
        env = {k: v for k, v in os.environ.items() if k not in SCRUB}
        env.update(WRAP_HOME=home, WRAP_THEME='dark', TERM='xterm-256color', COLORTERM='truecolor')
        p = subprocess.run([binary, '--help'], stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=20)
        assert p.returncode == 0 and p.stderr == b'', (p.returncode, p.stderr)
        assert b'\x1b' not in p.stdout, p.stdout[:300]
        assert p.stdout.startswith(b'wrap - natural language shell commands\n'), p.stdout[:200]
        for needle in (b'Usage: w <prompt>', b'Examples:', b'Commands:', b'Options:', b'--help [command]', b'--forget', b'--log'):
            assert needle in p.stdout, needle
        assert not os.listdir(home)
    print('PASS plain output on a pipe', flush=True)

def check_subpage():
    data, stderr, code = run_help(['--help', 'log'], 110, 60, {})
    assert code == 0 and stderr == b'', (code, stderr)
    text = data.replace(b'\r\n', b'\n')
    assert text.startswith(b'w --log'), text[:200]
    assert b'Commands:' not in text and b'\x1b[' not in text, text[:300]
    data, stderr, code = run_help(['--help', 'no-such-flag'], 110, 60, {})
    assert code == 1 and data == b'' and b'Unknown flag: no-such-flag' in stderr, (code, data, stderr)
    print('PASS --help log subpage', flush=True)

check('truecolor shine', 110, 60, {}, True, True)
check('light theme shine', 110, 60, {'WRAP_THEME': 'light'}, True, True)
check('false CI allows shine', 110, 60, {'CI': 'false'}, True, True)
check('CI static', 110, 60, {'CI': '1'}, True, False)
check('animation override', 110, 60, {'WRAP_NO_ANIMATION': '1'}, True, False)
check('no color overrides forced color', 110, 60, {'NO_COLOR': '', 'FORCE_COLOR': '3'}, False, False)
check('basic color static', 110, 60, {'FORCE_COLOR': '1'}, True, False)
check('256 color static', 110, 60, {'FORCE_COLOR': '2'}, True, False)
check('short terminal static', 110, 12, {}, True, False)
check('unknown dimensions static', 0, 0, {}, True, True)
# A dumb terminal still gets the styled page (bold/dim only, no colour) and never the shine.
check('dumb terminal static', 110, 60, {'TERM': 'dumb'}, True, False)
check('resize during shine', 110, 60, {}, True, False, resize=True)
check_pipe()
check_subpage()
