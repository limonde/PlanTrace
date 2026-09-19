#!/bin/bash
# PlanTrace macOS 启动入口（可双击运行）
cd "$(dirname "$0")" || exit 1

/bin/bash "scripts/start-macos.sh"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo
  read -n 1 -s -r -p "启动失败，按任意键关闭窗口..."
fi
exit $STATUS
