#!/bin/sh
# 自举编译.sh —— 用 coCN 自己写的编译器把 .co 编成机器码
#
#   sh 工具/自举编译器/自举编译.sh 程序.co 输出可执行文件
#
# 与 bin/cocn --编译 的区别：
#   --编译        走 工具/原生编译器/机器码生成器.js（JS 实现，速度快）
#   本脚本        走 工具/自举编译器/*.co（coCN 实现，即「语言自己编译自己」）
#
# 两者产物都是静态 x86-64 ELF，不依赖 gcc/汇编器；对同一程序输出逐字节一致。
#
# 注意：本脚本用 POSIX sh，变量名必须 ASCII（dash 不认中文标识符）。
set -e

IN="$1"
OUT="$2"
if [ -z "$IN" ] || [ -z "$OUT" ]; then
    echo "用法: sh 工具/自举编译器/自举编译.sh 程序.co 输出可执行文件" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 拼接自举编译器：词法 -> 语法 -> ELF -> 机器码 -> 驱动
cat 工具/自举编译器/词法分析器.co \
    工具/自举编译器/语法分析器.co \
    工具/自举编译器/elf.co \
    工具/自举编译器/机器码生成器.co \
    > "$TMP/compiler.co"

# 驱动：读 COCN_PROGRAM，把 ELF 字节写成十六进制文件
# 与 工具/自举编译器/自举验证/编译驱动.co 使用同一套接口
cat >> "$TMP/compiler.co" <<'EOF'

让 十六字母表 = "0123456789abcdef"

函数 字节转hex(列表 字节) -> 字符串
    字符串 s = ""
    对于 i 从 0 到 长度(字节) - 1 循环
        整数 b = 字节[i] & 255
        s = s + 十六字母表[b >> 4] + 十六字母表[b & 15]
    结束
    返回 s
结束

让 源 = 读取文件(环境变量("COCN_PROGRAM"))
让 ast = 解析源(源)
让 字节 = 编译到ELF(ast)
写入文件(环境变量("COCN_HEX"), 字节转hex(字节))
EOF

# 必须显式走 eval 通道：这台编译器用了字典/尝试/匿名函数，
# 原生前端不支持，默认通道会先尝试直译再回退，过程中会触发宿主字典上限。
COCN_BACKEND=eval \
COCN_PROGRAM="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")" \
COCN_HEX="$TMP/program.hex" \
    "$ROOT/bin/cocn.js" "$TMP/compiler.co"

# 十六进制 -> 二进制。xxd 在 Termux / 精简容器里常常缺失，优先 perl。
if command -v xxd >/dev/null 2>&1; then
    xxd -r -p "$TMP/program.hex" "$OUT"
else
    perl -e 'open(F,"<",$ARGV[0]); local $/; $h=<F>; close F;
             open(O,">",$ARGV[1]); print O pack("H*",$h); close O;' \
        "$TMP/program.hex" "$OUT"
fi
chmod +x "$OUT"

echo "[自举编译] $IN -> $OUT 完成：coCN 写的编译器直出机器码"
