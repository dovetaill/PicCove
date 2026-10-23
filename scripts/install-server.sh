#!/bin/sh
# Thin bootstrap only; installation and operations are implemented by Rust piccovectl.
set -eu
case ${1:-} in
    -h|--help)
        echo 'sh install-server.sh install --origin https://你的域名'
        echo 'sh install-server.sh update'
        echo '可选：--version X.Y.Z；其他参数传给 piccovectl。需要 Docker Engine、Compose、Buildx、curl、sha256sum。'
        exit 0 ;;
    install|update|upgrade) ;;
    *) echo '请指定 install 或 update。' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo '仅支持 Linux x86_64。' >&2; exit 1; }
for tool in curl sha256sum docker; do
    command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool。" >&2; exit 1; }
done
docker compose version >/dev/null
docker buildx version >/dev/null
version=
previous=
for argument in "$@"; do
    if [ "$previous" = --version ]; then version=$argument; fi
    previous=$argument
done
base=https://github.com/dovetaill/PicCove/releases/latest/download
if [ -n "$version" ]; then
    version=${version#v}
    # Do not interpolate arbitrary paths into the download URL.
    printf '%s\n' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || { echo '版本必须为 X.Y.Z。' >&2; exit 1; }
    base=https://github.com/dovetaill/PicCove/releases/download/v$version
fi
work=$(mktemp -d /var/tmp/piccove-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fLsS --proto '=https' --proto-redir '=https' --retry 2 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
curl -fLsS --proto '=https' --proto-redir '=https' --retry 2 "$base/piccovectl-linux-x86_64" -o "$work/piccovectl-linux-x86_64"
(cd "$work" && awk '$2 == "piccovectl-linux-x86_64" {print; n++} END {if(n != 1) exit 1}' SHA256SUMS > CLI.SHA256SUMS && sha256sum -c CLI.SHA256SUMS)
chmod 700 "$work/piccovectl-linux-x86_64"
"$work/piccovectl-linux-x86_64" "$@"
