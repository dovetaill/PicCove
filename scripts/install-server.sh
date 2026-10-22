#!/usr/bin/env bash
set -Eeuo pipefail
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$release_dir"
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    echo '在解压后的发行包内运行：bash install.sh --origin https://img.example.com --contact mailto:admin@example.com'
    echo '本机试用：bash install.sh --origin http://127.0.0.1:8080'
    echo '已有 .env：bash install.sh --resume（不重新生成密码）'
    exit 0
fi
[[ -f compose.yml && -f bin/piccove-api ]] || { echo '请从完整发行包运行 install.sh。' >&2; exit 1; }
command -v python3 >/dev/null || { echo '需要 Python 3.11+。' >&2; exit 1; }
docker compose version >/dev/null
if [[ ${1:-} == --resume ]]; then
    [[ $# == 1 && -f .env ]] || { echo '--resume 需要现有 .env。' >&2; exit 1; }
else
    python3 -B configure.py "$@"
fi
project=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
for container in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    owner=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
    [[ "$owner" == "$release_dir" ]] || { echo "项目 $project 属于其他安装目录，拒绝覆盖。" >&2; exit 1; }
done
docker compose up -d --build --wait --wait-timeout 120
printf '\n安装完成。管理员用户名：admin；请从当前 .env 安全读取初始密码。\n'
printf '登录后修改密码，并移除 .env 中的 PICCOVE_ADMIN_PASSWORD 值，再执行 docker compose up -d。\n'
printf '查看状态：docker compose ps；查看日志：docker compose logs --tail=100\n'
