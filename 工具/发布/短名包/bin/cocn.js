#!/bin/sh
# ============================================================
# cocn 短名入口（npm install -g colang）
#
# 本文件只是转发：真正的实现与源码在 @yeyelailou/co 里。
# 这样短名包与官方包共用同一份源码，不会出现两个版本各发各的。
#
# 为什么是 sh 而不是 node 脚本：Android/Termux 没有 /usr/bin/env，
# shebang 写 #!/usr/bin/env node 的全局命令会直接不可执行。
# ============================================================

_self="$0"
if command -v readlink >/dev/null 2>&1; then
    _resolved=$(readlink -f "$0" 2>/dev/null)
    [ -n "$_resolved" ] && _self="$_resolved"
fi
SELF_DIR=$(dirname "$_self")

# 找 @yeyelailou/co 的安装位置（npm 扁平化 / 嵌套 / 全局三种布局都覆盖）
PKG=""
for d in "$SELF_DIR/.." "$SELF_DIR/../.." "$SELF_DIR/../../.." "$SELF_DIR"; do
    for p in "$d/node_modules/@yeyelailou/co" "$d/@yeyelailou/co"; do
        if [ -f "$p/bin/入口.js" ]; then
            PKG="$p"
            break
        fi
    done
    [ -n "$PKG" ] && break
done

if [ -z "$PKG" ]; then
    echo "[cocn] 未找到 @yeyelailou/co —— 请重装：npm install -g @yeyelailou/co" >&2
    exit 1
fi

NODE=$(command -v node 2>/dev/null)
[ -z "$NODE" ] && NODE=$(command -v nodejs 2>/dev/null)
if [ -z "$NODE" ]; then
    echo "[cocn] 未找到 node —— cocn 需要 Node.js 运行（建议 Node 18+）。" >&2
    exit 127
fi

exec "$NODE" "$PKG/bin/入口.js" "$@"
