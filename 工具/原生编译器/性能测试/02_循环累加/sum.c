/*
 * 02_循环累加/sum.c —— C 版本（gcc -O3 -march=native）
 * 测试：整数运算、循环开销。外部墙钟计时 best-of-3。
 */
#include <stdio.h>

int main(void) {
    volatile long long sum = 0;          /* 防优化掉 */
    for (long long i = 0; i < 100000000LL; i++) {
        sum += i;
    }
    printf("RESULT=%lld\n", sum);
    return 0;
}
