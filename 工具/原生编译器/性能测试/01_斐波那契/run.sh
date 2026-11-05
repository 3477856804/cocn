#!/bin/bash
# ============================================================
# 01_斐波那契/run.sh —— 编译 + 运行 + 计时
# ============================================================
set -e
cd "$(dirname "$0")"

PROJECT_ROOT="../../.."
COCN="$PROJECT_ROOT/bin/cocn.js"

echo "=== 01_斐波那契 (fib(40) 递归) ==="

# 编译 C 版本
gcc -O3 -march=native -o fib_c fib.c

# 运行 3 次取最佳
echo "--- C (gcc -O3) ---"
best_c=999999
for i in 1 2 3; do
    out=$(./fib_c)
    t=$(echo "$out" | grep TIME_C | cut-d= -f2)
    echo "  第${i}次: ${t}s  (结果: $(echo "$out" | grep 'fib(40)'))"
    best_c=$(echo -e "$best_c\n$t" | sort -g | head -1)
done
echo "  C 最佳: ${best_c}s"

# 运行 coCN 版本
echo "--- coCN (解释器基线) ---"
best_co=999999
for i in 1 2 3; do
    out=$(node "$COCN" fib.co 2>/dev/null)
    t=$(echo "$out" | grep TIME_COCN | cut-d= -f2)
    echo "  第${i}次: ${t}s"
    best_co=$(echo -e "$best_co\n$t" | sort -g | head -1)
done
echo "  coCN 最佳: ${best_co}s"

echo "RESULT|fib|${best_c}|${best_co}"
