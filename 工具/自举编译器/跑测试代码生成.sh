#!/bin/bash
# ============================================================
# 跑测试.sh —— 自举代码生成器端到端测试
# 对每个测试程序：coCN生成汇编 -> gcc汇编链接 -> 运行 -> 比对
# ============================================================
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
RT="$ROOT/工具/原生编译器/运行时"
WORK=/tmp/自举代码gen测试
mkdir -p "$WORK"

# 合并自举前端 + 代码生成器 + 测试驱动
MERGE="$WORK/合并.co"
cat "$DIR/词法分析器.co" \
    "$DIR/语法分析器.co" \
    "$DIR/输出JSON.co" \
    "$DIR/代码生成器.co" \
    "$DIR/测试代码生成器.co" > "$MERGE"

# 预编译运行时临时.o
gcc -no-pie -c -O2 -o "$WORK/临时.o" "$RT/临时.c"

# 参数: 测试文件 期望输出
run_one() {
    local src="$1"
    local expected="$2"
    local base="$(basename "$src" .co)"
    local asm="$WORK/$base.s"
    local obj="$WORK/$base.o"
    local bin="$WORK/$base"
    echo "=== $base ==="
    COCN_INPUT="$src" COCN_OUTPUT="$asm" COCN_BACKEND=eval node "$ROOT/bin/cocn.js" "$MERGE"
    gcc -no-pie -c -o "$obj" "$asm"
    gcc -no-pie -o "$bin" "$obj" "$WORK/临时.o"
    local out="$("$bin")"
    if [ "$out" == "$expected" ]; then
        echo "  PASS: 输出='$out'"
    else
        echo "  FAIL: 期望='$expected' 实际='$out'"
    fi
}

run_one "$DIR/测试/t_hello.co"   "Hello, World!"
run_one "$DIR/测试/t_arith.co"  "7"
run_one "$DIR/测试/t_sum.co"    "5050"
run_one "$DIR/测试/t_fib.co"    "55"
run_one "$DIR/测试/t_fact.co"   "3628800"
echo "完成"
