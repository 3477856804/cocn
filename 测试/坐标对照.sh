#!/bin/bash
# 坐标对照：宿主真值 vs eval/vm 通道的逐字节一致性
# 用法：测试/坐标对照.sh [cocn路径] [引导器路径]
#
# 对 测试/坐标用例/*.co 的每个用例，跑 宿主/eval/vm 三通道，
# 各自捕获 stdout+stderr 合并文本 + 退出码；判定：
#   (a) 三通道是否逐字节一致
#   (b) 与宿主真值是否一致
# 不一致的条目打印期望与实际两行。全部一致时 exit 0，否则 exit 1。

set -u

# 定位仓库根目录（脚本在 测试/ 下，仓库根在上一级）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CO="${1:-bin/cocn}"
BOOT="${2:-bin/引导器}"

if [ ! -x "$CO" ]; then
    echo "错误：找不到可执行文件 $CO" >&2
    exit 2
fi

if [ ! -x "$BOOT" ]; then
    echo "错误：找不到可执行文件 $BOOT" >&2
    exit 2
fi

TMP="$(mktemp -d)"
# 与 套件三通道.sh 同一修法：测试/宿主进程的 TMPDIR 与门禁输出目录分开，
# 避免子进程清理 TMPDIR 时把 $id.*.out 一起删掉，造成虚假失败。
CTMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$CTMP"' EXIT

TOTAL=0
MATCH_ALL=0
MATCH_HOST=0

for f in 测试/坐标用例/*.co; do
    [ -f "$f" ] || continue
    TOTAL=$((TOTAL + 1))
    id="$(basename "$f" .co)"

    # 宿主真值（C 解释器）
    TMPDIR="$CTMP" "$BOOT" "$f" > "$TMP/$id.host.out" 2> "$TMP/$id.host.err"
    host_rc=$?
    cat "$TMP/$id.host.out" "$TMP/$id.host.err" > "$TMP/$id.host.combined"

    # eval 通道
    TMPDIR="$CTMP" COCN_BACKEND=eval COCN_FORCE=解释器 "$CO" "$f" > "$TMP/$id.eval.out" 2> "$TMP/$id.eval.err"
    eval_rc=$?
    cat "$TMP/$id.eval.out" "$TMP/$id.eval.err" > "$TMP/$id.eval.combined"

    # vm 通道
    TMPDIR="$CTMP" COCN_BACKEND=vm COCN_FORCE=解释器 "$CO" "$f" > "$TMP/$id.vm.out" 2> "$TMP/$id.vm.err"
    vm_rc=$?
    cat "$TMP/$id.vm.out" "$TMP/$id.vm.err" > "$TMP/$id.vm.combined"

    # 判定 (a)：三通道是否逐字节一致（stdout+stderr 合并 + 退出码）
    all_match=0
    if cmp -s "$TMP/$id.host.combined" "$TMP/$id.eval.combined" &&
       cmp -s "$TMP/$id.host.combined" "$TMP/$id.vm.combined" &&
       [ "$host_rc" = "$eval_rc" ] && [ "$host_rc" = "$vm_rc" ]; then
        all_match=1
        MATCH_ALL=$((MATCH_ALL + 1))
        MATCH_HOST=$((MATCH_HOST + 1))
    else
        # 判定 (b)：eval/vm 各自与宿主是否一致
        eval_match=0
        vm_match=0
        if cmp -s "$TMP/$id.host.combined" "$TMP/$id.eval.combined" &&
           [ "$host_rc" = "$eval_rc" ]; then
            eval_match=1
        fi
        if cmp -s "$TMP/$id.host.combined" "$TMP/$id.vm.combined" &&
           [ "$host_rc" = "$vm_rc" ]; then
            vm_match=1
        fi
        if [ "$eval_match" = "1" ] && [ "$vm_match" = "1" ]; then
            MATCH_HOST=$((MATCH_HOST + 1))
        fi
        echo "不一致：$id"
        echo "  期望（宿主）：$(head -1 "$TMP/$id.host.combined")"
        echo "  eval：$(head -1 "$TMP/$id.eval.combined")"
        echo "  vm：$(head -1 "$TMP/$id.vm.combined")"
    fi
done

echo "坐标对照: 总数 $TOTAL / 三通道一致 $MATCH_ALL / 与宿主一致 $MATCH_HOST"

if [ "$MATCH_ALL" = "$TOTAL" ]; then
    exit 0
else
    exit 1
fi
