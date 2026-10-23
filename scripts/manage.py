"""PicCove 服务端打包、发版及运维的统一入口。"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INSTALL = Path('/opt/piccove')
DEFAULT_ORIGIN = 'https://tu.imggg.com'


def run(args, cwd=None, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True, **kwargs)


def output(args, cwd=None):
    return run(args, cwd, capture_output=True, text=True).stdout.strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source():
    require((ROOT / 'apps/api/Cargo.toml').is_file(), '打包和发版请在源码仓库运行；安装目录只提供运维功能。')


def current_version():
    source()
    from release import version
    return version(ROOT)


def default_archive():
    value = current_version()
    return ROOT / 'release-output/server' / ('v' + value) / f'piccove-v{value}-linux-x86_64.tar.gz'


def compose(directory, *args, **kwargs):
    return run(['docker', 'compose', '--project-directory', directory, *args], cwd=directory, **kwargs)


def validate_install(directory):
    require(directory.is_dir() and not directory.is_symlink(), '安装目录不存在或是符号链接。')
    for name in ['compose.yml', '.env', 'bin/piccove-api']:
        path = directory / name
        require(path.is_file() and not path.is_symlink(), '不是完整 PicCove 安装：' + str(path))
    config = json.loads(compose(directory, 'config', '--format', 'json', capture_output=True, text=True).stdout)
    require(set(config['services']) == {'api', 'web', 'postgres'}, 'Compose 服务与 PicCove 不匹配。')
    project = config['name']
    ids = output(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split()
    for identifier in ids:
        owner = output(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', identifier])
        require(Path(owner).resolve() == directory.resolve(), '同名 Compose 项目属于其他安装目录，拒绝操作。')
    return config


@contextlib.contextmanager
def installation(directory):
    validate_install(directory)
    lock = directory / '.piccove-ops.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def unpack(archive, destination):
    require(archive.is_file(), '找不到发行包：' + str(archive))
    sums = archive.parent / 'SHA256SUMS'
    require(sums.is_file(), '发行包旁必须有 SHA256SUMS。')
    matches = []
    for line in sums.read_text().splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *](.+)', line)
        if match and match[2] == archive.name:
            matches.append(match[1].lower())
    require(len(matches) == 1 and checksum(archive) == matches[0], '发行包 SHA-256 校验失败。')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        require(members and len(members) < 100000, '发行包内容数量无效。')
        roots = set()
        seen = set()
        total = 0
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and path.parts, '发行包路径不安全。')
            require(member.isdir() or member.isfile(), '发行包不能包含链接或特殊设备。')
            require(member.name not in seen, '发行包含重复路径。')
            seen.add(member.name)
            roots.add(path.parts[0])
            require('.env' not in path.parts and '.piccove-ops.lock' not in path.parts, '发行包不能包含安装凭据或锁文件。')
            require(not member.mode & 0o7000, '发行包含特殊权限位。')
            total += member.size
        require(len(roots) == 1 and total < 2 * 1024**3, '发行包结构或大小无效。')
        name = roots.pop()
        require(re.fullmatch(r'piccove-v\d+\.\d+\.\d+-linux-x86_64', name), '不支持的发行包类型。')
        # Extract files ourselves: never restore archive uid/gid, symlinks or special permissions.
        for member in members:
            path = destination / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o755 if member.mode & 0o111 else 0o644)
                with os.fdopen(fd, 'wb') as target, tar.extractfile(member) as incoming:
                    shutil.copyfileobj(incoming, target)
    bundle = destination / name
    for required in ['bin/piccove-api', 'web/index.html', 'compose.yml', 'configure.py', 'install.sh', 'release.json']:
        require((bundle / required).is_file(), '发行包缺少：' + required)
    manifest = json.loads((bundle / 'release.json').read_text())
    require(manifest['target'] == 'x86_64-unknown-linux-musl' and name == f"piccove-v{manifest['version']}-linux-x86_64", '发行元数据不匹配。')
    if manifest.get('dirty'):
        print('注意：这是本地工作区构建包，不是正式 tag 构建。')
    return bundle


def install(args):
    directory = args.directory
    require(not directory.exists(), '安装目录已存在；请使用 start 或 upgrade，不能覆盖安装。')
    require(os.uname().machine == 'x86_64', '当前发行包只支持 Linux x86_64。')
    with tempfile.TemporaryDirectory(prefix='piccove-install-', dir='/var/tmp') as temporary:
        bundle = unpack(args.archive, Path(temporary))
        directory.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(bundle, directory)
    # Allow older local preview packages to receive the same operations entry point.
    if not (directory / 'piccove.sh').exists():
        shutil.copyfile(ROOT / 'piccove.sh', directory / 'piccove.sh')
        (directory / 'scripts').mkdir(exist_ok=True)
        shutil.copyfile(Path(__file__), directory / 'scripts/manage.py')
    print('正在安装到 ' + str(directory))
    run(['bash', directory / 'install.sh', '--origin', args.origin, '--port', args.port, '--project', args.project], cwd=directory)
    print('管理员：admin；初始密码保存在 ' + str(directory / '.env') + '，不在终端打印。')


def running_services(directory):
    return compose(directory, 'ps', '--status', 'running', '--services', capture_output=True, text=True).stdout.split()


def backup(directory, destination, resume=True):
    require(not destination.exists(), '备份输出已存在，拒绝覆盖。')
    active = running_services(directory)
    require('postgres' in active, '备份要求数据库运行；请先 start。')
    destination.mkdir(parents=True, mode=0o700)
    stopped = [name for name in ['api', 'web'] if name in active]
    complete = False
    try:
        if stopped:
            compose(directory, 'stop', *stopped)
        for name, command in [
            ('database.dump', ['exec', '-T', 'postgres', 'pg_dump', '-U', 'piccove', '-d', 'piccove', '-Fc']),
            ('images.tar.gz', ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'api', '-czf', '-', '-C', '/data', 'uploads']),
        ]:
            fd = os.open(destination / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                compose(directory, *command, stdout=stream)
            require((destination / name).stat().st_size > 0, '备份为空：' + name)
        for name in ['.env', 'release.json']:
            if (directory / name).is_file():
                fd = os.open(destination / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'wb') as target, (directory / name).open('rb') as incoming:
                    shutil.copyfileobj(incoming, target)
        (destination / 'SHA256SUMS').write_text(''.join(checksum(p) + '  ' + p.name + '\n' for p in sorted(destination.iterdir())))
        print('备份完成（含凭据，请妥善保存）：' + str(destination))
        complete = True
    except BaseException:
        print('备份未完成，保留现场供排查，不可用于恢复：' + str(destination))
        raise
    finally:
        if stopped and (resume or not complete):
            compose(directory, 'start', *stopped)


def upgrade(args):
    with tempfile.TemporaryDirectory(prefix='piccove-upgrade-', dir='/var/tmp') as temporary:
        bundle = unpack(args.archive, Path(temporary))
        old = json.loads((args.directory / 'release.json').read_text())
        new = json.loads((bundle / 'release.json').read_text())
        number = lambda value: tuple(int(n) for n in value.split('.'))
        require(number(new['version']) > number(old['version']), '升级必须使用更高版本；禁止同版本覆盖或回退，避免暴露私有照片。')
        # Reject existing symlinks before copying anything into the installation.
        for path in bundle.rglob('*'):
            target = args.directory / path.relative_to(bundle)
            require(not target.is_symlink(), '安装目录含冲突符号链接：' + str(target))
        backup(args.directory, args.backup, resume=False)
        try:
            for path in bundle.rglob('*'):
                target = args.directory / path.relative_to(bundle)
                if path.is_dir():
                    target.mkdir(exist_ok=True)
                else:
                    shutil.copyfile(path, target)
            compose(args.directory, 'up', '-d', '--build', '--wait', '--wait-timeout', '120')
        except BaseException:
            compose(args.directory, 'stop', 'api', 'web')
            print('升级失败，应用已停止。保留备份 ' + str(args.backup) + '；不要只回退 API 二进制。')
            raise


def release(args):
    value = current_version()
    tag = 'v' + value
    require(not output(['git', 'status', '--porcelain'], ROOT), '发版前请先提交全部修改。')
    require(output(['git', 'branch', '--show-current'], ROOT) == 'main', '请在 main 分支发版。')
    require(args.yes, '此操作将推送 main 和版本 tag，触发 GitHub 发布；确认后添加 --yes。')
    # Never move an existing tag. An atomic push prevents partially publishing branch/tag refs.
    require(not output(['git', 'tag', '--list', tag], ROOT), '本地 tag 已存在，拒绝重复创建；请检查已有发布或使用新版本。')
    require(not output(['git', 'ls-remote', '--tags', 'origin', 'refs/tags/' + tag], ROOT), '远端 tag 已存在，请使用新版本。')
    run(['git', 'tag', '-a', tag, '-m', '发布 PicCove ' + tag], ROOT)
    try:
        run(['git', 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/' + tag], ROOT)
    except subprocess.CalledProcessError:
        print('推送失败，本地 tag 保留供核查：' + tag + '；不要擅自移动已发布 tag。')
        raise
    print('已触发 GitHub Actions（仅 Linux 服务端 + Web），尚不代表远端构建完成。')
    print('查看：https://github.com/dovetaill/PicCove/actions')


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command')
    sub.add_parser('menu', help='中文交互菜单')
    b = sub.add_parser('build', help='构建服务端及 Web 发行包（普通用户）')
    b.add_argument('--output', type=Path)
    v = sub.add_parser('version', help='查看或同步版本，之后自行提交')
    v.add_argument('--set')
    r = sub.add_parser('release', help='推送 main 与 tag，由 GitHub 构建并发布')
    r.add_argument('--yes', action='store_true')
    for name in ['install', 'upgrade', 'start', 'stop', 'restart', 'status', 'logs', 'health', 'backup']:
        a = sub.add_parser(name)
        a.add_argument('--directory', type=Path, default=ROOT if (ROOT / 'compose.yml').exists() else DEFAULT_INSTALL)
        if name in ['install', 'upgrade']:
            a.add_argument('--archive', type=Path, required=True)
        if name == 'install':
            a.add_argument('--origin', default=DEFAULT_ORIGIN)
            a.add_argument('--port', type=int, default=18081)
            a.add_argument('--project', default='piccove-tu')
        if name in ['backup', 'upgrade']:
            a.add_argument('--backup', type=Path, required=True)
    return p


def menu():
    require(os.isatty(0), '非交互环境请使用显式命令；运行 bash piccove.sh --help 查看。')
    choices = {'1': 'install', '2': 'start', '3': 'stop', '4': 'restart', '5': 'status',
               '6': 'logs', '7': 'health', '8': 'backup', '9': 'upgrade', '10': 'build', '11': 'version', '12': 'release'}
    while True:
        print('\n图湾 PicCove · 服务端管理\n1 安装  2 启动  3 停止  4 重启  5 状态  6 日志\n7 健康检查  8 备份  9 升级  10 本地打包  11 版本  12 GitHub 发版\n0 退出（不操作服务）')
        selected = input('请选择：').strip()
        if selected == '0':
            return
        if selected not in choices:
            print('请选择菜单中的编号。')
            continue
        command = choices[selected]
        values = [command]
        def ask(label, default=''):
            return input(label + (f' [{default}]' if default else '') + '：').strip() or str(default)
        try:
            if command in ['install', 'upgrade']:
                default = str(default_archive()) if (ROOT / 'apps/api/Cargo.toml').exists() else ''
                values += ['--archive', ask('本地发行包路径', default)]
            if command in ['install', 'upgrade', 'start', 'stop', 'restart', 'status', 'logs', 'health', 'backup']:
                values += ['--directory', ask('安装目录', ROOT if (ROOT / 'compose.yml').exists() else DEFAULT_INSTALL)]
            if command == 'install':
                values += ['--origin', ask('网站地址', DEFAULT_ORIGIN), '--port', ask('本机端口', '18081')]
            if command in ['upgrade', 'backup']:
                from datetime import datetime
                values += ['--backup', ask('新的备份目录', '/var/backups/piccove/' + datetime.now().strftime('%Y%m%d-%H%M%S'))]
            if command == 'version':
                print('当前版本：' + current_version())
                value = ask('新版本（留空只查看）')
                if value:
                    values += ['--set', value]
            if command == 'release':
                if ask('将推送 main 和 v' + current_version() + '，输入 yes 确认') != 'yes':
                    continue
                values += ['--yes']
            dispatch(parser().parse_args(values))
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            print('操作失败：' + str(error))


def dispatch(args):
    if args.command in (None, 'menu'):
        return menu()
    if args.command == 'version':
        source()
        from release import set_version
        print(set_version(getattr(args, 'set'), ROOT) if getattr(args, 'set') else current_version())
        return
    if args.command == 'build':
        value = current_version()
        from release import build
        build((args.output or ROOT / 'release-output/server' / ('v' + value)).resolve(), Path('/var/tmp'))
        return
    if args.command == 'release':
        return release(args)
    require(not args.directory.is_symlink(), '安装目录不能是符号链接。')
    args.directory = args.directory.resolve()
    if hasattr(args, 'archive'):
        args.archive = args.archive.resolve()
    if hasattr(args, 'backup'):
        require(not args.backup.is_symlink(), '备份目录不能是符号链接。')
        args.backup = args.backup.resolve()
        require(not args.backup.is_relative_to(args.directory), '备份目录必须位于安装目录之外。')
    if args.command == 'install':
        return install(args)
    with installation(args.directory):
        if args.command == 'upgrade':
            upgrade(args)
        elif args.command == 'backup':
            backup(args.directory, args.backup)
        elif args.command == 'health':
            config = validate_install(args.directory)
            port = config['services']['web']['ports'][0]['published']
            with urllib.request.urlopen(f'http://127.0.0.1:{int(port)}/api/health', timeout=10) as response:
                require(response.read() == b'ok', '应用健康检查失败。')
            print('本机 API 健康；这不代表公网 DNS、证书或登录已验收。')
        else:
            commands = {'start': ['up', '-d', '--wait', '--wait-timeout', '120'], 'stop': ['stop'],
                        'restart': ['restart', 'api', 'web'], 'status': ['ps'], 'logs': ['logs', '--tail=100']}
            compose(args.directory, *commands[args.command])


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        dispatch(parser().parse_args())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('操作失败：' + str(error))
    except KeyboardInterrupt:
        raise SystemExit(130)
