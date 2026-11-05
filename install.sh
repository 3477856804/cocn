#!/bin/sh
# ============================================================
# coCN 一键安装（不依赖 npm）
#
#   curl -fsSL https://gitee.com/COSMOnb666/coCN/raw/main/install.sh | sh
#
# 装什么：
#   1) 引导二进制（宿主 C 自举解释器，语义真值参照）—— 按平台/架构下载
#   2) 一个 cocn 命令（转发到引导器跑 .co 程序）
#
# npm 用户不需要这个：直接 npm install -g cocn 即可（更短、还带原生加速器）。
# ============================================================
set -e

PREFIX="${COCN_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
CACHE_DIR="$HOME/.cocn"
VERSION="0.1.35"
RELEASES="https://gitee.com/COSMOnb666/coCN/releases/download/v0.1.0"

say() { printf '\033[34m[coCN]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[coCN!!]\033[0m %s\n' "$1" >&2; exit 1; }

# ---- 平台与架构 ----
case "$(uname -s)" in
    Linux)  PLAT=linux ;;
    Darwin) PLAT=darwin ;;
    MINGW*|MSYS*|CYGWIN*) PLAT=windows ;;
    *) die "不支持的操作系统：$(uname -s)" ;;
esac
case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    armv7l) ARCH=arm ;;
    *) die "不支持的架构：$(uname -m)" ;;
esac

ASSET="coCN-${PLAT}-${ARCH}"
[ "$PLAT" = "windows" ] && ASSET="${ASSET}.exe"
say "平台：${PLAT}/${ARCH}（资源 ${ASSET}）"

mkdir -p "$BIN_DIR" "$CACHE_DIR"

# ---- 下载引导二进制 ----
GUIDE="$CACHE_DIR/引导器"
URL="$RELEASES/$ASSET"
say "下载引导二进制：$URL"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$GUIDE" || die "下载失败：$URL"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$GUIDE" "$URL" || die "下载失败：$URL"
else
    die "需要 curl 或 wget"
fi
chmod +x "$GUIDE" 2>/dev/null || true
[ -s "$GUIDE" ] || die "下载到的文件是空的"

# ---- 装 cocn 命令 ----
cat > "$BIN_DIR/cocn" <<EOF
#!/bin/sh
# coCN 命令（由 install.sh 生成）—— 跑 .co 程序
# 用法: cocn 程序.co [参数...]
GUIDE="$GUIDE"
[ -x "\$GUIDE" ] || GUIDE="\$(dirname "\$0")/../.cocn/引导器"
if [ ! -x "\$GUIDE" ]; then
    echo "[coCN] 未找到引导二进制：\$GUIDE" >&2
    echo "       重新运行 install.sh 即可。" >&2
    exit 1
fi
exec "\$GUIDE" "\$@"
EOF
chmod +x "$BIN_DIR/cocn" 2>/dev/null || true

# ---- 自检 ----
if "$GUIDE" --版本 >/dev/null 2>&1; then
    say "引导器自检通过"
else
    say "（引导器不支持 --版本 参数，跳过自检）"
fi

say "安装完成：$BIN_DIR/cocn"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "提示：把 $BIN_DIR 加入 PATH，例如：export PATH=\"\$PATH:$BIN_DIR\"" ;;
esac
say "试试：echo '输出(\"你好，coCN\")' > hi.co && cocn hi.co"
