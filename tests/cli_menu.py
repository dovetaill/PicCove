"""PTY regression checks: python3 tests/cli_menu.py /path/to/piccovectl.

Runs against a disposable installation with fake Docker; never contacts services.
"""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import sys
import tempfile
import termios
import time


def exercise(binary, steps, expected=()):
    with tempfile.TemporaryDirectory(prefix='piccove-menu-') as temporary:
        root = Path(temporary)
        (root / 'bin').mkdir()
        shutil.copy2(binary, root / 'bin/piccovectl')
        for name in ['compose.yml', '.env', 'bin/piccove-api']:
            (root / name).touch()
        (root / 'release.json').write_text(json.dumps(dict(
            version='1.2.3', target='fixture', commit='a' * 40, dirty=False)))
        docker = root / 'bin/docker'
        docker.write_text('''#!/bin/sh
case "$*" in
  *'config --format json') echo '{"name":"test","services":{"api":{},"web":{},"postgres":{}}}';;
  'ps -aq '*) ;;
  *'ps --format '*) printf 'api: Up\\nweb: Up\\npostgres: Up\\n';;
  *' logs '*) echo MOCK_LOG_FAILURE >&2; exit 1;;
  *' stop') echo MOCK_STOP;;
  *) echo MOCK_STATUS;;
esac
''')
        docker.chmod(0o700)
        master, slave = pty.openpty()
        before = termios.tcgetattr(slave)
        pid = os.fork()
        if pid == 0:
            os.close(master)
            os.setsid()
            import fcntl
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            os.close(slave)
            os.chdir('/')  # Directory detection must not depend on cwd.
            os.environ['PATH'] = str(root / 'bin') + ':/usr/bin:/bin'
            os.execv(str(root / 'bin/piccovectl'), ['piccovectl'])
        output = b''
        reaped = False
        try:
            offset = 0
            for marker, keys in steps:
                deadline = time.monotonic() + 10
                while marker.encode() not in output[offset:]:
                    assert time.monotonic() < deadline, output.decode(errors='replace')
                    if select.select([master], [], [], .1)[0]:
                        output += os.read(master, 65536)
                offset = len(output)
                # Include cursor hide / flush before injecting input into a prompt.
                time.sleep(.05)
                os.write(master, keys)
            deadline = time.monotonic() + 5
            while True:
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited:
                    reaped = True
                    assert os.waitstatus_to_exitcode(status) == 0, output
                    break
                assert time.monotonic() < deadline, 'Menu did not exit promptly'
                if select.select([master], [], [], .05)[0]:
                    output += os.read(master, 65536)
            while select.select([master], [], [], 0)[0]:
                output += os.read(master, 65536)
            assert termios.tcgetattr(slave) == before, 'Terminal settings were not restored'
            assert b'\x1b[?25h' in output, 'Cursor was not restored'
            assert b'^[[A' not in output and b'^[[B' not in output, output
            assert str(root).encode() in output
            for text in expected:
                assert text.encode() in output, text
        finally:
            if not reaped:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    binary = Path(sys.argv[1]).resolve()
    ready = 'q / Ctrl+C 退出'
    cases = [
        ([(ready, b'\x03')], []),
        ([(ready, b'\x1b[A'), ('❯ 0. 退出', b'\r')], []),
        ([(ready, b'\x1b[B'), ('❯ 2. 启动服务', b'\x1bOA'),
          ('❯ 1. 查看服务状态', b'\r'), ('按回车返回菜单', b'\x1b[D\x1b[C\r'),
          (ready, b'q')], ['MOCK_STATUS']),
        ([(ready, b'3'), ('确认继续？', b'\x1b[A\x1b[B\x03')], []),
        ([(ready, b'3'), ('确认继续？', b'\r'), ('按回车返回菜单', b'\x03')], ['已取消']),
        ([(ready, b'3'), ('确认继续？', b'y'), ('按回车返回菜单', b'\x03')], ['MOCK_STOP']),
        ([(ready, b'5'), ('按回车返回菜单', b'\x03')], ['操作失败', 'MOCK_LOG_FAILURE']),
        ([(ready, b'\x1b[3~\x1b[1;5C\x1bOP0')], []),
    ]
    for steps, expected in cases:
        exercise(binary, steps, expected)
    print(f'{len(cases)} PTY scenarios passed; terminal settings and cursor restored in every case')
