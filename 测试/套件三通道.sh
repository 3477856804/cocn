#!/bin/bash
# 套件三通道：36 个测试套件 × {eval, vm, native} 三通道一致性
# 用法：测试/套件三通道.sh [通道子集: eval|vm|native]
#
# 对 测试/*.co 的每个套件，跑 eval/vm/native 三通道，逐条比对：
#   - stdout/stderr 是否逐字节一致
#   - 退出码是否一致
#   - 输出里是否含「失败 0」或「全部通过」判定
# 汇总：套件: 36 总数 / eval 通过 X / vm 通过 Y / native 通过 Z / 三通道一致 W
# 有些套件涉及文件系统/网络/并发，可能本身不稳定或有副作用：
# 把这类套件跑失败的原始输出保留并如实分类为「套件自身失败」vs「通道分歧」

set -u

# 单套件单通道的超时上限（秒），可用 SUITE_TIMEOUT 覆盖。
# 为什么从 30 提到 120：30 秒是早期拍的，随着套件增长，两个慢套件会「通过但超时」，
# 被误判为失败——性能测试 实测约 60s（5/5 全过）、异常测试 eval 通道实测约 38s（全过）。
# 门禁的作用是拦住「结果错」，不是拦住「跑得慢」；把阈值调到真实耗时之上，
# 让 37/37 这个数字是真的，而不是靠拍一个偏小的上限蒙出来的。
SUITE_TIMEOUT="${SUITE_TIMEOUT:-120}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CO="${1:-bin/cocn}"
CHANNELS="${2:-eval vm native}"

if [ ! -x "$CO" ]; then
    echo "错误：找不到可执行文件 $CO" >&2
    echo "提示：可用 CO=bin/cocn.js 跑（解释器通道）；" >&2
    echo "      非 x86 平台还需要 COCN_BOOTSTRAP 指向本机架构的引导器。" >&2
    exit 2
fi

# native 通道的真实含义要说清楚，别让门禁数字骗人：
#   - 有 bin/cocn（C 原生启动器）时，native = 直接机器码 ELF；
#   - 走 bin/cocn.js 时，native = 引导器自解释器（与 vm 同源），
#     此时 native 与 vm 的一致性是平凡的，真正起作用的是 eval vs vm。
# 报告里据此标注，避免把「回退解释器」当成「原生直跑」。
NATIVE_IS_ELF=0
case "$CO" in
    *cocn) NATIVE_IS_ELF=1 ;;
esac
if [ "$NATIVE_IS_ELF" = "1" ]; then
    NATIVE_NOTE="native=直接机器码 ELF"
else
    NATIVE_NOTE="native=引导器自解释器（非 ELF，与 vm 同源；真正校验力在 eval vs vm）"
fi

TMP="$(mktemp -d)"
# 子进程的 TMPDIR 必须与门禁自身的输出目录分开：
# 测试套件会往 TMPDIR 里写临时文件（如 优化测试/系统函数测试），
# 有的还会清理它。之前两者共用同一个目录，结果测试一清 TMPDIR，
# 门禁正在写的 $id.eval.out 也被一起删掉 —— 后续套件全部报
# 「No such file or directory」，真实结果是 37/37 却被误报成 5/37。
# 分开之后，测试怎么折腾 TMPDIR 都伤不到门禁自己的记录。
CTMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$CTMP"' EXIT

TOTAL=0
EVAL_PASS=0
VM_PASS=0
NATIVE_PASS=0
ALL_MATCH=0

for f in 测试/*.co; do
    [ -f "$f" ] || continue
    TOTAL=$((TOTAL + 1))
    id="$(basename "$f" .co)"

    eval_ok=0
    vm_ok=0
    native_ok=0

    # eval 通道
    if echo "$CHANNELS" | grep -qw "eval"; then
        TMPDIR="$CTMP" COCN_BACKEND=eval COCN_FORCE=解释器 timeout "${SUITE_TIMEOUT:-120}" "$CO" "$f" > "$TMP/$id.eval.out" 2> "$TMP/$id.eval.err"
        eval_rc=$?
        if [ "$eval_rc" -eq 0 ]; then
            if grep -qE "(失败 0|全部通过)" "$TMP/$id.eval.out"; then
                eval_ok=1
                EVAL_PASS=$((EVAL_PASS + 1))
            fi
        elif [ "$eval_rc" -eq 124 ]; then
            echo "超时：$id (eval)"
        fi
    fi

    # vm 通道
    if echo "$CHANNELS" | grep -qw "vm"; then
        TMPDIR="$CTMP" COCN_BACKEND=vm COCN_FORCE=解释器 timeout "${SUITE_TIMEOUT:-120}" "$CO" "$f" > "$TMP/$id.vm.out" 2> "$TMP/$id.vm.err"
        vm_rc=$?
        if [ "$vm_rc" -eq 0 ]; then
            if grep -qE "(失败 0|全部通过)" "$TMP/$id.vm.out"; then
                vm_ok=1
                VM_PASS=$((VM_PASS + 1))
            fi
        elif [ "$vm_rc" -eq 124 ]; then
            echo "超时：$id (vm)"
        fi
    fi

    # native 通道（启动器）
    if echo "$CHANNELS" | grep -qw "native"; then
        TMPDIR="$CTMP" timeout "${SUITE_TIMEOUT:-120}" "$CO" "$f" > "$TMP/$id.native.out" 2> "$TMP/$id.native.err"
        native_rc=$?
        if [ "$native_rc" -eq 0 ]; then
            if grep -qE "(失败 0|全部通过)" "$TMP/$id.native.out"; then
                native_ok=1
                NATIVE_PASS=$((NATIVE_PASS + 1))
            fi
        elif [ "$native_rc" -eq 124 ]; then
            echo "超时：$id (native)"
        fi
    fi

    # 三通道一致性
    if [ "$eval_ok" = "1" ] && [ "$vm_ok" = "1" ] && [ "$native_ok" = "1" ]; then
        if cmp -s "$TMP/$id.eval.out" "$TMP/$id.vm.out" &&
           cmp -s "$TMP/$id.eval.out" "$TMP/$id.native.out" &&
           [ "$eval_rc" = "$vm_rc" ] && [ "$eval_rc" = "$native_rc" ]; then
            ALL_MATCH=$((ALL_MATCH + 1))
        else
            echo "分歧：$id"
            echo "  eval vs vm:"
            diff -u "$TMP/$id.eval.out" "$TMP/$id.vm.out" | head -10
        fi
    elif [ "$eval_ok" = "0" ] && [ "$vm_ok" = "0" ] && [ "$native_ok" = "0" ]; then
        echo "套件自身失败：$id (eval=$eval_ok vm=$vm_ok native=$native_ok)"
    fi
done

echo "套件: $TOTAL 总数 / eval 通过 $EVAL_PASS / vm 通过 $VM_PASS / native 通过 $NATIVE_PASS / 三通道一致 $ALL_MATCH"
echo "通道说明: $NATIVE_NOTE"

if [ "$ALL_MATCH" = "$TOTAL" ]; then
    exit 0
else
    exit 1
fi
