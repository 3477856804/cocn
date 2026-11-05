#!/bin/bash
# ============================================================
# 七语言同题计测（trio 基准）· 2026-10-21 版
#
# 负载：埃氏筛 10000（素数 1229）+ 递归 fib(20)（6765）+ 3000 次中文拼接（19893）
# 七种语言必须输出【逐字节一致】，否则本次计测无效。
#
# 用法：
#   工具/语言对比/计测.sh [计数]              # 默认 30 次
#   COCN_CHANNEL=native|bootstrap|qemu 工具/语言对比/计测.sh
#     native     —— 用直接机器码后端编出的 x86-64 ELF（用户真实体验）
#     bootstrap  —— 用引导器（宿主 C）直接跑 .co
#     qemu       —— 非 x86 机器上用 qemu-x86_64 跑 native ELF
#     缺省       —— 有 bin/cocn 用 native，否则 bootstrap
#
# 输出末尾附一行 "RESULTJSON=..."，便于程序化对比与文档回填。
# ============================================================
set -u
# 构建与执行都必须离开 /storage（该分区 noexec，编译产物跑不起来），
# 统一在 $HOME 下的临时目录里做。
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${COCN_BENCH_WORK:-$HOME/cocnwork/benchrun}"
mkdir -p "$WORK"
cd "$WORK" || exit 1
for f in bench.c bench.rs bench.go bench.java bench.py bench.js bench.co empty.co; do
    [ -f "$SRC_DIR/$f" ] && cp -f "$SRC_DIR/$f" "$WORK/$f"
done

COUNT="${1:-30}"
EXPECT=$'素数: 1229\nfib: 6765\n拼接: 19893'
# 仓库根要在 cd 到 WORK 之前算好（cd 之后相对路径就指错地方了）
ROOT="$(cd "$SRC_DIR/../.." && pwd)"

# ---------- 构建 ----------
build_c()   { gcc -O2 -o bench_c bench.c 2>/dev/null; }
build_rs()  { rustc -O -o bench_rs bench.rs 2>/dev/null; }
build_go()  { command -v go >/dev/null && go build -o bench_go bench.go 2>/dev/null; }
build_java(){ command -v javac >/dev/null && javac -d . bench.java 2>/dev/null; }

# ---------- 计时 ----------
# time_one <cmd...>：打印「平均 最快」（ms，EPOCHREALTIME 微秒源）
time_one() {
    local total=0 fastest=999999999 t s e
    local i
    for ((i=0; i<COUNT; i++)); do
        s=$EPOCHREALTIME
        "$@" >/dev/null 2>&1
        e=$EPOCHREALTIME
        t=$(awk -v a="$s" -v b="$e" 'BEGIN{printf "%.2f", (b-a)*1000}')
        total=$(awk -v a="$total" -v b="$t" 'BEGIN{printf "%.2f", a+b}')
        if awk -v a="$t" -v b="$fastest" 'BEGIN{exit !(a<b)}'; then fastest=$t; fi
    done
    awk -v s="$total" -v n="$COUNT" -v f="$fastest" 'BEGIN{printf "%.2f %.2f", s/n, f}'
}

verify() {
    local out
    out=$("$@" 2>/dev/null)
    if [ "$out" == "$EXPECT" ]; then echo "一致"; else echo "不一致[$out]"; fi
}

# ---------- coCN 通道 ----------
COCN_CHANNEL="${COCN_CHANNEL:-}"
COCN_CMD=()
COCN_LABEL="coCN"

PREP_COCN() {
    local ch="$COCN_CHANNEL"
    if [ -z "$ch" ]; then
        if [ -x "$ROOT/bin/cocn" ]; then ch=native
        else ch=bootstrap
        fi
    fi
    case "$ch" in
        native)
            # 直接机器码后端：编出 x86-64 静态 ELF
            command -v node >/dev/null || { echo "  (缺 node)"; return 1; }
            node "$ROOT/工具/原生编译器/机器码生成器.js" bench.co bench_cocn.elf >/dev/null 2>&1 \
                || { echo "  (机器码后端失败)"; return 1; }
            if command -v qemu-x86_64 >/dev/null && [ "$(uname -m)" != "x86_64" ]; then
                COCN_CMD=(qemu-x86_64 ./bench_cocn.elf)
                COCN_LABEL="coCN (native ELF)"
            else
                COCN_CMD=(./bench_cocn.elf)
                COCN_LABEL="coCN (native ELF)"
            fi
            ;;
        bootstrap)
            # 引导器（宿主 C）直接跑 .co
            local boot="${COCN_BOOTSTRAP:-}"
            if [ -z "$boot" ]; then
                boot="$HOME/cocnwork/引导器-arm2"
                [ -x "$boot" ] || boot="$ROOT/bin/引导器"
            fi
            [ -x "$boot" ] || { echo "  (找不到引导器)"; return 1; }
            COCN_CMD=("$boot" bench.co)
            COCN_LABEL="coCN (引导器/宿主C)"
            ;;
        qemu)
            node "$ROOT/工具/原生编译器/机器码生成器.js" bench.co bench_cocn.elf >/dev/null 2>&1 || return 1
            COCN_CMD=(qemu-x86_64 ./bench_cocn.elf)
            COCN_LABEL="coCN (native ELF via qemu)"
            ;;
        *) echo "  (未知通道 $ch)"; return 1 ;;
    esac
    return 0
}

# ---------- 计测 ----------
echo "== 构建 =="
# 不用关联数组：Android 的 bash 对 declare -A 支持不稳。
# 每个语言一个 OK_<名> 标志 + 一个 LABEL_<名> 标签。
OK_C=0;   LABEL_C="C (gcc -O2)"
OK_RUST=0; LABEL_RUST="Rust (rustc -O)"
OK_GO=0;  LABEL_GO="Go"
OK_JAVA=0; LABEL_JAVA="Java"
OK_PY=0;  LABEL_PY="Python"
OK_JS=0;  LABEL_JS="Node"
OK_COCN=0; LABEL_COCN="$COCN_LABEL"

build_c    && OK_C=1    || echo "  跳过 C"
build_rs   && OK_RUST=1 || echo "  跳过 Rust"
build_go   && OK_GO=1   || echo "  跳过 Go"
build_java && OK_JAVA=1 || echo "  跳过 Java"
command -v python3 >/dev/null && OK_PY=1 || echo "  跳过 Python"
command -v node    >/dev/null && OK_JS=1 || echo "  跳过 Node"
PREP_COCN  && OK_COCN=1 || echo "  跳过 coCN"

echo "== 预热 5 秒（稳态）=="
sleep 5

echo "== 计测（每项 ${COUNT} 次，单位 ms）=="
printf "%-28s %-16s %s\n" "语言" "平均 最快(ms)" "输出校验"
RESULT=""
BENCH_ONE() { # $1=是否可用 $2=标签 $3=命令...
    local ok="$1"; local label="$2"; shift 2
    [ "$ok" = "1" ] || return 0
    local t v
    t=$(time_one "$@")
    v=$(verify "$@")
    printf "%-28s %-16s %s\n" "$label" "$t" "$v"
    RESULT="$RESULT{\"语言\":\"$label\",\"平均\":$(echo "$t" | cut -d' ' -f1),\"最快\":$(echo "$t" | cut -d' ' -f2),\"校验\":\"$v\"},"
}
# ---- 公平性：同机同架构 ----
# 本机是 aarch64：C / Rust / Go 用 Termux 的本机编译器编出 aarch64 原生程序，
# 直接执行（构建在 $HOME 下，绕开 /storage 的 noexec）。
# coCN 的直接机器码后端目前只出 x86-64 ELF，在 aarch64 上只能经 qemu 跑 ——
# 那会把「qemu 模拟开销」算进 coCN 头上，不公平。
# 所以本机默认用【引导器/宿主 C】通道测 coCN（aarch64 原生，与 C/Rust 同口径）；
# coCN 的 x86-64 native 通道留给 x86 用户（那里是同架构直接执行）。
# 用 COCN_CHANNEL=native 可强制测 native ELF（数值含 qemu 开销，仅作参考）。
ARCH="$(uname -m)"
echo "== 说明：本机 ${ARCH}；C/Rust/Go 为本机原生程序，coCN 默认走引导器（宿主 C）通道 =="

BENCH_ONE "$OK_C"    "$LABEL_C"    ./bench_c
BENCH_ONE "$OK_RUST" "$LABEL_RUST" ./bench_rs
BENCH_ONE "$OK_GO"   "$LABEL_GO"   ./bench_go
BENCH_ONE "$OK_JAVA" "$LABEL_JAVA" java Bench
BENCH_ONE "$OK_PY"   "$LABEL_PY"   python3 bench.py
BENCH_ONE "$OK_JS"   "$LABEL_JS"   node bench.js
BENCH_ONE "$OK_COCN" "$LABEL_COCN" "${COCN_CMD[@]}"

echo "RESULTJSON=[${RESULT%,}]"
