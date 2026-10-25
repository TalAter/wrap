#!/usr/bin/env python3
"""External-editor dialog contracts using the shared real-PTY harness."""
import os
import pathlib
import signal
import shlex
import termios
import tempfile
import time

import terminal as tty


def wait_file(session, path):
    assert session.wait_screen(path.exists, 5), (path, session.output[-3000:])


def terminal_editor_reads_tty_and_keeps_chrome_off_stdout():
    with tempfile.TemporaryDirectory(prefix='wrap-editor-') as root:
        editor = pathlib.Path(root) / 'editor'
        editor.write_text('''#!/bin/sh
[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 5
printf EDITOR_INPUT
read -r answer
stty -echo
printf 'echo %s\\n' "$answer" > "$1"
''')
        editor.chmod(0o700)
        s = tty.Session(['edit this'], response=tty.command('echo ORIGINAL'),
                        extra_env={'EDITOR': str(editor)}, piped_stdin=b'attached input\n', redirect_stdout=True)
        try:
            s.until('Run command?'); s.send('e'); s.until('to discard changes'); s.send('\x07')
            s.until_output(b'EDITOR_INPUT'); s.send('EDITED\r'); s.until('echo EDITED')
            s.send('\r'); entries = s.finish(0)
            assert s.stdout_file.read_bytes() == b'EDITED\n', s.stdout_file.read_bytes()
            assert tty.final_turn(entries)[1]['source'] == 'user_override'
        finally:
            s.close()


def terminal_editor_interrupt_restores_the_dialog():
    with tempfile.TemporaryDirectory(prefix='wrap-editor-') as root:
        editor = pathlib.Path(root) / 'editor'
        editor.write_text('''#!/bin/sh
stty -echo
printf EDITOR_WAITING
exec sleep 20
''')
        editor.chmod(0o700)
        s = tty.Session([], response=tty.reply('unused'), extra_env={'EDITOR': str(editor)}, redirect_stdout=True)
        try:
            s.until('compose'); s.send('original draft'); s.until('original draft'); s.send('\x07')
            s.until_output(b'EDITOR_WAITING'); s.send('\x03'); s.until('original draft')
            s.send('\x1b'); s.finish(0)
            assert s.stdout_file.read_bytes() == b''
        finally:
            s.close()


def terminal_editor_descendants_cancel_and_restore_terminal():
    with tempfile.TemporaryDirectory(prefix='wrap-editor-') as root:
        editor = pathlib.Path(root) / 'editor'
        editor.write_text('''#!/bin/sh
stty -echo
printf '%s' "$$" > "$WRAP_HOME/editor.pid"
sleep 30 &
printf '%s' "$!" > "$WRAP_HOME/descendant.pid"
printf EDITOR_DESCENDANTS_READY
wait
''')
        editor.chmod(0o700)
        s = tty.Session([], response=tty.reply('unused'), extra_env={'EDITOR': str(editor)}, redirect_stdout=True)
        try:
            s.until('compose'); s.send('original draft'); s.until('original draft'); s.send('\x07')
            s.until_output(b'EDITOR_DESCENDANTS_READY')
            editor_pid = int(s.home_path('editor.pid').read_text())
            descendant = int(s.home_path('descendant.pid').read_text())
            os.kill(s.pid(), signal.SIGTERM)
            entries = s.finish(143)
            assert entries[-1]['outcome'] == 'cancelled', entries
            assert s.stdout_file.read_bytes() == b''
            try: os.kill(editor_pid, 0)
            except ProcessLookupError: pass
            else: raise AssertionError('editor was not reaped')
            if pathlib.Path('/proc').exists():
                stat = pathlib.Path(f'/proc/{descendant}/stat')
                assert not stat.exists() or stat.read_text().split(')')[1].split()[0] == 'Z', 'editor descendant survived'
        finally:
            s.close()


def terminal_editor_suspend_resume_respects_shell(background=False):
    with tempfile.TemporaryDirectory(prefix='wrap-editor-') as root:
        root = pathlib.Path(root)
        editor = root / 'editor'
        editor.write_text('''#!/bin/sh
stty -echo
printf '%s' "$$" > "$(dirname "$0")/pid"
printf EDITOR_STOP_READY
read -r answer
printf 'echo %s' "$answer" > "$1"
''')
        editor.chmod(0o700)
        s = tty.ShellSession(
            f"--version; EDITOR={shlex.quote(str(editor))} {shlex.quote(tty.BINARY)} 'edit this'",
            [tty.command('echo ORIGINAL')])
        editor_pid = None
        try:
            s.until('Run command?'); s.send('e'); s.until('to discard changes'); s.send('\x07')
            s.until('EDITOR_STOP_READY'); editor_pid = int((root / 'pid').read_text())
            assert s.foreground() == editor_pid
            s.output = b''; s.send('\x1a'); s.until('Stopped', timeout=3)
            s.until('PROMPT$ ')
            assert s.foreground() == s.process.pid, 'shell never regained foreground'
            shell_modes = root / 'shell-modes'
            s.send(f'stty -a > {shlex.quote(str(shell_modes))}; echo SHELL_MODES_$((1+1))\n')
            s.until('SHELL_MODES_2')
            assert 'echo' in shell_modes.read_text().replace(';', ' ').split(), 'editor modes leaked to shell'
            if background:
                s.output = b''; s.send('bg\n'); s.pump_for(.3)
                s.send('echo SHELL_$((1+1))\n'); s.until('SHELL_2')
                assert s.foreground() == s.process.pid, 'background editor stole shell terminal'
                s.send('jobs\n'); s.until('Stopped')
            s.output = b''; s.send('fg\n'); s.pump_for(.3)
            assert s.foreground() == editor_pid, 'fg did not resume editor foreground'
            assert not termios.tcgetattr(s.slave)[3] & termios.ECHO, 'editor modes not restored on fg'
            s.send('RESUMED\n'); s.until('echo RESUMED')
            assert not termios.tcgetattr(s.slave)[3] & termios.ICANON, 'dialog did not resume raw mode'
            s.output = b''
            s.send('\x1b'); s.pump_for(.2); s.send('n'); s.until('PROMPT$ ')
            assert s.foreground() == s.process.pid
        finally:
            if editor_pid is not None:
                try: os.killpg(editor_pid, signal.SIGKILL)
                except ProcessLookupError: pass
            s.close()


def unlaunchable_editor_restores_the_dialog():
    s = tty.Session([], response=tty.reply('unused'), extra_env={'EDITOR': '/nonexistent/editor'}, redirect_stdout=True)
    try:
        s.until('compose'); s.send('original draft'); s.until('original draft'); s.send('\x07')
        assert s.wait_screen(lambda: s.output.count(b'\x1b[?1049h') >= 2, 5), s.output[-3000:]
        s.until('original draft'); s.send('\x1b'); s.finish(0)
        assert s.stdout_file.read_bytes() == b''
    finally:
        s.close()


def gui_editor_cannot_read_dialog_and_survives_cancellation():
    with tempfile.TemporaryDirectory(prefix='wrap-gui-editor-') as root:
        root = pathlib.Path(root)
        editor = root / 'code'
        editor.write_text('''#!/bin/sh
[ "$1" = '-w' ] || exit 4
read -r stolen && exit 5
if (: </dev/tty) 2>/dev/null; then exit 6; fi
printf GUI_CHROME
root=$(dirname "$0")
printf '%s' "$$" > "$root/pid"
while [ ! -f "$root/release" ]; do sleep 0.02; done
printf 'saved later' > "$2"
printf done > "$root/done"
''')
        editor.chmod(0o700)
        s = tty.Session([], response=tty.reply('unused'), extra_env={'EDITOR': str(editor)}, redirect_stdout=True)
        pid = None
        try:
            s.until('compose'); s.send('original draft'); s.until('original draft'); s.send('\x07')
            wait_file(s, root / 'pid'); s.until_output(b'GUI_CHROME'); pid = int((root / 'pid').read_text())
            s.send('\x1b'); s.finish(0)
            os.kill(pid, 0)
            assert s.stdout_file.read_bytes() == b''
            (root / 'release').touch()
            end = time.monotonic() + 3
            while not (root / 'done').exists() and time.monotonic() < end:
                time.sleep(.01)
            assert (root / 'done').exists(), 'GUI editor stopped when dialog closed'
            assert s.home_path('cache/compose.md').read_text() == 'saved later'
        finally:
            if pid is not None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            s.close()


if __name__ == '__main__':
    for name, test in [
        ('terminal editor reopens tty and preserves stdout', terminal_editor_reads_tty_and_keeps_chrome_off_stdout),
        ('terminal editor Ctrl-C restores dialog', terminal_editor_interrupt_restores_the_dialog),
        ('editor descendants cancellation restores terminal', terminal_editor_descendants_cancel_and_restore_terminal),
        ('editor Ctrl-Z and fg restore dialog', terminal_editor_suspend_resume_respects_shell),
        ('editor bg leaves shell foreground', lambda: terminal_editor_suspend_resume_respects_shell(True)),
        ('editor launch failure restores dialog', unlaunchable_editor_restores_the_dialog),
        ('GUI editor input isolation and detached cancellation', gui_editor_cannot_read_dialog_and_survives_cancellation),
    ]:
        tty.run(name, test)
    tty.server.shutdown()
    if tty.FAILED:
        raise SystemExit(1)
