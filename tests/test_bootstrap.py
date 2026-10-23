"""Test the thin shell bootstrap without network access or real Docker commands."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BootstrapTests(unittest.TestCase):
    def execute(self, corrupt=False):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            binary = b'#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\n'
            digest = '0' * 64 if corrupt else hashlib.sha256(binary).hexdigest()
            (work / 'payload').write_bytes(binary)
            (work / 'sums').write_text(digest + '  piccovectl-linux-x86_64\n')
            (work / 'docker').write_text('#!/bin/sh\nexit 0\n')
            (work / 'curl').write_text('''#!/bin/sh
for argument in "$@"; do
    case "$argument" in https://*) url=$argument;; esac
    if [ "${previous:-}" = -o ]; then destination=$argument; fi
    previous=$argument
done
printf '%s\\n' "$url" >> "$URLS"
printf '%s\\n' "$destination" >> "$OUTPUTS"
case "$url" in
    */SHA256SUMS) cp "$FIXTURE/sums" "$destination";;
    */piccovectl-linux-x86_64) cp "$FIXTURE/payload" "$destination";;
    *) exit 1;;
esac
''')
            for name in ['docker', 'curl']:
                (work / name).chmod(0o700)
            env = {**os.environ, 'PATH': str(work) + ':/usr/bin:/bin', 'FIXTURE': str(work),
                   'RECORD': str(work / 'record'), 'URLS': str(work / 'urls'), 'OUTPUTS': str(work / 'outputs')}
            result = subprocess.run(['sh', str(ROOT / 'scripts/install-server.sh'), 'update',
                                     '--version', '1.2.3', '--non-interactive'], env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, not corrupt, result.stderr)
            self.assertEqual((work / 'record').exists(), not corrupt)
            if not corrupt:
                self.assertEqual((work / 'record').read_text().splitlines(),
                                 ['update', '--version', '1.2.3', '--non-interactive'])
            self.assertTrue(all('/releases/download/v1.2.3/' in u for u in (work / 'urls').read_text().splitlines()))
            for output in (work / 'outputs').read_text().splitlines():
                self.assertFalse(Path(output).parent.exists(), output)

    def test_pinned_release_and_cleanup(self):
        self.execute()

    def test_invalid_checksum_is_not_executed(self):
        self.execute(corrupt=True)
