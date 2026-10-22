"""Exercise an extracted release against disposable Compose services, then remove them."""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import socket
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def smoke(bundle, work_parent):
    with tempfile.TemporaryDirectory(prefix='piccove-smoke-', dir=work_parent) as temporary:
        work = Path(temporary)
        shutil.copytree(bundle, work / 'release')
        release = work / 'release'
        if (release / '.env').exists():
            raise ValueError('请使用未安装的发行包副本，不允许带入已有 .env。')
        project = 'piccove-smoke-' + os.urandom(6).hex()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        subprocess.run(['python3', '-B', str(release / 'configure.py'), '--origin', origin,
                        '--port', str(port), '--project', project], cwd=release, check=True)
        config = dict(line.split('=', 1) for line in (release / '.env').read_text().splitlines())
        docker_env = {**os.environ, 'DOCKER_CONFIG': str(work / 'docker-config'), 'BUILDX_BUILDER': project}
        compose = ['docker', 'compose', '--project-directory', str(release), '-p', project]
        try:
            subprocess.run(['docker', 'buildx', 'create', '--driver', 'docker-container', '--name', project], env=docker_env, check=True)
            subprocess.run(['bash', 'install.sh', '--resume'], cwd=release, env=docker_env, check=True)
            html = urllib.request.urlopen(origin, timeout=15).read().decode()
            assert 'PicCove' in html
            # Fetch actual compiled assets through the packaged Nginx, not just its health endpoint.
            import re
            for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"', html):
                received = urllib.request.urlopen(origin + asset, timeout=15).read()
                assert received == (release / 'web' / asset.lstrip('/')).read_bytes(), asset
            options = {}
            if os.geteuid() == 0:
                account = pwd.getpwnam('nobody')
                options = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []}
            env = {**os.environ, 'PICCOVE_TEST_URL': origin,
                   'PICCOVE_TEST_ORIGIN': origin, 'PICCOVE_TEST_ADMIN_PASSWORD': config['PICCOVE_ADMIN_PASSWORD']}
            subprocess.run(['python3', '-B', str(ROOT / 'tests/api_smoke.py')],
                           cwd=ROOT, env=env, check=True, **options)
            print(json.dumps({'release_smoke': 'passed', 'project': project, 'port': port}))
        finally:
            # These names belong exclusively to this invocation, never to a persistent installation.
            try:
                subprocess.run([*compose, 'down', '--volumes', '--rmi', 'local', '--remove-orphans'], env=docker_env, check=True)
            finally:
                subprocess.run(['docker', 'buildx', 'rm', '--force', project], env=docker_env, check=True)
            remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
                                                f'label=com.docker.compose.project={project}']).strip()
            volumes = subprocess.check_output(['docker', 'volume', 'ls', '-q', '--filter',
                                              f'label=com.docker.compose.project={project}']).strip()
            if remaining or volumes:
                raise RuntimeError('测试资源尚未清理：' + project)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--work-parent', type=Path, default=Path('/var/tmp'))
    args = parser.parse_args()
    smoke(args.bundle.resolve(), args.work_parent.resolve())
