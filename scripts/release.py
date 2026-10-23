"""PicCove version validation and disposable Linux x86_64 release builds."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'x86_64-unknown-linux-musl'
VERSION_RE = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version(root=ROOT):
    cargo = tomllib.loads((root / 'apps/api/Cargo.toml').read_text())['package']['version']
    lock = tomllib.loads((root / 'apps/api/Cargo.lock').read_text())
    values = [cargo] + [p['version'] for p in lock['package'] if p['name'] == 'piccove-api']
    package = json.loads((root / 'admin/package.json').read_text())
    npm_lock = json.loads((root / 'admin/package-lock.json').read_text())
    values += [package['version'], npm_lock['version'], npm_lock['packages']['']['version']]
    require(re.fullmatch(VERSION_RE, cargo) and len(values) == 5 and len(set(values)) == 1,
            'Cargo/npm 版本不一致，请运行 version --set X.Y.Z。')
    return cargo


def set_version(value, root=ROOT):
    require(re.fullmatch(VERSION_RE, value), '版本必须为 X.Y.Z，不含 v。')
    changes = {}
    cargo = root / 'apps/api/Cargo.toml'
    changes[cargo] = re.sub(r'^version = "[^"]+"$', f'version = "{value}"', cargo.read_text(), count=1, flags=re.M)
    lock = root / 'apps/api/Cargo.lock'
    changes[lock], count = re.subn(r'(name = "piccove-api"\nversion = ")[^"]+("\n)',
                                  lambda m: m[1] + value + m[2], lock.read_text())
    require(count == 1, 'Cargo.lock 缺少唯一的 piccove-api 包。')
    for name in ['package.json', 'package-lock.json']:
        path = root / 'admin' / name
        data = json.loads(path.read_text())
        data['version'] = value
        if name == 'package-lock.json':
            data['packages']['']['version'] = value
        changes[path] = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    for path, text in changes.items():
        path.write_text(text)
    return version(root)


def validate_tag(tag):
    require(tag == 'v' + version(), 'tag 必须严格等于当前版本 v' + version())


def run(args, *, cwd=ROOT, env=None):
    child = subprocess.Popen([str(a) for a in args], cwd=cwd, env=env, start_new_session=True)
    try:
        if child.wait() != 0:
            raise RuntimeError('命令失败：' + str(args[0]))
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=10)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def build(output, work_parent, tag=None):
    require(os.geteuid() != 0, '请使用普通用户构建；不要以 root 运行编译或 npm。')
    require(os.uname().sysname == 'Linux' and os.uname().machine == 'x86_64', '当前发行目标为 Linux x86_64。')
    value = version()
    if tag:
        validate_tag(tag)
    require(not output.exists(), '输出目录已存在，拒绝覆盖：' + str(output))
    for tool in ['cargo', 'rustc', 'node', 'npm', 'musl-gcc']:
        require(shutil.which(tool), '缺少构建工具：' + tool)
    with tempfile.TemporaryDirectory(prefix='piccove-build-', dir=work_parent) as temporary:
        work = Path(temporary)
        env = {**os.environ, 'CARGO_HOME': str(work / 'cargo'), 'CARGO_TARGET_DIR': str(work / 'target'), 'CARGO_INCREMENTAL': '0',
               'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_PROFILE_TEST_DEBUG': '0',
               'CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER': 'musl-gcc',
               'npm_config_cache': str(work / 'npm-cache'), 'TMPDIR': str(work)}
        source = work / 'source'
        (source / 'apps').mkdir(parents=True)
        shutil.copytree(ROOT / 'apps/api', source / 'apps/api', ignore=shutil.ignore_patterns('target', '.env', 'uploads'))
        shutil.copytree(ROOT / 'admin', source / 'admin', ignore=shutil.ignore_patterns('node_modules', 'dist', '.env', '.env.*'))
        shutil.copytree(ROOT / 'tests', source / 'tests')
        api = source / 'apps/api'
        fmt_config = work / 'rustfmt.toml'
        fmt_config.write_text('')
        run(['cargo', 'fmt', '--check', '--', '--config-path', fmt_config], cwd=api, env=env)
        run(['cargo', 'test', '--locked'], cwd=api, env=env)
        run(['cargo', 'build', '--locked', '--release', '--target', TARGET], cwd=api, env=env)
        web = source / 'admin'
        run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=web, env=env)
        run(['npm', 'run', 'build'], cwd=web, env=env)
        run([web / 'node_modules/.bin/tsx', source / 'tests/web.test.mts'], cwd=source, env=env)
        name = f'piccove-v{value}-linux-x86_64'
        stage = work / name
        (stage / 'bin').mkdir(parents=True)
        for binary in ['piccove-api', 'piccovectl']:
            shutil.copy2(work / 'target' / TARGET / 'release' / binary, stage / 'bin' / binary)
        shutil.copytree(web / 'dist', stage / 'web')
        shutil.copytree(ROOT / 'deploy', stage / 'deploy')
        shutil.copy2(ROOT / 'deploy/compose.yml', stage / 'compose.yml')
        shutil.copy2(ROOT / 'scripts/install-server.sh', stage / 'install.sh')
        shutil.copy2(ROOT / 'piccove.sh', stage / 'piccove.sh')
        shutil.copy2(ROOT / 'README.md', stage / 'README.md')
        shutil.copytree(ROOT / 'docs', stage / 'docs')
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT))
        require(not tag or not dirty, '正式 tag 构建要求工作区干净。')
        manifest = {'version': value, 'target': TARGET, 'commit': commit, 'dirty': dirty,
                    'files': {str(p.relative_to(stage)): hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in sorted(stage.rglob('*')) if p.is_file()}}
        (stage / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
        archive = work / (name + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(stage, arcname=name)
        binary = work / 'piccovectl-linux-x86_64'
        shutil.copy2(stage / 'bin/piccovectl', binary)
        sums = hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n'
        sums += hashlib.sha256(binary.read_bytes()).hexdigest() + '  ' + binary.name + '\n'
        output.mkdir(parents=True)
        shutil.copy2(binary, output / binary.name)
        shutil.copy2(archive, output / archive.name)
        (output / 'SHA256SUMS').write_text(sums)
        (output / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('发行包：' + str(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    v = sub.add_parser('version'); v.add_argument('--set')
    check = sub.add_parser('validate'); check.add_argument('tag')
    b = sub.add_parser('build')
    b.add_argument('--output', type=Path, required=True)
    b.add_argument('--work-parent', type=Path, default=Path('/var/tmp'))
    b.add_argument('--tag')
    args = parser.parse_args()
    if args.command == 'version':
        print(set_version(getattr(args, 'set')) if getattr(args, 'set') else version())
    elif args.command == 'validate':
        validate_tag(args.tag)
    else:
        build(args.output.resolve(), args.work_parent.resolve(), args.tag)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    try:
        main()
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
