/* 对 C 对比 · C 版：1 到 n 累加，默认 n=100000000，期望输出 5000000050000000。
 * n 来自命令行参数（运行期变量），防止 gcc 把循环折叠成闭式解。
 * 与对C语言_累加.co 同题，输出逐字节一致。
 */
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    long long n = argc > 1 ? atoll(argv[1]) : 100000000LL;
    long long s = 0;
    for (long long i = 1; i <= n; i++) s += i;
    printf("%lld\n", s);
    return 0;
}
