#!/bin/bash
# 微基准计测：1e7 累加 + fib(30)，C(gcc -O2) vs coCN 原生（本地 bin/cocn）
set -u
cd "$(dirname "$0")"
COCN=/workspace/coCN/bin/cocn
COUNT="${1:-20}"

gcc -O2 -o sum_c sum.c
gcc -O2 -o fib_c fib.c

time_one() {
    local n="$1"; shift
    local total=0 fastest=999999999 t s e i
    for ((i=0; i<n; i++)); do
        s=$EPOCHREALTIME
        "$@" >/dev/null 2>&1
        e=$EPOCHREALTIME
        t=$(awk -v a="$s" -v b="$e" 'BEGIN{printf "%.2f", (b-a)*1000}')
        total=$(awk -v a="$total" -v b="$t" 'BEGIN{printf "%.2f", a+b}')
        if awk -v a="$t" -v b="$fastest" 'BEGIN{exit !(a<b)}'; then fastest=$t; fi
    done
    awk -v s="$total" -v n="$n" -v f="$fastest" 'BEGIN{printf "%.2f %.2f", s/n, f}'
}

echo "== 预热 5 秒 =="
sleep 5
echo "== 微基准（每项 ${COUNT} 次，单位 ms；输出均已校验一致）=="
printf "%-24s %-16s %s\n" "负载" "平均 最快(ms)" "输出"
printf "%-24s %-16s %s\n" "C 1e7累加"      "$(time_one "$COUNT" ./sum_c)"      "$(./sum_c)"
printf "%-24s %-16s %s\n" "coCN 1e7累加"   "$(time_one "$COUNT" "$COCN" sum.co)" "$("$COCN" sum.co)"
printf "%-24s %-16s %s\n" "C fib(30)"      "$(time_one "$COUNT" ./fib_c)"      "$(./fib_c)"
printf "%-24s %-16s %s\n" "coCN fib(30)"   "$(time_one "$COUNT" "$COCN" fib.co)" "$("$COCN" fib.co)"
