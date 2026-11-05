#!/usr/bin/env bash
# ============================================================
# 编译.sh —— coCN 原生编译器驱动
# 用法：bash 编译.sh 程序.co 输出名 [模式]
#   模式：--direct（默认，直接生成机器码 ELF，不依赖 gcc）
#         --asm（传统模式：生成汇编 -> gcc 汇编链接）
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
IN="$1"
OUT="$2"
MODE="${3:---direct}"

if [ -z "$IN" ] || [ -z "$OUT" ]; then
  echo "用法：bash 编译.sh 程序.co 输出名 [--direct|--asm]"
  exit 1
fi

mkdir -p "$DIR/build"

if [ "$MODE" = "--direct" ]; then
  # ---- 直接机器码模式 ----
  echo "[1/1] 直接生成机器码 ELF -> $OUT"
  node "$DIR/机器码生成器.js" "$IN" "$OUT"
  echo "完成：$OUT（直接机器码模式）"
else
  # ---- 传统汇编模式 ----
  ASM="$DIR/build/$OUT.s"
  OBJ="$DIR/build/$OUT.o"

  echo "[1/4] 代码生成 $ASM"
  node "$DIR/入口.js" "$IN" "$ASM"

  echo "[2/4] 汇编 $OBJ"
  gcc -no-pie -c -o "$OBJ" "$ASM"

  echo "[3/4] 编译运行时"
  gcc -no-pie -c -O2 -o "$DIR/build/临时.o" "$DIR/运行时/临时.c"

  echo "[4/4] 链接 $OUT"
  gcc -no-pie -o "$OUT" "$OBJ" "$DIR/build/临时.o"

  echo "完成：$OUT（汇编模式）"
fi
