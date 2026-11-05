/* 对 C 对比 · C 版：递归斐波那契，默认 fib(35)，期望输出 9227465。
 * n 来自命令行参数（运行期变量），防止 gcc 把递归折叠成常量。
 * 与对C语言_斐波那契.co 同题，输出逐字节一致。
 */
#include <stdio.h>
#include <stdlib.h>

static long long fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 35;
    printf("%lld\n", fib(n));
    return 0;
}
