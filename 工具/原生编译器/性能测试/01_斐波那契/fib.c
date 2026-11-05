/*
 * 01_斐波那契/fib.c —— C 版本（gcc -O3 -march=native）
 * 测试：递归函数调用开销。外部墙钟计时，best-of-3。
 */
#include <stdio.h>

static int fib(int n) {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

int main(void) {
    volatile int vn = 40;          /* 防常量折叠 */
    int r = fib(vn);
    printf("RESULT=%d\n", r);
    return 0;
}
