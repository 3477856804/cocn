#!/bin/sh
# L2 自举门禁：自举编译器编译自身，再用生成的 L2 编译器编译示例，逐字节比对解释器。
# 这验证「语言的编译器能编译自身源码」的完整自举（L2）。
set -e
CO="${1:-./co}"
DEMO="${2:-自举示例.co}"
cd "$(dirname "$0")/.."

echo "---- L2 自举流水线 ----"

# 1) 用 C 版编译器编译「coCN 写的编译器」→ 自举cc
"$CO" --编译 自举编译器.co 自举cc >/dev/null 2>&1 || { echo "编译 自举编译器.co 失败"; exit 1; }
echo "① co --编译 自举编译器.co -> 自举cc   完成"

# 2) 自举cc 编译自身源码 → L2 编译器（自举输出）
cp 自举编译器.co 自举输入.co
WARN=$(./自举cc 2>&1 | grep -c "warning" || true)
if [ "$WARN" != "0" ]; then
    echo "自举cc 编译自身时产生 $WARN 个警告"; exit 1
fi
echo "② 自举cc 编译自身(自举编译器.co) -> L2编译器   完成（零警告）"

# 3) 复制 L2 编译器为 l2cc（避免运行时覆盖自身），用它编译示例
cp 自举输出 l2cc
cp "$DEMO" 自举输入.co
./l2cc >/dev/null 2>&1 || { echo "L2编译器 编译示例失败"; exit 1; }
echo "③ L2编译器 编译示例 -> 自举输出   完成"

# 4) L2 产物 vs 解释器：stdout 必须逐字节一致
"$CO" 自举输入.co > /tmp/l2期望.txt 2>&1
./自举输出 > /tmp/l2实际.txt 2>&1
if cmp -s /tmp/l2期望.txt /tmp/l2实际.txt; then
    echo "④ L2自举产物与解释器输出逐字节一致   通过"
else
    echo "差异："
    diff /tmp/l2期望.txt /tmp/l2实际.txt
    exit 1
fi

# 清理 L2 临时副本
rm -f l2cc
