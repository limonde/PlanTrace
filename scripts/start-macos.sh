#!/bin/bash
# PlanTrace macOS 启动脚本
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f "node_modules/vite/bin/vite.js" ]; then
  echo "依赖缺失，正在自动安装..."
  /bin/bash "$PROJECT_DIR/scripts/install-local-macos.sh" --project-dir="$PROJECT_DIR" --no-shortcut
fi

echo
echo "PlanTrace 正在启动，浏览器地址: http://localhost:5173"
echo "使用期间请保持此终端窗口打开（关闭窗口即停止服务）"
echo

exec npm run start
