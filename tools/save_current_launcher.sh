#!/bin/bash
export PATH="$HOME/.local/node-v24.20.0/bin:$PATH"

cd /home/huang-justin/WMPFDebugger-linux || exit 1

echo "========================================"
echo "      保存当前视频号视频"
echo "========================================"
echo

node tools/wxchannels_save_current.js
status=$?

echo
echo "========================================"

if [ "$status" -eq 0 ]; then
    echo "保存完成"
    echo "文件目录："
    echo "/home/huang-justin/WMPFDebugger-linux/downloads"
else
    echo "保存失败，请查看上面的错误信息"
fi

echo "========================================"
echo
read -rp "按回车键关闭窗口..."
