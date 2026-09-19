#!/bin/bash
# PlanTrace macOS 一键安装（从 GitHub 下载最新源码）
# 默认安装到 ~/Library/Application Support/PlanTrace，并在桌面创建启动器
set -euo pipefail

REPO_OWNER="${PLANTRACE_REPO_OWNER:-limonde}"
REPO_NAME="${PLANTRACE_REPO_NAME:-PlanTrace}"
BRANCH="${PLANTRACE_BRANCH:-main}"
INSTALL_DIR="${PLANTRACE_INSTALL_DIR:-$HOME/Library/Application Support/PlanTrace}"
LAUNCH=true

while [ $# -gt 0 ]; do
  case "$1" in
    --no-launch) LAUNCH=false ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

step() { echo; echo "==> $1"; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/plantrace-install.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

ZIP_PATH="$TMP_ROOT/source.zip"
EXTRACT_DIR="$TMP_ROOT/extract"
PRESERVE_DIR="$TMP_ROOT/preserve"

extract_zip() {
  local zip="$1" dest="$2"
  if command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$zip" "$dest"
  else
    unzip -q "$zip" -d "$dest"
  fi
}

download_zip() {
  local out="$1"; shift
  for url in "$@"; do
    echo "下载通道: $url"
    if curl -fL --connect-timeout 15 --retry 2 --retry-delay 2 -o "$out" "$url"; then
      return 0
    fi
    echo "该通道失败，尝试下一个..."
  done
  return 1
}

step "准备安装目录"
mkdir -p "$EXTRACT_DIR" "$PRESERVE_DIR"

step "下载 $REPO_OWNER/$REPO_NAME ($BRANCH)"
download_zip "$ZIP_PATH" \
  "https://codeload.github.com/$REPO_OWNER/$REPO_NAME/zip/refs/heads/$BRANCH" \
  "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/$BRANCH.zip"

step "解压源码"
extract_zip "$ZIP_PATH" "$EXTRACT_DIR"
SOURCE_ROOT="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$SOURCE_ROOT" ]; then
  echo "解压后未找到源码目录"
  exit 1
fi

step "安装到 $INSTALL_DIR"
# 保留已有用户数据与配置
for name in data backups .env; do
  if [ -e "$INSTALL_DIR/$name" ]; then
    cp -R "$INSTALL_DIR/$name" "$PRESERVE_DIR/$name"
    echo "已备份: $name"
  fi
done

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if command -v ditto >/dev/null 2>&1; then
  ditto "$SOURCE_ROOT" "$INSTALL_DIR"
else
  cp -R "$SOURCE_ROOT"/. "$INSTALL_DIR"/
fi

for name in data backups .env; do
  if [ -e "$PRESERVE_DIR/$name" ]; then
    cp -R "$PRESERVE_DIR/$name" "$INSTALL_DIR/$name"
    echo "已恢复: $name"
  fi
done

step "安装依赖并创建启动器"
if [ "$LAUNCH" = true ]; then
  exec /bin/bash "$INSTALL_DIR/scripts/install-local-macos.sh" --project-dir="$INSTALL_DIR" --launch
else
  exec /bin/bash "$INSTALL_DIR/scripts/install-local-macos.sh" --project-dir="$INSTALL_DIR"
fi
