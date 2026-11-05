#!/bin/bash
# ============================================================
# 汇总.sh —— 运行所有10个基准测试，生成对比表
# 用法: bash 原生编译器/性能测试/汇总.sh
# ============================================================
set -e
cd "$(dirname "$0")"

PROJECT_ROOT="../.."
COCN="$PROJECT_ROOT/bin/cocn.js"
OUTPUT="结果.md"
TMP="/tmp/cocn_bench_results.txt"
> "$TMP"

# 基准列表：目录名|英文键|中文显示名
BENCHMARKS=(
    "01_斐波那契|fib|斐波那契(递归40)"
    "02_循环累加|sum|循环累加(1亿)"
    "03_矩阵乘法|matmul|矩阵乘法(200²)"
    "04_快速排序|qsort|快速排序(100万)"
    "05_字符串处理|string|字符串处理(10万)"
    "06_哈希表|hashtable|哈希表(100万)"
    "07_内存分配|alloc|内存分配(100万)"
    "08_二叉树遍历|tree|二叉树遍历(100万)"
    "09_正则匹配|kmp|KMP匹配(10万)"
    "10_数值积分|pi|蒙特卡洛π(1亿)"
)

echo "============================================"
echo " coCN 原生编译器性能基准测试"
echo " C (gcc -O3 -march=native) vs coCN 解释器"
echo "============================================"
echo ""

for entry in "${BENCHMARKS[@]}"; do
    IFS='|' read -r dir key label <<< "$entry"
    echo ">>> 运行 ${dir} ..."

    cd "$dir"

    c_src=$(ls *.c 2>/dev/null | head -1)
    co_src=$(ls *.co 2>/dev/null | head -1)

    if [ -z "$c_src" ] || [ -z "$co_src" ]; then
        echo "  [跳过] 缺少源文件"
        cd ..
        continue
    fi

    c_bin="${key}_c"

    # 编译 C
    gcc -O3 -march=native -o "$c_bin" "$c_src" -lm 2>/dev/null || gcc -O3 -march=native -o "$c_bin" "$c_src"

    # C: 3次取最佳
    best_c=999999
    for i in 1 2 3; do
        t=$(timeout 120 ./"$c_bin" 2>/dev/null | grep TIME_C | cut-d= -f2)
        if [ -n "$t" ]; then
            best_c=$(echo -e "$best_c\n$t" | sort -g | head -1)
        fi
    done

    # coCN: 3次取最佳
    best_co=999999
    for i in 1 2 3; do
        t=$(timeout 300 node "$COCN" "$co_src" 2>/dev/null | grep TIME_COCN | cut-d= -f2)
        if [ -n "$t" ]; then
            best_co=$(echo -e "$best_co\n$t" | sort -g | head -1)
        fi
    done

    echo "  C=${best_c}s  coCN=${best_co}s"
    echo "${key}|${best_c}|${best_co}" >> "$TMP"
    cd ..
done

# ============================================================
# 生成结果.md
# ============================================================
TODAY=$(date +%Y-%m-%d)

cat > "$OUTPUT" << HEADER
# coCN 性能基准测试结果

> 对比 coCN 原生编译 vs C (gcc -O3 -march=native)
> 运行日期: ${TODAY}

## 主基准测试对比表

| 基准 | C (gcc -O3) | coCN 解释器 | 比值 (coCN/C) |
|------|------------|------------|---------------|
HEADER

# 用 python 生成表格和几何平均
python3 << 'PYEOF' >> "$OUTPUT"
import math

results = []
labels = {
    "fib": "斐波那契(递归40)",
    "sum": "循环累加(1亿)",
    "matmul": "矩阵乘法(200²)",
    "qsort": "快速排序(100万)",
    "string": "字符串处理(10万)",
    "hashtable": "哈希表(100万)",
    "alloc": "内存分配(100万)",
    "tree": "二叉树遍历(100万)",
    "kmp": "KMP匹配(10万)",
    "pi": "蒙特卡洛π(1亿)",
}
order = ["fib","sum","matmul","qsort","string","hashtable","alloc","tree","kmp","pi"]

data = {}
with open("/tmp/cocn_bench_results.txt") as f:
    for line in f:
        parts = line.strip().split("|")
        if len(parts) == 3:
            data[parts[0]] = (float(parts[1]), float(parts[2]))

ratios = []
for key in order:
    if key not in data:
        continue
    c_t, co_t = data[key]
    label = labels.get(key, key)
    ratio = co_t / c_t if c_t > 0 else 0
    ratios.append(ratio)
    print(f"| {label} | {c_t:.4f}s | {co_t:.4f}s | {ratio:.2f}x |")

if ratios:
    geo = math.exp(sum(math.log(r) for r in ratios) / len(ratios))
    print(f"\n**几何平均 (coCN解释器 / C): {geo:.2f}x**")

print("""
## 说明

- **C 列**: gcc -O3 -march=native 编译，运行 3 次取最佳
- **coCN 列**: 当前为解释器基线（node bin/cocn.js），运行 3 次取最佳
- **比值**: coCN 时间 / C 时间。比值 > 1 表示 coCN 比 C 慢
- **目标**: 原生编译器完成后，比值应 ≤ 1.0（即 coCN 达到或超过 gcc -O3）

## 临时方案状态

当前原生编译器尚未完成，coCN 行为解释器基线。
原生编译器就绪后，重新运行 `bash 汇总.sh` 即可更新结果。
""")
PYEOF

echo ""
echo "============================================"
echo " 结果已写入 $OUTPUT"
echo "============================================"
cat "$OUTPUT"
