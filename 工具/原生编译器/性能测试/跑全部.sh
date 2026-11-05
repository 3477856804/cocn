#!/usr/bin/env bash
# ============================================================
# 跑全部.sh —— 一键编译并运行所有基准，输出对比表
# 用法: bash 原生编译器/性能测试/跑全部.sh
# 生成: 原生编译器/性能测试/性能分析报告.md（覆盖）
# ============================================================
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

# 结果收集
ROWS=""
GEOM_PROD=1
GEOM_N=0

# 跑一个基准：参数 目录 C文件 co文件 标签
run_bench() {
  local dir="$1" cf="$2" cof="$3" label="$4"
  local base_c="${cf%.c}" base_co="${cof%.co}"
  ( cd "$HERE/$dir"
    编译c "$cf" "${base_c}_c" >/dev/null 2>&1
    编译co "$cof" "${base_co}_cocn" >/dev/null 2>&1
    local cout ccout ctime cotime ratio
    cout="$("./${base_c}_c" 2>/dev/null | tr -d '\n')"
    ccout="$(timeout 120 "./${base_co}_cocn" 2>/dev/null | tr -d '\n')"
    ctime="$(bestof3 "./${base_c}_c")"
    cotime="$(bestof3 "./${base_co}_cocn")"
    ratio="$(awk -v c="$ctime" -v o="$cotime" 'BEGIN{ if(o>0) printf "%.2f", c/o; else printf "n/a"}')"
    printf '%s|%s|%s|%s|%s|%s\n' "$label" "$ctime" "$cotime" "$ratio" "$cout" "$ccout"
  )
}

echo "== 编译并运行主基准 =="
MAIN=""
for spec in \
  "01_斐波那契|fib.c|fib.co|斐波那契(递归40)" \
  "02_循环累加|sum.c|sum.co|循环累加(1亿)" \
  "03_矩阵乘法|matmul.c|matmul.co|矩阵乘法(200²,整数)" \
  "04_快速排序|qsort.c|qsort.co|快速排序(100万)" \
  "05_字符串处理|str.c|str.co|字符串拼接(10万)" \
  "06_哈希表|hashtable.c|hashtable.co|哈希表(2万)" \
  "07_内存分配|alloc.c|alloc.co|内存分配(100万)" \
  "08_二叉树遍历|tree.c|tree.co|二叉树中序(100万)" \
  "09_正则匹配|kmp.c|kmp.co|KMP匹配(1万次)" \
  "10_数值积分|pi.c|pi.co|蒙特卡洛π(1亿)" ; do
  IFS='|' read -r d cf cof lbl <<< "$spec"
  line="$(run_bench "$d" "$cf" "$cof" "$lbl")"
  echo "  $line"
  MAIN="$MAIN
| $line |"
done

echo "== 编译并运行微基准 =="
MICRO=""
for spec in \
  "微基准|函数调用.c|函数调用.co|函数调用(1亿次)" \
  "微基准|整数运算.c|整数运算.co|整数运算(1亿次)" \
  "微基准|浮点运算.c|浮点运算.co|浮点运算(1亿次)" \
  "微基准|空循环.c|空循环.co|空循环(1亿次)" \
  "微基准|数组访问.c|数组访问.co|数组随机访问(1000万次)" \
  "微基准|内存分配.c|内存分配.co|内存分配(100万次)" ; do
  IFS='|' read -r d cf cof lbl <<< "$spec"
  line="$(run_bench "$d" "$cf" "$cof" "$lbl")"
  echo "  $line"
  MICRO="$MICRO
| $line |"
done

# 系统调用基准（仅 C，coCN 无暴露 write）
cd "$HERE/微基准"
编译c 系统调用.c 系统调用_c >/dev/null 2>&1
_t0=$(date +%s.%N); ./系统调用_c >/dev/null 2>&1; _t1=$(date +%s.%N)
SYSCALL_C="$(awk -v a=$_t1 -v b=$_t0 'BEGIN{printf "%.4f",a-b}')"
cd "$HERE"

echo "主基准表：$MAIN"
echo "微基准表：$MICRO"
echo "系统调用(C only)：$SYSCALL_C"

# 导出给报告生成步骤
echo "$MAIN" > "$HERE/_main_table.md"
echo "$MICRO" > "$HERE/_micro_table.md"
echo "$SYSCALL_C" > "$HERE/_syscall.txt"
echo "完成。表格已写入 _main_table.md / _micro_table.md"
