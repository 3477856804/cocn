#!/bin/bash
# ============================================================
# 编译工具.sh —— 用自举编译器把 10 个实用工具编译为 ELF 并运行验证
#
# 流程（每个工具）：
#   1. 拼接 词法+语法+elf+机器码 + 工具驱动
#   2. 用 COCN_BACKEND=eval 运行自举编译器 → 生成 <工具>.elf
#   3. file 校验 ELF 真实性
#   4. 运行 ELF 并打印输出
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../../.." && pwd)"
COMPILER_DIR="$PROJECT_ROOT/工具/自举编译器"

MODULES=(
    "$COMPILER_DIR/词法分析器.co"
    "$COMPILER_DIR/语法分析器.co"
    "$COMPILER_DIR/elf.co"
    "$COMPILER_DIR/机器码生成器.co"
)

TOOLS=(
    linecount
    wordcount
    temp
    compound
    guess
    fibtab
    primgen
    crypto
    base
    timer
)

pass=0
fail=0

echo "================================================"
echo " coCN 自举编译器 —— 实用工具编译验证"
echo "================================================"

for t in "${TOOLS[@]}"; do
    src="$DIR/$t.co"
    elf="$DIR/$t.elf"
    echo "------------------------------------------"
    echo "[$t] compile"

    tmp="/tmp/tool_${t}.co"
    cat "${MODULES[@]}" "$DIR/工具驱动.co" > "$tmp"

    COCN_PROGRAM="$src" COCN_ELF="$elf" COCN_BACKEND=eval \
        timeout 90 node "$PROJECT_ROOT/bin/cocn.js" "$tmp" > /tmp/tool_run.txt 2>&1
    rc=$?

    if [ $rc -ne 0 ]; then
        echo "  [FAIL] compiler exit=$rc"
        cat /tmp/tool_run.txt
        fail=$((fail + 1))
        continue
    fi
    if [ ! -f "$elf" ]; then
        echo "  [FAIL] no ELF produced"
        fail=$((fail + 1))
        continue
    fi

    elfinfo="$(file "$elf")"
    echo "  ELF: $elfinfo"
    if ! echo "$elfinfo" | grep -q "ELF 64-bit"; then
        echo "  [FAIL] not a valid ELF64"
        fail=$((fail + 1))
        continue
    fi

    # run the produced ELF directly
    echo "  --- run output ---"
    "$elf" | sed 's/^/    /'
    echo "  [OK]"
    pass=$((pass + 1))
    rm -f "$tmp" /tmp/tool_${t}.co.hex "$elf.hex"
done

echo "================================================"
echo " result: ok=$pass fail=$fail total=${#TOOLS[@]}"
echo "================================================"
rm -f /tmp/tool_run.txt
[ "$fail" -eq 0 ]
