#!/bin/bash
# PlanTrace macOS 一键安装入口（可双击运行）
cd "$(dirname "$0")" || exit 1

SCRIPT="scripts/install-from-github-macos.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "正在从 GitHub 下载安装脚本..."
  TMP_SCRIPT="$(mktemp -t plantrace-install.XXXXXX)"
  OK=false
  for url in \
    "https://raw.githubusercontent.com/limonde/PlanTrace/main/scripts/install-from-github-macos.sh" \
    "https://cdn.jsdelivr.net/gh/limonde/PlanTrace@main/scripts/install-from-github-macos.sh"; do
    if curl -fsSL --connect-timeout 15 --retry 2 "$url" -o "$TMP_SCRIPT"; then
      SCRIPT="$TMP_SCRIPT"
      OK=true
      break
    fi
  done
  if [ "$OK" != true ]; then
    echo "安装脚本下载失败，请检查网络后重试。"
    read -n 1 -s -r -p "按任意键关闭窗口..."
    exit 1
  fi
fi

chmod +x "$SCRIPT"
/bin/bash "$SCRIPT" "$@"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo
  read -n 1 -s -r -p "安装失败，按任意键关闭窗口..."
fi
exit $STATUS
