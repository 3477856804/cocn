#!/bin/bash
# ============================================================
# 10_数值积分/run.sh
# ============================================================
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="../../.."
COCN="$PROJECT_ROOT/bin/cocn.js"

echo "=== 10_数值积分 (蒙特卡洛求π, 1亿采样) ==="
gcc -O3 -march=native -o pi_c pi.c

echo "--- C (gcc -O3) ---"
best_c=999999
for i in 1 2 3; do
    out=$(./pi_c)
    t=$(echo "$out" | grep TIME_C | cut-d= -f2)
    echo "  第${i}次: ${t}s"
    best_c=$(echo -e "$best_c\n$t" | sort -g | head -1)
done
echo "  C 最佳: ${best_c}s"

echo "--- coCN (解释器基线) ---"
best_co=999999
for i in 1 2 3; do
    out=$(node "$COCN" pi.co 2>/dev/null)
    t=$(echo "$out" | grep TIME_COCN | cut-d= -f2)
    echo "  第${i}次: ${t}s"
    best_co=$(echo -e "$best_co\n$t" | sort -g | head -1)
done
echo "  coCN 最佳: ${best_co}s"

echo "RESULT|pi|${best_c}|${best_co}"
