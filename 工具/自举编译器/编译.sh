#!/bin/bash
# ============================================================
# 编译.sh —— 自举版编译器前端驱动
# 用法：bash 自举/编译.sh 输入.co 输出.ast.json
#
# 环境变量：
#   COCN_INPUT   输入 .co 文件路径（脚本自动解析为绝对路径）
#   COCN_PRETTY  设为 1 则输出缩进式 JSON（调试用）
#   COCN_DUMP_TOKENS  设为 1 则额外输出 token 列表到 stderr
#
# 步骤：
#   1. 拼接所有自举 .co 模块为一个临时文件
#   2. 用 coCN 解释器 eval 后端运行
#   3. 输出 AST JSON 到指定文件
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"

IN="$1"
OUT="$2"

if [ -z "$IN" ] || [ -z "$OUT" ]; then
    echo "用法：bash 自举/编译.sh 输入.co 输出.ast.json"
    exit 1
fi

# 拼接所有自举源文件（顺序：词法→语法→JSON→调试工具→主入口）
TMP="/tmp/自举_合并_$$.co"
cat "$DIR/词法分析器.co" \
    "$DIR/语法分析器.co" \
    "$DIR/输出JSON.co" \
    "$DIR/输出JSON美化.co" \
    "$DIR/词法调试.co" \
    "$DIR/AST验证.co" \
    "$DIR/测试报告.co" \
    "$DIR/主.co" > "$TMP"

# 解析输入为绝对路径（解释器运行时 cwd=src/，相对路径会失效）
IN_ABS="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")"

# 运行自举编译器前端（必须用 eval 后端，VM 后端字符串索引有 bug）
COCN_INPUT="$IN_ABS" COCN_BACKEND=eval node "$PROJECT_ROOT/bin/cocn.js" "$TMP" > "$OUT"

# 清理临时文件
rm -f "$TMP"
