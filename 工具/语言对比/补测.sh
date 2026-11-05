#!/bin/bash
# 补测：本地仓库版 coCN（原生启动器 + 解释器兜底）+ 空程序启动开销
set -u
cd "$(dirname "$0")"
COCN=/workspace/coCN/bin/cocn
COUNT="${1:-50}"
SLOW="${2:-3}"   # 解释器兜底行专用计数（单次数十秒，只跑几次取平均）

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

gcc -O2 -o empty_c empty_c.c
rustc -O -o empty_rs empty_rs.rs 2>/dev/null
go build -o empty_go empty_go.go 2>/dev/null
javac -d . Empty.java 2>/dev/null

echo "== 预热 5 秒 =="
sleep 5

echo "== coCN 本地仓库版（单位 ms）=="
printf "%-28s %-16s %s\n" "通道" "平均 最快(ms)" "输出校验"
printf "%-28s %-16s %s\n" "coCN 原生(本地 bin/cocn)" "$(time_one "$COUNT" "$COCN" bench.co)" "$("$COCN" bench.co 2>/dev/null | tr '\n' '/')"
printf "%-28s %-16s %s\n" "coCN 解释器兜底(eval)" "$(time_one "$SLOW" env COCN_BACKEND=eval COCN_FORCE=解释器 "$COCN" bench.co)" "$(env COCN_BACKEND=eval COCN_FORCE=解释器 "$COCN" bench.co 2>/dev/null | tr '\n' '/')"
printf "%-28s %-16s %s\n" "coCN 解释器兜底(vm)" "$(time_one "$SLOW" env COCN_BACKEND=vm COCN_FORCE=解释器 "$COCN" bench.co)" "$(env COCN_BACKEND=vm COCN_FORCE=解释器 "$COCN" bench.co 2>/dev/null | tr '\n' '/')"

echo "== 空程序启动开销（单位 ms）=="
printf "%-28s %-16s\n" "程序" "平均 最快(ms)"
printf "%-28s %-16s\n" "C 空程序" "$(time_one "$COUNT" ./empty_c)"
printf "%-28s %-16s\n" "Rust 空程序" "$(time_one "$COUNT" ./empty_rs)"
printf "%-28s %-16s\n" "Go 空程序" "$(time_one "$COUNT" ./empty_go)"
printf "%-28s %-16s\n" "Java 空程序" "$(time_one "$COUNT" java Empty)"
printf "%-28s %-16s\n" "Python 空程序" "$(time_one "$COUNT" python3 -c pass)"
printf "%-28s %-16s\n" "Node 空程序" "$(time_one "$COUNT" node -e "")"
printf "%-28s %-16s\n" "coCN 空程序(原生)" "$(time_one "$COUNT" "$COCN" empty.co)"
