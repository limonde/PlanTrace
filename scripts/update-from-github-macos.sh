#!/bin/bash
# PlanTrace macOS 一键更新（从 GitHub 拉取最新源码，保留 data/ 与 backups/）
set -euo pipefail

REPO_OWNER="${PLANTRACE_REPO_OWNER:-limonde}"
REPO_NAME="${PLANTRACE_REPO_NAME:-PlanTrace}"
BRANCH="${PLANTRACE_BRANCH:-main}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { echo; echo "==> $1"; }

# 安全检查：必须在 PlanTrace 项目目录内运行，避免误写其他目录
if [ ! -f "$PROJECT_DIR/package.json" ] || [ ! -d "$PROJECT_DIR/scripts" ]; then
  echo "未在 $PROJECT_DIR 找到 PlanTrace 项目（缺少 package.json），请在项目目录内运行该脚本。"
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/plantrace-update.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

ZIP_PATH="$TMP_ROOT/source.zip"
EXTRACT_DIR="$TMP_ROOT/extract"

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

step "下载 $REPO_OWNER/$REPO_NAME ($BRANCH)"
mkdir -p "$EXTRACT_DIR"
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

step "应用更新到 $PROJECT_DIR（不会覆盖 data/ backups/ .env）"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'data' --exclude 'backups' --exclude 'node_modules' \
    --exclude 'dist' --exclude '.env' --exclude '.git' \
    "$SOURCE_ROOT"/ "$PROJECT_DIR"/
else
  # 无 rsync 时的保守方案：逐个覆盖代码目录/文件，保留数据
  for item in src server public scripts deploy static index.html vite.config.js eslint.config.js; do
    if [ -e "$SOURCE_ROOT/$item" ]; then
      rm -rf "${PROJECT_DIR:?}/$item"
      cp -R "$SOURCE_ROOT/$item" "$PROJECT_DIR/$item"
    fi
  done
  for file in package.json package-lock.json README.md DEPLOY.md DEPLOY-CLOUD.md LICENSE .gitignore Dockerfile docker-compose.yml .dockerignore .env.example \
              install.bat start.bat Install-PlanTrace-From-GitHub.bat Update-PlanTrace.bat \
              start-macOS.command Update-PlanTrace-macOS.command Install-PlanTrace-From-GitHub-macOS.command; do
    if [ -f "$SOURCE_ROOT/$file" ]; then
      cp "$SOURCE_ROOT/$file" "$PROJECT_DIR/$file"
    fi
  done
fi

step "安装/更新依赖"
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci --loglevel warn || npm install --loglevel warn
else
  npm install --loglevel warn
fi

echo
echo "更新完成！如果应用正在运行："
echo "  - 代码更新会自动热重载，刷新页面即可"
echo "  - 若更新了 vite.config.js 或依赖，请在终端按 Ctrl+C 后重新启动"
