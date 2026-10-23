"""Verify Rust installation/update against disposable Compose services, then remove them."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package(stage, output):
    manifest = json.loads((stage / 'release.json').read_text())
    manifest['files'] = {str(p.relative_to(stage)): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in stage.rglob('*') if p.is_file() and p.name != 'release.json'}
    (stage / 'release.json').write_text(json.dumps(manifest))
    output.mkdir()
    name = 'piccove-v' + manifest['version'] + '-linux-x86_64'
    archive = output / (name + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(stage, arcname=name)
    (output / 'SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    return archive


def smoke(bundle, work_parent):
    with tempfile.TemporaryDirectory(prefix='piccove-smoke-', dir=work_parent) as temporary:
        work = Path(temporary)
        stage = work / 'stage'
        shutil.copytree(bundle, stage)
        if (stage / '.env').exists():
            raise ValueError('请使用未安装且不含 .env 的发行包。')
        # A fixture-only obsolete asset exercises successful-upgrade cleanup.
        (stage / 'web/assets/obsolete-smoke.js').write_text('old asset')
        archive = package(stage, work / 'first')
        release = work / 'installed'
        project = 'piccove-smoke-' + os.urandom(6).hex()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        compose = ['docker', 'compose', '--project-directory', str(release), '-p', project]
        cli = [str(stage / 'bin/piccovectl'), '--directory', str(release)]
        try:
            subprocess.run([*cli, 'install', '--archive', str(archive), '--origin', origin,
                            '--port', str(port), '--project', project, '--non-interactive'], check=True)
            env_path = release / '.env'
            config = dict(line.split('=', 1) for line in env_path.read_text().splitlines())
            options = {}
            if os.geteuid() == 0:
                account = pwd.getpwnam('nobody')
                options = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []}
            env = {**os.environ, 'PICCOVE_TEST_URL': origin,
                   'PICCOVE_TEST_ORIGIN': origin, 'PICCOVE_TEST_ADMIN_PASSWORD': config['PICCOVE_ADMIN_PASSWORD']}
            subprocess.run(['python3', '-B', str(ROOT / 'tests/api_smoke.py')],
                           cwd=ROOT, env=env, check=True, **options)
            backup = work / 'manual-backup'
            subprocess.run([*cli, 'backup', '--backup', str(backup)], check=True)
            subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=backup, check=True)
            subprocess.run([*compose, 'exec', '-T', 'postgres', 'pg_restore', '--list'],
                           input=(backup / 'database.dump').read_bytes(), stdout=subprocess.DEVNULL, check=True)
            # Run the installed binary itself during upgrade, including its atomic self-replacement.
            cli[0] = str(release / 'bin/piccovectl')
            before_env = env_path.read_bytes()
            metadata = lambda p: (p.stat().st_uid, p.stat().st_gid, p.stat().st_mode)
            before_meta = {str(p.relative_to(release)): metadata(p) for p in release.rglob('*') if p.is_file()}
            counts = [*compose, 'exec', '-T', 'postgres', 'psql', '-U', 'piccove', '-d', 'piccove', '-Atc',
                      'SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM images), (SELECT count(*) FROM albums)']
            before_counts = subprocess.check_output(counts)
            before_images = subprocess.check_output([*compose, 'images', '-q', 'api', 'web'], text=True).split()
            manifest = json.loads((stage / 'release.json').read_text())
            parts = list(map(int, manifest['version'].split('.')))
            parts[2] += 1
            manifest['version'] = '.'.join(map(str, parts))
            (stage / 'release.json').write_text(json.dumps(manifest))
            (stage / 'web/assets/obsolete-smoke.js').unlink()
            with (stage / 'web/index.html').open('a') as stream:
                stream.write('\n<!-- smoke upgrade fixture -->\n')
            newer = package(stage, work / 'next')
            subprocess.run([*cli, 'update', '--archive', str(newer), '--non-interactive'], check=True)
            assert before_env == env_path.read_bytes()
            assert before_counts == subprocess.check_output(counts)
            assert not (release / 'web/assets/obsolete-smoke.js').exists()
            assert not (release / '.piccove-update-pending.json').exists()
            for name, before in before_meta.items():
                if (release / name).exists():
                    assert metadata(release / name) == before, name
            subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=backup, check=True)
            subprocess.run([*cli, 'health'], check=True)
            subprocess.run([*cli, 'update', '--archive', str(newer), '--non-interactive'], check=True)
            rejected = subprocess.run([*cli, 'update', '--archive', str(archive), '--non-interactive'])
            assert rejected.returncode != 0
            current_images = subprocess.check_output([*compose, 'images', '-q', 'api', 'web'], text=True).split()
            for image in set(before_images) - set(current_images):
                assert subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL).returncode != 0, image
            print(json.dumps({'release_smoke': 'passed', 'install_update_backup': 'passed',
                              'metadata_preserved': True, 'project': project, 'port': port}))
        finally:
            # Only this invocation's containers, volumes and images are eligible for removal.
            if (release / '.env').exists():
                subprocess.run([*compose, 'down', '--volumes', '--rmi', 'local', '--remove-orphans'], check=True)
            remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
                                                f'label=com.docker.compose.project={project}']).strip()
            volumes = subprocess.check_output(['docker', 'volume', 'ls', '-q', '--filter',
                                              f'label=com.docker.compose.project={project}']).strip()
            if remaining or volumes:
                raise RuntimeError('测试资源尚未清理：' + project)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--work-parent', type=Path, default=Path('/var/tmp'))
    args = parser.parse_args()
    smoke(args.bundle.resolve(), args.work_parent.resolve())
