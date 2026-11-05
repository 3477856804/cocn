#!/bin/sh
# ============================================================
# coCN 可执行入口（sh 薄壳）
#
# 为什么是 sh 而不是 node：npm 全局安装会把 bin 字段做成符号链接直接指向
# 本文件，执行时由内核读首行 shebang。写 "#!/usr/bin/env node" 在
# Linux/macOS 没问题，但 **Android/Termux 没有 /usr/bin/env**（根分区只读），
# 于是全局安装的 cocn 命令一执行就报 "No such file or directory" ——
# 链接在、文件在，就差一个 shebang。改用 "#!/bin/sh" 后，Android 自带的
# toybox sh 能直接跑本文件。
#
# 真正的入口逻辑在 bin/入口.js（纯 JS）。本薄壳只做三件事：
#   1) 找到 node（不写死绝对路径：nvm / volta / 系统包 / Termux 各不相同）；
#   2) 把参数原样转交；
#   3) 用 exec 替换自身，保证退出码与信号语义和直接跑 node 一致。
#
# 变量名必须用 ASCII：Android 的 toybox sh 不支持非 ASCII 变量名
# （实测 `入口=x` 会被当成命令执行，报 "入口=x: not found"，
#   而变量本身取不到值 —— 于是路径判断永远失败）。
# ============================================================

# 入口逻辑与本文件同级（bin/入口.js）
# 注意：npm 全局安装会把本文件做成符号链接到 <prefix>/bin/cocn，
# 此时 $0 是链接路径（/usr/bin/cocn），dirname 得到的是链接所在目录，
# 找不到真正的入口文件。所以先解析符号链接再取目录。
# readlink -f 在 Android toybox 与 GNU coreutils 都有；不可用时退回 $0。
_self="$0"
if command -v readlink >/dev/null 2>&1; then
    _resolved=$(readlink -f "$0" 2>/dev/null)
    [ -n "$_resolved" ] && _self="$_resolved"
fi
SELF_DIR=$(dirname "$_self")
ENTRY_JS="$SELF_DIR/入口.js"

# node 路径：优先 PATH 里的 node，其次 nodejs
NODE=$(command -v node 2>/dev/null)
[ -z "$NODE" ] && NODE=$(command -v nodejs 2>/dev/null)

if [ -z "$NODE" ]; then
    echo "[coCN] 未找到 node —— coCN 需要 Node.js 运行（建议 Node 18+）。" >&2
    echo "       装好 node 后重试；或设置 NODE 指向 node 可执行文件。" >&2
    exit 127
fi

if [ ! -f "$ENTRY_JS" ]; then
    echo "[coCN] 入口文件缺失: $ENTRY_JS" >&2
    exit 1
fi

# 栈软限：自解释器每层语言调用约吃 17KB C 栈，默认 8MB 只能撑 ~460 层，
# 合法递归（边界测试 累加到(500)）会被宿主栈守卫误杀；而且宿主守卫触发的
# 错误跨 .co 边界不可捕获，异常测试的栈守卫断言正是查这个。原生启动器
# （启动器.c）会把软限抬到 64MB；sh 入口这里同样处理：只抬不降，失败无妨。
# 注意：变量名必须用 ASCII（见文件头 toybox sh 的限制）。
_ss=$(ulimit -s 2>/dev/null)
case "$_ss" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$_ss" -lt 65536 ] 2>/dev/null; then
      ulimit -s 65536 2>/dev/null || {
        _hs=$(ulimit -Hs 2>/dev/null)
        case "$_hs" in
          ''|*[!0-9]*) ;;
          *) ulimit -s "$_hs" 2>/dev/null || true ;;
        esac
      }
    fi
    ;;
esac

# exec 替换当前进程：退出码/信号与直接跑 node 完全一致
exec "$NODE" "$ENTRY_JS" "$@"
