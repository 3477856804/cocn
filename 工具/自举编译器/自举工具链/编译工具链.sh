#!/bin/bash
# ============================================================
# 编译工具链.sh —— 用 coCN 自举编译器编译并验证整个开发工具链
#
# 流程：
#   1. 拼接 词法+语法+elf+机器码（自举编译器前端/后端）
#   2. 分别运行：格式化器 / 文档生成器 / 测试框架(自检) / 主.co(help,format,doc)
#   3. 端到端：用工具链处理示例.co，并跑 测试.co
#
# 运行方式：bash 工具/自举编译器/自举工具链/编译工具链.sh
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../../.." && pwd)"
COMPILER_DIR="$PROJECT_ROOT/工具/自举编译器"
TC_DIR="$DIR"

MODULES=(
    "$COMPILER_DIR/词法分析器.co"
    "$COMPILER_DIR/语法分析器.co"
    "$COMPILER_DIR/elf.co"
    "$COMPILER_DIR/机器码生成器.co"
)

pass=0
fail=0

run_tc () {
    # $1 = extra tool files (space-separated), rest are env assignments already set by caller
    local extra="$1"
    local tmp="/tmp/tc_build_$$.co"
    cat "${MODULES[@]}" $extra > "$tmp"
    timeout 120 node "$PROJECT_ROOT/bin/cocn.js" "$tmp"
    local rc=$?
    rm -f "$tmp"
    return $rc
}

echo "================================================"
echo " coCN 自举工具链 —— 编译与验证"
echo "================================================"

# ---- 0. 准备示例文件 ----
cat > /tmp/tc_示例.co <<'EOF'
#! 演示模块
#! 展示工具链如何处理真实代码。

#! 两数之和。
#! @example
#! 加(1, 2)  # => 3
函数 加(整数 a,整数 b)->整数
    返回 a+b
结束

#! 判断奇偶
函数 奇偶(整数 n)->字符串
    如果 n%2==0 则
        返回 "偶"
    否则
        返回 "奇"
    结束
结束
EOF

# ---- 1. 格式化器（独立运行）----
echo "------------------------------------------"
echo "[1] 格式化器 独立运行"
COCN_FMT_INPUT=/tmp/tc_示例.co COCN_FMT_OUTPUT=/tmp/tc_示例.fmt.co \
    COCN_BACKEND=eval run_tc "$TC_DIR/格式化器.co" && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }
echo "  --- 格式化结果 ---"
sed 's/^/    /' /tmp/tc_示例.fmt.co

# ---- 2. 文档生成器（独立运行）----
echo "------------------------------------------"
echo "[2] 文档生成器 独立运行"
COCN_DOC_INPUT=/tmp/tc_示例.co COCN_DOC_OUTPUT=/tmp/tc_示例.md \
    COCN_BACKEND=eval run_tc "$TC_DIR/文档生成器.co" && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }
echo "  --- Markdown 前 12 行 ---"
head -12 /tmp/tc_示例.md | sed 's/^/    /'

# ---- 3. 测试框架（自检）----
echo "------------------------------------------"
echo "[3] 测试框架 自检"
COCN_TEST_SELFTEST=1 COCN_BACKEND=eval run_tc "$TC_DIR/测试框架.co" > /tmp/tc_tf.txt 2>&1
grep -q "通过: 9" /tmp/tc_tf.txt && grep -q "失败: 1" /tmp/tc_tf.txt \
    && { echo "  [OK] 9 通过 / 1 预期失败"; pass=$((pass+1)); } \
    || { echo "  [FAIL]"; cat /tmp/tc_tf.txt; fail=$((fail+1)); }

# ---- 4. 主.co：help ----
echo "------------------------------------------"
echo "[4] 主.co help"
COCN_TC_CMD=help COCN_BACKEND=eval \
    run_tc "$TC_DIR/测试框架.co $TC_DIR/格式化器.co $TC_DIR/文档生成器.co $TC_DIR/主.co" \
    && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }

# ---- 5. 主.co：format 子命令 ----
echo "------------------------------------------"
echo "[5] 主.co format 子命令"
COCN_TC_CMD=format COCN_TC_TARGET=/tmp/tc_示例.co COCN_TC_OUTPUT=/tmp/tc_示例.cmd.fmt.co \
    COCN_BACKEND=eval \
    run_tc "$TC_DIR/测试框架.co $TC_DIR/格式化器.co $TC_DIR/文档生成器.co $TC_DIR/主.co" \
    && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }
echo "  --- format 输出首行 ---"
head -3 /tmp/tc_示例.cmd.fmt.co | sed 's/^/    /'

# ---- 6. 主.co：doc 子命令 ----
echo "------------------------------------------"
echo "[6] 主.co doc 子命令"
COCN_TC_CMD=doc COCN_TC_TARGET=/tmp/tc_示例.co COCN_TC_OUTPUT=/tmp/tc_示例.cmd.md \
    COCN_BACKEND=eval \
    run_tc "$TC_DIR/测试框架.co $TC_DIR/格式化器.co $TC_DIR/文档生成器.co $TC_DIR/主.co" \
    && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }

# ---- 7. 端到端测试 测试.co ----
echo "------------------------------------------"
echo "[7] 端到端测试 (测试.co)"
COCN_BACKEND=eval \
    run_tc "$TC_DIR/测试框架.co $TC_DIR/格式化器.co $TC_DIR/文档生成器.co $TC_DIR/测试.co" \
    > /tmp/tc_e2e.txt 2>&1 && pass=$((pass+1)) || { echo "  [FAIL]"; fail=$((fail+1)); }
cat /tmp/tc_e2e.txt | sed 's/^/    /'

echo "================================================"
echo " 结果: ok=$pass fail=$fail"
echo "================================================"
rm -f /tmp/tc_tf.txt /tmp/tc_e2e.txt
[ "$fail" -eq 0 ]
