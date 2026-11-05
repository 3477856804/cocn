#!/bin/bash
# ============================================================
# 微基准/run.sh —— 运行所有微基准
# ============================================================
set -e
cd "$(dirname "$0")"
PROJECT_ROOT="../../.."
COCN="$PROJECT_ROOT/bin/cocn.js"

echo "=== 微基准测试 ==="

for name in 函数调用 整数运算 浮点运算 内存访问 分支预测; do
    echo ""
    echo "--- ${name} ---"
    gcc -O3 -march=native -o "${name}_c" "${name}.c"

    # C: 3次取最佳
    best_c=999999
    for i in 1 2 3; do
        t=$(./"${name}_c" | grep TIME_C | cut-d= -f2)
        best_c=$(echo -e "$best_c\n$t" | sort -g | head -1)
    done
    echo "  C 最佳: ${best_c}s"

    # coCN: 3次取最佳
    best_co=999999
    for i in 1 2 3; do
        t=$(node "$COCN" "${name}.co" 2>/dev/null | grep TIME_COCN | cut-d= -f2)
        best_co=$(echo -e "$best_co\n$t" | sort -g | head -1)
    done
    echo "  coCN 最佳: ${best_co}s"

    echo "MICRORESULT|${name}|${best_c}|${best_co}"
done
