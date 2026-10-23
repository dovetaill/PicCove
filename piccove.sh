#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case ${1:-} in
    build|version|release)
        exec python3 -B "$root/scripts/manage.py" "$@" ;;
esac
if [ -x "$root/bin/piccovectl" ]; then
    exec "$root/bin/piccovectl" --directory "$root" "$@"
fi
if command -v piccovectl >/dev/null 2>&1; then
    exec piccovectl "$@"
fi
echo '请先按 docs/OPERATIONS.md 安装 GitHub Release 中的 piccovectl。' >&2
exit 1
