#!/usr/bin/env python3
"""Shell termios restoration through the shared real-PTY harness."""
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


def interrupted_final_child_restores_terminal_modes():
    s = tty.Session(['interrupt command'], response=tty.command(
        '''sh -c 'stty -echo; echo ready > "$WRAP_HOME/child-ready"; exec sleep 20'; echo NOT_REACHED''', risk='low'),
        extra_env={'SHELL': '/bin/bash'})
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


def captured_child_keeps_tty_input():
    step = '''sh -c 'modes=$(stty -g); stty sane; echo ready > "$WRAP_HOME/step-ready"; read -r answer; stty "$modes"; echo got-$answer' '''
    s = tty.Session(['interactive step'], responses=[
        tty.command(step, final=False), tty.command('echo done')],
        extra_env={'SHELL': '/bin/bash'}, piped_stdin=b'attached input\n',
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


if __name__ == '__main__':
    tty.run('final child restores terminal modes', final_child_restores_terminal_modes)
    tty.run('failed final child restores terminal modes', failed_final_child_restores_terminal_modes)
    tty.run('interrupted final child restores terminal modes', interrupted_final_child_restores_terminal_modes)
    tty.run('captured child keeps tty input', captured_child_keeps_tty_input)
    tty.server.shutdown()
    if tty.FAILED:
        raise SystemExit(1)
