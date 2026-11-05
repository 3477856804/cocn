#!/bin/bash
# 错误用例批跑：44 个错误用例 × {eval, vm, native} 三通道门禁
# 用法：测试/错误用例批跑.sh [cocn路径]
#
# eval/vm 通道：要求 rc≠0 且 stderr 非空；统计「静默通过数」（rc=0 的）必须为 0
# 原生通道：编译期拒绝（rc≠0）计为 REJECT；编译成功则跑产物，要求 rc≠0（产物中断）
# 统计 REJECT 数、产物中断数、rc=0 数、挂死数
# 基线实测参考：编译期拒绝 39 / 产物中断 5 / rc=0 为 0 / 挂死 0

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CO="${1:-bin/cocn}"

if [ ! -x "$CO" ]; then
    echo "错误：找不到可执行文件 $CO" >&2
    exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

TOTAL=0

# eval/vm 通道统计
EVAL_SILENT=0
VM_SILENT=0

# 原生通道统计
NATIVE_REJECT=0
NATIVE_RUNTIME=0
NATIVE_RC0=0
NATIVE_HANG=0

for f in 测试/错误用例/*.co; do
    [ -f "$f" ] || continue
    TOTAL=$((TOTAL + 1))
    id="$(basename "$f" .co)"

    # eval 通道
    COCN_BACKEND=eval COCN_FORCE=解释器 timeout 60 "$CO" "$f" > "$TMP/$id.eval.out" 2> "$TMP/$id.eval.err"
    eval_rc=$?
    if [ "$eval_rc" -eq 124 ]; then
        echo "挂死：$id (eval)"
    elif [ "$eval_rc" -eq 0 ]; then
        EVAL_SILENT=$((EVAL_SILENT + 1))
        echo "静默通过：$id (eval)"
    elif [ ! -s "$TMP/$id.eval.err" ]; then
        echo "无stderr：$id (eval)"
    fi

    # vm 通道
    COCN_BACKEND=vm COCN_FORCE=解释器 timeout 60 "$CO" "$f" > "$TMP/$id.vm.out" 2> "$TMP/$id.vm.err"
    vm_rc=$?
    if [ "$vm_rc" -eq 124 ]; then
        echo "挂死：$id (vm)"
    elif [ "$vm_rc" -eq 0 ]; then
        VM_SILENT=$((VM_SILENT + 1))
        echo "静默通过：$id (vm)"
    elif [ ! -s "$TMP/$id.vm.err" ]; then
        echo "无stderr：$id (vm)"
    fi

    # 原生通道
    "$CO" --编译 "$f" "$TMP/$id.bin" > "$TMP/$id.compile.log" 2>&1
    compile_rc=$?
    if [ "$compile_rc" -ne 0 ]; then
        NATIVE_REJECT=$((NATIVE_REJECT + 1))
    else
        # 编译成功，跑产物
        timeout 60 "$TMP/$id.bin" > "$TMP/$id.native.out" 2> "$TMP/$id.native.err"
        native_rc=$?
        if [ "$native_rc" -eq 124 ]; then
            NATIVE_HANG=$((NATIVE_HANG + 1))
            echo "挂死：$id (native)"
        elif [ "$native_rc" -eq 0 ]; then
            NATIVE_RC0=$((NATIVE_RC0 + 1))
            echo "rc=0：$id (native)"
        else
            NATIVE_RUNTIME=$((NATIVE_RUNTIME + 1))
        fi
    fi
done

echo "错误用例 eval: $TOTAL/$TOTAL  静默通过 $EVAL_SILENT"
echo "错误用例 vm:   $TOTAL/$TOTAL  静默通过 $VM_SILENT"
echo "错误用例 原生: $TOTAL 总数 / 编译期拒绝 $NATIVE_REJECT / 产物中断 $NATIVE_RUNTIME / rc=0 $NATIVE_RC0 / 挂死 $NATIVE_HANG"

# 达标条件：eval/vm 静默通过=0，原生 rc=0=0，原生挂死=0
if [ "$EVAL_SILENT" -eq 0 ] && [ "$VM_SILENT" -eq 0 ] && [ "$NATIVE_RC0" -eq 0 ] && [ "$NATIVE_HANG" -eq 0 ]; then
    exit 0
else
    exit 1
fi
