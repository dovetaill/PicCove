"""Upload a verified draft, compare downloaded bytes, then publish without overwriting releases."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from release import validate_tag


def publish(directory, tag, repository, commit):
    validate_tag(tag)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('无效 GitHub 仓库名称')
    manifest = json.loads((directory / 'release.json').read_text())
    if manifest['commit'] != commit or manifest['dirty'] or manifest['target'] != 'x86_64-unknown-linux-musl':
        raise ValueError('发行包来源校验失败')
    archive = 'piccove-' + tag + '-linux-x86_64.tar.gz'
    expected = {archive, 'piccovectl-linux-x86_64', 'SHA256SUMS', 'release.json'}
    if {p.name for p in directory.iterdir()} != expected:
        raise ValueError('发行附件不完整')
    subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=directory, check=True)
    found = subprocess.run(['gh', 'release', 'view', tag, '--repo', repository, '--json', 'isDraft,targetCommitish'], capture_output=True, text=True)
    if found.returncode == 0:
        release = json.loads(found.stdout)
        if not release['isDraft'] or release['targetCommitish'] != commit:
            raise ValueError('已发布版本或其他提交的草稿不可覆盖；请创建新版本')
    else:
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repository, '--verify-tag', '--draft',
                        '--target', commit, '--title', 'PicCove ' + tag, '--generate-notes'], check=True)
    subprocess.run(['gh', 'release', 'upload', tag, '--repo', repository, '--clobber',
                    *[str(directory / name) for name in sorted(expected)]], check=True)
    with tempfile.TemporaryDirectory(prefix='piccove-publish-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repository, '--dir', temporary], check=True)
        downloaded = Path(temporary)
        if {p.name for p in downloaded.iterdir()} != expected:
            raise ValueError('远端附件数量不符，保留草稿')
        for name in expected:
            if hashlib.sha256((directory / name).read_bytes()).digest() != hashlib.sha256((downloaded / name).read_bytes()).digest():
                raise ValueError('远端附件校验失败，保留草稿')
    subprocess.run(['gh', 'release', 'edit', tag, '--repo', repository, '--draft=false'], check=True)


if __name__ == '__main__':
    publish(Path(sys.argv[1]), *sys.argv[2:])
