#!/bin/bash
# ============================================================
# 跑测试.sh —— 对比 coCN 自举版 与 JS 原生版 的 AST 输出
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"
JS_PARSER="$PROJECT_ROOT/原生编译器/语法分析器.js"
TEST_DIR="$DIR/测试"

pass=0
fail=0

echo "=========================================="
echo "  coCN bootstrap frontend - comparison tests"
echo "=========================================="

for f in "$TEST_DIR"/*.co; do
    name=$(basename "$f" .co)
    echo ""
    echo "Test: $name"

    # 1. JS version
    JS_OUT="/tmp/${name}_js.json"
    node -e "const{解析源}=require('$JS_PARSER');const fs=require('fs');process.stdout.write(JSON.stringify(解析源(fs.readFileSync('$f','utf8'))));" > "$JS_OUT"

    # 2. coCN bootstrap version
    CO_OUT="/tmp/${name}_co.json"
    bash "$DIR/编译.sh" "$f" "$CO_OUT" 2>&1

    # 3. Deep compare
    if node "$DIR/深度比较.js" "$JS_OUT" "$CO_OUT"; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
    fi
done

echo ""
echo "=========================================="
echo "  Result: pass $pass / fail $fail"
echo "=========================================="

if [ $fail -gt 0 ]; then
    exit 1
fi
