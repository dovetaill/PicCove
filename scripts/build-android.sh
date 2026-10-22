#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(id -u) != 0 ]] || { echo '请使用普通开发账号构建。' >&2; exit 1; }
[[ $# == 1 ]] || { echo '用法：bash scripts/build-android.sh <新的 APK 输出目录>' >&2; exit 1; }
[[ -d ${ANDROID_HOME:-}/platforms/android-36 && -d ${ANDROID_HOME:-}/build-tools/35.0.0 ]] || { echo '需要 ANDROID_HOME 指向已安装 Android 36 平台和 Build Tools 35.0.0 的 SDK。' >&2; exit 1; }
output=$(realpath -m -- "$1")
[[ ! -e "$output" ]] || { echo '输出目录已存在，拒绝覆盖。' >&2; exit 1; }
work=$(mktemp -d /var/tmp/piccove-android-build-XXXXXX)
build_pid=''
cleanup() {
    if [[ -n "$build_pid" ]]; then
        kill -TERM -- "-$build_pid" 2>/dev/null || true
        wait "$build_pid" 2>/dev/null || true
    fi
    rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$work/source" "$work/tmp" "$work/android-user"
tar -C "$root/apps/android" --exclude='./.gradle' --exclude='./build' --exclude='./app/build' --exclude='./local.properties' -cf - . | tar -C "$work/source" -xf -
export GRADLE_USER_HOME=$work/gradle ANDROID_USER_HOME=$work/android-user TMPDIR=$work/tmp
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Duser.home=$work/android-user -Djava.io.tmpdir=$work/tmp"
cd "$work/source"
setsid bash gradlew --no-daemon -Djava.io.tmpdir="$work/tmp" testDebugUnitTest lintDebug assembleDebug &
build_pid=$!
printf '构建工作目录：%s；进程组：%s\n' "$work" "$build_pid"
wait "$build_pid"
build_pid=''
mkdir -p "$output"
cp app/build/outputs/apk/debug/app-debug.apk "$output/piccove-android-debug.apk"
(cd "$output" && sha256sum piccove-android-debug.apk > SHA256SUMS)
echo "APK：$output/piccove-android-debug.apk（测试签名，不用于商店发布）"
