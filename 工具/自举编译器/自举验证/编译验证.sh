#!/bin/bash
# ============================================================
# 编译验证.sh —— 自举编译器端到端验证
#
# 对10个真实.co程序：
#   1. 用自举编译器（词法→语法→ELF→机器码）编译为ELF
#   2. 用 file 命令验证ELF真实性
#   3. 运行ELF并输出结果
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../../.." && pwd)"
COMPILER_DIR="$PROJECT_ROOT/工具/自举编译器"
cd "$PROJECT_ROOT" || exit 1

# 编译需要拼接的模块
COMPILER_MODULES=(
    "$COMPILER_DIR/词法分析器.co"
    "$COMPILER_DIR/语法分析器.co"
    "$COMPILER_DIR/elf.co"
    "$COMPILER_DIR/机器码生成器.co"
)

# 待测程序列表
PROGRAMS=(
    "fib.co"
    "prime.co"
    "factorial.co"
    "bubble.co"
    "binary.co"
    "calc.co"
    "multable.co"
    "hanoi.co"
    "reverse.co"
    "wordcount.co"
)

pass=0
fail=0

echo "================================================"
echo "  coCN 自举编译器 —— 真实程序编译验证"
echo "================================================"
echo ""

for prog in "${PROGRAMS[@]}"; do
    target="$DIR/$prog"
    echo "------------------------------------------"
    echo "编译: $prog"

    # 拼接编译器模块 + 驱动
    tmp="/tmp/verify_${prog}.co"
    cat "${COMPILER_MODULES[@]}" "$DIR/编译驱动.co" > "$tmp"

    # 运行自举编译器
    # bin/cocn.js 是 sh 薄壳（首行 #!/bin/sh），不能交给 node 解析；
    # 直接执行它，由薄壳自己分派到 node 入口。
    COCN_PROGRAM="$target" COCN_BACKEND=eval \
        timeout 60 "$PROJECT_ROOT/bin/cocn.js" "$tmp" > /tmp/verify_out.txt 2>&1
    rc=$?

    if [ $rc -ne 0 ]; then
        echo "  [失败] 编译器运行错误 (exit=$rc)"
        cat /tmp/verify_out.txt
        fail=$((fail + 1))
        continue
    fi

    # 验证ELF文件
    if [ ! -f /tmp/bootstrap_verify.elf ]; then
        echo "  [失败] 未生成ELF文件"
        fail=$((fail + 1))
        continue
    fi

    elftype=$(file /tmp/bootstrap_verify.elf)
    echo "  ELF类型: $elftype"

    if ! echo "$elftype" | grep -q "ELF"; then
        echo "  [失败] 不是有效ELF文件"
        fail=$((fail + 1))
        continue
    fi

    # 复制ELF到自举验证目录留存后再跑：只判「ELF 存在」是不够的，
    # 自举编译器曾把中文串按码点低 8 位编码，ELF 完全合法、ASCII 输出也正常，
    # 只有中文全是乱码。门禁必须做到「产物 stdout 与解释器逐字节一致」。
    cp /tmp/bootstrap_verify.elf "$DIR/${prog%.co}.elf"
    chmod +x "$DIR/${prog%.co}.elf"

    "$DIR/${prog%.co}.elf" > /tmp/bootstrap_actual.txt 2>&1
    "./bin/cocn.js" "$target" > /tmp/bootstrap_expect.txt 2>&1

    # 显示程序输出
    echo "  --- 输出 ---"
    sed 's/^/  /' /tmp/bootstrap_actual.txt
    echo ""

    if cmp -s /tmp/bootstrap_actual.txt /tmp/bootstrap_expect.txt; then
        echo "  [通过] ELF 输出与解释器逐字节一致"
        pass=$((pass + 1))
    else
        echo "  [失败] 输出与解释器不一致"
        diff -u /tmp/bootstrap_expect.txt /tmp/bootstrap_actual.txt | head -20
        fail=$((fail + 1))
    fi
done

echo "================================================"
echo "  结果: 通过 $pass / 失败 $fail / 共 ${#PROGRAMS[@]}"
echo "================================================"

# 清理临时文件
rm -f /tmp/verify_*.co /tmp/verify_out.txt /tmp/bootstrap_verify.hex /tmp/bootstrap_verify.elf

if [ $fail -gt 0 ]; then
    exit 1
fi
