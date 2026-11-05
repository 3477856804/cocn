#!/bin/bash
# coCN LSP 服务器测试脚本
# 通过管道向 stdio LSP 服务器发送示例 JSON-RPC 消息，验证响应。
set -e

LSP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$LSP_DIR/server.js"

echo "=== coCN LSP 服务器测试 ==="
echo "服务器路径: $SERVER"
echo ""

# 构造一个测试 coCN 文件内容
TEST_DOC='函数 加(整数 a, 整数 b) -> 整数
    返回 a + b
结束

输出 加(3, 5)
'

# 构造 JSON-RPC 消息
# 1. initialize
INIT=$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"processId":%d}}' $$)

# 2. initialized notification
INITIALIZED='{"jsonrpc":"2.0","method":"initialized","params":{}}'

# 3. didOpen
DIDOPEN=$(cat <<EOF
{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///tmp/test.co","languageId":"cocn","version":1,"text":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$TEST_DOC")}}}
EOF
)

# 4. definition 请求（查找 "加" 的定义；第4行 `输出 加(3, 5)`，"加" 在第3列）
DEFINITION=$(cat <<EOF
{"jsonrpc":"2.0","id":2,"method":"textDocument/definition","params":{"textDocument":{"uri":"file:///tmp/test.co"},"position":{"line":4,"character":3}}}
EOF
)

# 5. hover 请求（同样悬停 "加"）
HOVER=$(cat <<EOF
{"jsonrpc":"2.0","id":3,"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///tmp/test.co"},"position":{"line":4,"character":3}}}
EOF
)

# 6. shutdown
SHUTDOWN='{"jsonrpc":"2.0","id":4,"method":"shutdown","params":null}'
EXIT='{"jsonrpc":"2.0","method":"exit"}'

# 打包成带 Content-Length 头的消息序列
pack() {
  local body="$1"
  local len=$(printf '%s' "$body" | wc -c)
  printf 'Content-Length: %d\r\n\r\n%s' "$len" "$body"
}

INPUT=""
INPUT="$INPUT$(pack "$INIT")"
INPUT="$INPUT$(pack "$INITIALIZED")"
INPUT="$INPUT$(pack "$DIDOPEN")"
INPUT="$INPUT$(pack "$DEFINITION")"
INPUT="$INPUT$(pack "$HOVER")"
INPUT="$INPUT$(pack "$SHUTDOWN")"
INPUT="$INPUT$(pack "$EXIT")"

echo "--- 发送消息序列 ---"
echo "1. initialize"
echo "2. initialized"
echo "3. textDocument/didOpen"
echo "4. textDocument/definition (查找 加)"
echo "5. textDocument/hover (悬停 加)"
echo "6. shutdown + exit"
echo ""
echo "--- 服务器输出 ---"

echo "$INPUT" | node "$SERVER" 2>/dev/null | while IFS= read -r line; do
  echo "$line"
done

echo ""
echo "=== 测试完成 ==="
