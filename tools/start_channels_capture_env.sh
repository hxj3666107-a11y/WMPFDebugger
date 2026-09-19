#!/bin/bash

set -u

ROOT="/home/huang-justin/WMPFDebugger-linux"
UNIT="wmpf-debugger"
NODE="/home/huang-justin/.local/node-v24.20.0/bin/node"
TSNODE="$ROOT/node_modules/ts-node/dist/bin.js"

echo "========================================"
echo "      启动视频号采集环境"
echo "========================================"
echo

cd "$ROOT" || {
    echo "错误：找不到 $ROOT"
    read -rp "按回车键关闭窗口..."
    exit 1
}

ports_ready() {
    ss -ltn 2>/dev/null | grep -q ':62000 ' &&
    ss -ltn 2>/dev/null | grep -q ':9421 '
}

debugger_running() {
    systemctl --user is-active --quiet "$UNIT.service"
}

# 已经运行时直接复用
if ports_ready && debugger_running; then
    echo "WMPFDebugger 已经运行。"
    echo
    echo "62000 : READY"
    echo "9421  : READY"
    echo
    echo "========================================"
    echo "采集环境已就绪"
    echo
    echo "下一步："
    echo "1. 在微信中打开一个普通小程序"
    echo "2. 保持小程序调试会话"
    echo "3. 打开视频号"
    echo "4. 双击「保存当前视频号视频」"
    echo "========================================"
    echo
    read -rp "按回车键关闭窗口..."
    exit 0
fi

ORIGINAL_PTRACE="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null)"

if [ -z "$ORIGINAL_PTRACE" ]; then
    echo "错误：无法读取 kernel.yama.ptrace_scope"
    read -rp "按回车键关闭窗口..."
    exit 1
fi

LOG="/tmp/wmpf-debugger-$(date +%Y%m%d-%H%M%S).log"
RESTORED=0

restore_ptrace() {
    if [ "$RESTORED" -eq 0 ]; then
        sudo sysctl -w kernel.yama.ptrace_scope="$ORIGINAL_PTRACE" \
            >/dev/null 2>&1 || true
        RESTORED=1
    fi
}

trap restore_ptrace EXIT INT TERM HUP

echo "当前 ptrace_scope : $ORIGINAL_PTRACE"
echo
echo "需要管理员权限临时允许 Frida 连接微信。"
echo "Hook 完成后会立即恢复原设置。"
echo

if ! sudo -v; then
    echo
    echo "管理员权限验证失败。"
    read -rp "按回车键关闭窗口..."
    exit 1
fi

echo
echo "临时设置 ptrace_scope=0..."

if ! sudo sysctl -w kernel.yama.ptrace_scope=0 >/dev/null; then
    echo "设置失败。"
    read -rp "按回车键关闭窗口..."
    exit 1
fi

echo "启动 WMPFDebugger..."
echo "日志：$LOG"
echo

systemctl --user stop "$UNIT.service" 2>/dev/null || true
systemctl --user reset-failed "$UNIT.service" 2>/dev/null || true

if ! systemd-run \
    --user \
    --unit="$UNIT" \
    --collect \
    --working-directory="$ROOT" \
    /bin/bash -lc "exec '$NODE' '$TSNODE' src/index.ts >'$LOG' 2>&1"
then
    restore_ptrace
    trap - EXIT INT TERM HUP
    echo "WMPFDebugger systemd 启动失败。"
    read -rp "按回车键关闭窗口..."
    exit 1
fi

READY=0

for _ in $(seq 1 40); do
    if grep -q '\[frida\] script loaded' "$LOG" 2>/dev/null; then
        READY=1
        break
    fi

    if ! systemctl --user is-active --quiet "$UNIT.service"; then
        break
    fi

    sleep 0.5
done

# Frida attach 已结束，立即恢复安全策略
restore_ptrace
trap - EXIT INT TERM HUP

echo "ptrace_scope 已恢复为：$(cat /proc/sys/kernel/yama/ptrace_scope)"
echo

if [ "$READY" -ne 1 ]; then
    echo "========================================"
    echo "WMPFDebugger 启动失败"
    echo "========================================"
    echo
    cat "$LOG" 2>/dev/null
    echo
    read -rp "按回车键关闭窗口..."
    exit 1
fi

# 等待端口稳定
for _ in $(seq 1 20); do
    if ports_ready; then
        break
    fi
    sleep 0.25
done

echo "===== WMPFDebugger ====="
cat "$LOG"
echo

if ports_ready; then
    echo "62000 : READY"
    echo "9421  : READY"
    echo
    echo "========================================"
    echo "采集环境已就绪"
    echo
    echo "现在请："
    echo "1. 在微信里打开一个普通小程序"
    echo "2. 等待调试会话建立"
    echo "3. 再进入视频号"
    echo "4. 双击「保存当前视频号视频」"
    echo "========================================"
else
    echo "端口检查失败。"
    echo
    ss -ltnp 2>/dev/null | grep -E ':(62000|9421) ' || true
fi

echo
read -rp "按回车键关闭窗口..."
