#!/bin/bash
# PlanTrace macOS 一键更新入口（可双击运行）
cd "$(dirname "$0")" || exit 1

/bin/bash "scripts/update-from-github-macos.sh" "$@"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo
  read -n 1 -s -r -p "更新失败，按任意键关闭窗口..."
fi
exit $STATUS
