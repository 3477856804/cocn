/*
 * 10_数值积分/pi.c —— C 版本（gcc -O3 -march=native）
 * 测试：浮点运算 + 随机数 + 循环。用与 pi.co 相同的 LCG，保证可比。
 */
#include <stdio.h>

static int rnd(int s) { return (int)(((long long)s * 1103515245 + 12345) & 0x7fffffff); }

int main(void) {
    int st = 42;
    long inside = 0;
    for (long i = 0; i < 100000000L; i++) {
        st = rnd(st); long r1 = st;
        st = rnd(st); long r2 = st;
        double x = (double)r1 / 2147483648.0;
        double y = (double)r2 / 2147483648.0;
        if (x * x + y * y <= 1.0) inside++;
    }
    printf("RESULT=%ld\n", inside);
    return 0;
}
