#!/bin/bash
# ============================================================
# 07_内存分配/run.sh
# ============================================================
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="../../.."
COCN="$PROJECT_ROOT/bin/cocn.js"

echo "=== 07_内存分配 (100万次32字节分配+释放) ==="
gcc -O3 -march=native -o alloc_c alloc.c

echo "--- C (gcc -O3) ---"
best_c=999999
for i in 1 2 3; do
    out=$(./alloc_c)
    t=$(echo "$out" | grep TIME_C | cut-d= -f2)
    echo "  第${i}次: ${t}s"
    best_c=$(echo -e "$best_c\n$t" | sort -g | head -1)
done
echo "  C 最佳: ${best_c}s"

echo "--- coCN (解释器基线) ---"
best_co=999999
for i in 1 2 3; do
    out=$(node "$COCN" alloc.co 2>/dev/null)
    t=$(echo "$out" | grep TIME_COCN | cut-d= -f2)
    echo "  第${i}次: ${t}s"
    best_co=$(echo -e "$best_co\n$t" | sort -g | head -1)
done
echo "  coCN 最佳: ${best_co}s"

echo "RESULT|alloc|${best_c}|${best_co}"
