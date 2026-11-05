# ============================================================
# _lib.sh —— 性能测试共享库（构建 + 计时 + 校验）
# 被 跑全部.sh 与各基准的 run.sh 引用。
#
# 设计要点：
#   * coCN 原生编译走 原生编译器/入口.js 生成 .s，再 gcc 汇编链接。
#   * 代码生成器当前输出的浮点存储助记符 `sd` 在 GNU as 下不被接受
#     （应为 `movsd`）。这里仅在汇编前做一次机械等价替换，不改变语义，
#     也不修改 代码生成器.js 本身。
#   * C 与 coCN 一律用「外部墙钟」计时（best-of-3），保证方法一致；
#     程序内部不再内置 clock_gettime。
# ============================================================

# 定位项目根（本文件在 原生编译器/性能测试/_lib.sh）
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$LIB_DIR/../" && pwd)"
PROJECT_ROOT="$(cd "$NATIVE_DIR/../" && pwd)"
BUILD_DIR="$NATIVE_DIR/build"
mkdir -p "$BUILD_DIR"

# 前端：用本目录下冻结的 HEAD 可用编译器副本（工作区的 codegen 正被
# 其他 agent 重写为寄存器分配器，当前输出全 int3，不可用）。
FRONT_END="$LIB_DIR/_toolchain/入口.js"

CC=gcc
CFLAGS="-O3 -march=native -no-pie"

# 编译 C 版本
# 用法: 编译c <in.c> <outbin>
编译c() {
  local in="$1" out="$2"
  $CC $CFLAGS -o "$out" "$in" 2> "$out.cerr" || {
    echo "[C编译失败] $in"; cat "$out.cerr"; return 1;
  }
}

# 编译 coCN 原生版本
# 用法: 编译co <in.co> <outbin>
编译co() {
  local in="$1" out="$2"
  local base s o tmpo
  base="$(basename "$out")"
  s="$BUILD_DIR/${base}.s"
  o="$BUILD_DIR/${base}.o"
  tmpo="$BUILD_DIR/tmp_runtime.o"

  # 1) 代码生成
  node "$FRONT_END" "$in" "$s" 2> "$out.coerr" || {
    echo "[coCN代码生成失败] $in"; cat "$out.coerr"; return 1;
  }
  # 2) 机械修复助记符 sd -> movsd（仅行首指令，不影响 movsd）
  sed -i 's/^\([[:space:]]*\)sd[[:space:]]/\1movsd /' "$s"
  # 3) 汇编
  $CC -no-pie -c -o "$o" "$s" 2> "$out.asmerr" || {
    echo "[coCN汇编失败] $in"; head -20 "$out.asmerr"; return 1;
  }
  # 4) 运行时（只编一次）
  if [ ! -f "$tmpo" ]; then
    $CC -no-pie -c -O2 -o "$tmpo" "$NATIVE_DIR/运行时/临时.c" 2>/dev/null
  fi
  # 5) 链接
  $CC -no-pie -o "$out" "$o" "$tmpo" 2> "$out.lderr" || {
    echo "[coCN链接失败] $in"; cat "$out.lderr"; return 1;
  }
}

# 运行一次，打印 stdout
# 用法: 运行 <bin>
运行() { "$1"; }

# best-of-3 墙钟计时，输出最佳秒（awk）
# 用法: bestof3 <bin>
bestof3() {
  local bin="$1"
  local best=""
  for r in 1 2 3; do
    local t0 t1 dt
    t0=$(date +%s.%N)
    "$bin" >/dev/null 2>&1
    t1=$(date +%s.%N)
    dt=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.4f", a-b}')
    if [ -z "$best" ] || awk -v x="$dt" -v y="$best" 'BEGIN{exit !(x<y)}'; then
      best="$dt"
    fi
  done
  echo "$best"
}
