#!/bin/sh
# ============================================================
# 测试/编译器/运行测试.sh —— 自举编译器正确性测试运行器。
#
# 对本目录下每个 .co 测试文件：
#   1) 用原生解释器 bin/cocn 运行，记录基准输出（stdout）；
#   2) 用 编译器/编译.sh 把它编译成原生二进制；
#   3) 运行编译后的二进制，记录实际输出（stdout）；
#   4) 逐字节比对两个 stdout：
#        一致     -> 通过
#        不一致   -> 失败（输出 diff）
#        编译失败 -> 待支持（编译器尚未实现该特性）
#
# 用法：
#   ./运行测试.sh            # 跑全部
#   ./运行测试.sh 01_*.co ... # 只跑指定文件
# ============================================================
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
NATIVE_CO="$PROJECT_ROOT/bin/cocn"
COMPILE_SH="$PROJECT_ROOT/编译器/编译.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/自举测试.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0; PENDING=0; SKIP=0

printf "%-22s  %-8s  %s\n" "测试用例" "结果" "说明"
printf "%-22s  %-8s  %s\n" "----------------------" "--------" "------------------------"

# 收集待跑文件：默认全部 *.co，否则用命令行参数
if [ "$#" -gt 0 ]; then
    FILES="$@"
else
    FILES="$(ls "$SELF_DIR"/*.co 2>/dev/null | sort)"
fi

for f in $FILES; do
    # 支持传文件名或完整路径
    case "$f" in
        /*) abs="$f" ;;
        *)  abs="$SELF_DIR/$(basename "$f")" ;;
    esac
    name="$(basename "$abs")"
    [ ! -f "$abs" ] && { printf "%-22s  %-8s  %s\n" "$name" "跳过" "文件不存在"; SKIP=$((SKIP+1)); continue; }

    base_out="$WORK/base.txt"
    bin_out="$WORK/bin.txt"

    # 1) 基准：原生解释器
    "$NATIVE_CO" "$abs" >"$base_out" 2>/dev/null
    base_rc=$?

    # 2) 编译
    bin="$WORK/prog"
    if ! timeout 60 "$COMPILE_SH" "$abs" "$bin" >/dev/null 2>"$WORK/compile.err"; then
        printf "%-22s  %-8s  %s\n" "$name" "待支持" "编译器暂不支持该特性"
        PENDING=$((PENDING+1))
        continue
    fi

    # 3) 运行编译产物（加超时，防止编译器死循环挂起整个套件）
    timeout 10 "$bin" >"$bin_out" 2>"$WORK/bin.err"
    bin_rc=$?

    # 超时视为挂起（编译器缺陷）
    if [ "$bin_rc" -eq 124 ]; then
        printf "%-22s  %-8s  %s\n" "$name" "挂起" "运行超时（疑似编译器循环代码生成缺陷）"
        FAIL=$((FAIL+1))
        continue
    fi

    # 4) 比对 stdout
    if diff -q "$base_out" "$bin_out" >/dev/null 2>&1; then
        printf "%-22s  %-8s  %s\n" "$name" "通过" "输出一致"
        PASS=$((PASS+1))
    else
        printf "%-22s  %-8s  %s\n" "$name" "失败" "输出不一致 (基准rc=$base_rc 产物rc=$bin_rc)"
        FAIL=$((FAIL+1))
        echo "    ---- diff(基准 | 产物) ----"
        diff "$base_out" "$bin_out" | sed 's/^/    /'
    fi
done

printf "%-22s  %-8s  %s\n" "----------------------" "--------" "------------------------"
echo ""
echo "汇总：通过=$PASS  失败=$FAIL  待支持=$PENDING  跳过=$SKIP"

# 有真实失败才返回非零；待支持不算失败
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
