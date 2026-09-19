#!/bin/bash
# PlanTrace macOS 本地安装：检查 Node.js、安装依赖、创建桌面启动器
# 用法: bash scripts/install-local-macos.sh [--project-dir=路径] [--launch] [--no-shortcut] [--skip-node-install]
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH=false
CREATE_SHORTCUT=true
SKIP_NODE_INSTALL=false

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir=*)      PROJECT_DIR="${1#*=}" ;;
    --launch)             LAUNCH=true ;;
    --no-shortcut)        CREATE_SHORTCUT=false ;;
    --skip-node-install)  SKIP_NODE_INSTALL=true ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

step() { echo; echo "==> $1"; }

get_node_version() {
  command -v node >/dev/null 2>&1 || return 1
  node -v 2>/dev/null | sed 's/^v//' | cut -d- -f1
}

node_version_ok() {
  local v major minor
  v="$(get_node_version)" || return 1
  major="${v%%.*}"
  minor="$(echo "$v" | cut -d. -f2)"
  [ "$major" -gt 22 ] && return 0
  [ "$major" -eq 22 ] && [ "$minor" -ge 12 ] && return 0
  [ "$major" -eq 20 ] && [ "$minor" -ge 19 ] && return 0
  return 1
}

install_node() {
  if [ "$SKIP_NODE_INSTALL" = true ]; then
    echo "需要 Node.js 20.19+ 或 22.12+，但已跳过自动安装。"
    exit 1
  fi
  if command -v brew >/dev/null 2>&1; then
    step "使用 Homebrew 安装 Node.js LTS"
    brew install node
    hash -r 2>/dev/null || true
    return 0
  fi
  echo "未找到 Homebrew，请先安装 Homebrew（https://brew.sh）或手动安装 Node.js："
  echo "  https://nodejs.org/en/download"
  open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
  exit 1
}

step "检查 Node.js"
if ! node_version_ok; then
  install_node
  if ! node_version_ok; then
    echo "Node.js 已安装/更新，但当前终端仍未识别，请重新打开终端后再次运行。"
    exit 1
  fi
fi
echo "Node.js $(get_node_version) ✓"

step "安装依赖"
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci --loglevel warn || npm install --loglevel warn
else
  npm install --loglevel warn
fi

if [ "$CREATE_SHORTCUT" = true ]; then
  step "创建桌面启动器"
  DESKTOP="$HOME/Desktop"
  mkdir -p "$DESKTOP"
  LAUNCHER="$DESKTOP/PlanTrace.command"
  cat > "$LAUNCHER" << EOF
#!/bin/bash
cd "$PROJECT_DIR"
exec /bin/bash "$PROJECT_DIR/scripts/start-macos.sh"
EOF
  chmod +x "$LAUNCHER"
  echo "已创建: $LAUNCHER"
fi

if [ "$LAUNCH" = true ]; then
  step "启动 PlanTrace"
  exec /bin/bash "$PROJECT_DIR/scripts/start-macos.sh"
fi

echo
echo "PlanTrace 安装完成"
