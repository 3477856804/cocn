#!/usr/bin/env bash
# ============================================================
# coCN 运行时编译脚本
#   - 产出静态库 libruntime.a
#   - 产出 test_rt   (无 libc, 纯系统调用)
#   - 产出 test_glibc (对比 glibc)
#   - 运行基准并打印加速比
# ============================================================
set -e

cd "$(dirname "$0")"

# 找 nasm (优先 ~/.local/bin)
if [ -x "$HOME/.local/bin/nasm" ]; then
    NASM="$HOME/.local/bin/nasm"
else
    NASM="nasm"
fi

CC=gcc
CFLAGS="-O3 -nostdlib -ffreestanding -fno-stack-protector -fno-asynchronous-unwind-tables -mavx2 -flto"

echo "[1/4] 汇编 syscall.asm ..."
$NASM -f elf64 syscall.asm -o syscall.o

echo "[2/4] 编译 C 源文件 ..."
for f in alloc string list dict print math; do
    $CC $CFLAGS -c $f.c -o $f.o
done

echo "[3/4] 打包静态库 libruntime.a ..."
rm -f libruntime.a
ar rcs libruntime.a syscall.o alloc.o string.o list.o dict.o print.o math.o

echo "[4/4] 编译测试程序 ..."
# RT 版本 (无 libc)
$CC $CFLAGS -DUSE_RT test.c libruntime.a -o test_rt
# glibc 对比版本
$CC -O3 -flto -DUSE_GLIBC test.c -o test_glibc

echo ""
echo "构建完成:"
ls -la libruntime.a test_rt test_glibc
echo ""

# ------------------------------------------------------------
# 运行基准测试并对比
# ------------------------------------------------------------
echo "============================================================"
echo "  coCN 运行时  vs  glibc  基准测试 (N=1,000,000)"
echo "============================================================"
echo "运行 test_rt ..."
./test_rt 2>/tmp/rt_result.txt >/dev/null
echo "运行 test_glibc ..."
./test_glibc 2>/tmp/glibc_result.txt >/dev/null

echo ""
echo "测试项          coCN(us)    glibc(us)   加速比"
echo "------------------------------------------------------------"
awk '
NR==FNR { rt[$1]=$2; next }
{
    g=$2; r=rt[$1];
    if (r>0 && g>0) {
        ratio = g / r;
        printf "%-14s  %-10ld  %-10ld  %.2fx\n", $1, r, g, ratio;
    }
}
' /tmp/rt_result.txt /tmp/glibc_result.txt
echo "============================================================"
