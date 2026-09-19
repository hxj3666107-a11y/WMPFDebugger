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

miniapp_connected() {
    ss -tnH 2>/dev/null | awk '$1 == "ESTAB" && ($4 ~ /:9421$/ || $5 ~ /:9421$/) { found=1 } END { exit !found }'
}

find_wmpf_runtime() {
    local wechat_pid

    wechat_pid="$(pgrep -xo wechat 2>/dev/null || true)"
    [ -n "$wechat_pid" ] || return 1

    ps --ppid "$wechat_pid" -o pid=,stat=,comm= | awk '$3 == "WeChatAppEx" && $2 !~ /^Z/ { print $1; exit }'
}

rebuild_wmpf_runtime() {
    local old_pid new_pid stable_pid="" stable_count=0

    old_pid="$(find_wmpf_runtime)"
    if [ -z "$old_pid" ]; then
        echo "找不到正在运行的 WMPF Runtime。"
        return 1
    fi

    echo "准备重建 WMPF Runtime：PID=$old_pid"

    if ! kill -TERM "$old_pid"; then
        echo "无法停止 WMPF Runtime：PID=$old_pid"
        return 1
    fi

    for _ in $(seq 1 60); do
        new_pid="$(find_wmpf_runtime)"

        if [ -n "$new_pid" ] && [ "$new_pid" != "$old_pid" ]; then
            if [ "$new_pid" = "$stable_pid" ]; then
                stable_count=$((stable_count + 1))
            else
                stable_pid="$new_pid"
                stable_count=1
            fi

            if [ "$stable_count" -ge 4 ]; then
                echo "WMPF Runtime 已重建：$old_pid -> $new_pid"
                return 0
            fi
        else
            stable_pid=""
            stable_count=0
        fi

        sleep 0.25
    done

    echo "等待新的稳定 WMPF Runtime 超时。"
    return 1
}

# 已经运行时直接复用
if ports_ready && debugger_running; then
    echo "WMPFDebugger 已经运行。"
    echo
    echo "62000 : READY"
    if miniapp_connected; then
        echo "9421  : CONNECTED"
        echo
        echo "========================================"
        echo "采集环境已就绪"
        echo
        echo "下一步："
        echo "1. 保持当前小程序调试会话"
        echo "2. 打开视频号"
        echo "3. 双击「保存当前视频号视频」"
        echo "========================================"
        echo
        read -rp "按回车键关闭窗口..."
        exit 0
    else
        echo "9421  : LISTENING / NO MINIAPP SESSION"
        echo
        echo "========================================"
        echo "调试器已运行，但小程序调试会话尚未建立"
        echo
        echo "请先在微信中打开一个普通小程序。"
        echo
        echo "如果已经打开普通小程序仍然没有连接，"
        echo "输入 r 可重建 WMPF Runtime 并重新挂载调试器。"
        echo "直接按回车则保持现状退出。"
        echo "========================================"
        echo

        read -rp "选择 [r/回车]：" recovery

        if [ "$recovery" != "r" ] && [ "$recovery" != "R" ]; then
            exit 0
        fi

        echo
        echo "停止当前 WMPFDebugger..."
        systemctl --user stop "$UNIT.service" 2>/dev/null || true
        sleep 1

        if ! rebuild_wmpf_runtime; then
            echo
            echo "WMPF Runtime 重建失败。"
            read -rp "按回车键关闭窗口..."
            exit 1
        fi

        echo
        echo "Runtime 已重建，准备重新挂载 WMPFDebugger..."
        echo
    fi
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
    if miniapp_connected; then
        echo "9421  : CONNECTED"
        echo
        echo "========================================"
        echo "采集环境已就绪"
        echo
        echo "现在请："
        echo "1. 保持当前小程序调试会话"
        echo "2. 再进入视频号"
        echo "3. 双击「保存当前视频号视频」"
        echo "========================================"
    else
        echo "9421  : LISTENING / WAITING FOR MINIAPP"
        echo
        echo "========================================"
        echo "WMPFDebugger 已启动，正在等待小程序调试连接"
        echo
        echo "现在请："
        echo "1. 在微信里打开一个普通小程序"
        echo "2. 等待 9421 建立调试连接"
        echo "3. 再进入视频号"
        echo "========================================"
    fi
else
    echo "端口检查失败。"
    echo
    ss -ltnp 2>/dev/null | grep -E ':(62000|9421) ' || true
fi

echo
read -rp "按回车键关闭窗口..."
