"""PicCove 开发者打包和发版入口；服务器运维由 Rust piccovectl 提供。"""
import argparse
from pathlib import Path
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]


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
    b = sub.add_parser('build', help='构建服务端及 Web 发行包（普通用户）')
    b.add_argument('--output', type=Path)
    v = sub.add_parser('version', help='查看或同步版本，之后自行提交')
    v.add_argument('--set')
    r = sub.add_parser('release', help='推送 main 与 tag，由 GitHub 构建并发布')
    r.add_argument('--yes', action='store_true')
    return p


def dispatch(args):
    if args.command is None:
        return parser().print_help()
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


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        dispatch(parser().parse_args())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('操作失败：' + str(error))
    except KeyboardInterrupt:
        raise SystemExit(130)
