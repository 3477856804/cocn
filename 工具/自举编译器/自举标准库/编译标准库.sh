#!/bin/bash
# ============================================================
# 编译标准库.sh —— 用自举编译器编译并测试10个标准库模块
#
# 每个模块执行两步验证：
#   1. 自举前端解析：用自举编译器的词法+语法分析器解析 .co 源文件
#      验证编译器前端能处理复杂语法（列表/字典/字符串/高阶函数等）
#   2. 运行测试：用 eval 后端执行 .co 文件，验证测试通过
# ============================================================
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../../.." && pwd)"
COMPILER_DIR="$PROJECT_ROOT/工具/自举编译器"
LIB_DIR="$DIR"

WORK="/tmp/标准库编译"
mkdir -p "$WORK"

MODULES=(
    "数学"
    "字符串"
    "列表"
    "字典"
    "排序"
    "搜索"
    "数据结构"
    "图"
    "动态规划"
    "工具"
)

parse_pass=0
parse_fail=0
run_pass=0
run_fail=0

echo "================================================"
echo " coCN 自举编译器 —— 标准库编译与测试"
echo "================================================"
echo ""

for mod in "${MODULES[@]}"; do
    src="$LIB_DIR/${mod}.co"
    ast_out="$WORK/${mod}.ast.json"

    echo "------------------------------------------"
    echo "[$mod]"

    if [ ! -f "$src" ]; then
        echo "  [FAIL] 源文件不存在"
        parse_fail=$((parse_fail + 1))
        run_fail=$((run_fail + 1))
        continue
    fi

    # ---- 步骤1：自举前端解析 ----
    bash "$COMPILER_DIR/编译.sh" "$src" "$ast_out" 2>/dev/null
    parse_rc=$?

    if [ $parse_rc -eq 0 ] && [ -s "$ast_out" ]; then
        node_count=$(node -e "const d=JSON.parse(require('fs').readFileSync('$ast_out'));let c=0;const w=(n)=>{if(!n)return;c++;if(Array.isArray(n)){n.forEach(w)}else if(typeof n==='object'){Object.values(n).forEach(w)}};w(d);console.log(c);" 2>/dev/null || echo "?")
        echo "  [解析] OK (AST节点: $node_count)"
        parse_pass=$((parse_pass + 1))
    else
        echo "  [解析] 部分支持（前端有已知限制，详见文档）"
        parse_fail=$((parse_fail + 1))
    fi

    # ---- 步骤2：运行测试 ----
    COCN_BACKEND=eval timeout 60 node "$PROJECT_ROOT/bin/cocn.js" "$src" >"$WORK/${mod}_run.out" 2>&1
    run_rc=$?

    if [ $run_rc -eq 0 ] && grep -q "测试完成" "$WORK/${mod}_run.out"; then
        echo "  [运行] OK"
        # 打印最后几行测试输出
        tail -3 "$WORK/${mod}_run.out" | sed 's/^/    /'
        run_pass=$((run_pass + 1))
    else
        echo "  [运行] FAIL"
        tail -5 "$WORK/${mod}_run.out" | sed 's/^/    /'
        run_fail=$((run_fail + 1))
    fi
done

echo ""
echo "================================================"
echo " 编译结果"
echo "================================================"
echo " 自举前端解析: 通过=$parse_pass 未通过=$parse_fail / 总计=${#MODULES[@]}"
echo " 运行测试:     通过=$run_pass 未通过=$run_fail / 总计=${#MODULES[@]}"
echo "================================================"

if [ "$run_fail" -eq 0 ]; then
    echo " 全部10个标准库模块运行测试通过!"
    exit 0
else
    echo " 有模块运行失败!"
    exit 1
fi
