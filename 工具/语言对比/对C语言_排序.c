/* 对 C 对比 · C 版：n 元倒序数组冒泡排序，默认 n=2000，期望输出 1 / 2000 / 2001000。
 * n 来自命令行参数。与对C语言_排序.co 同题，输出逐字节一致。
 */
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 2000;
    int *a = (int *)malloc((size_t)n * sizeof(int));
    for (int i = 0; i < n; i++) a[i] = n - i;
    for (int pass = 0; pass < n; pass++) {
        for (int j = 0; j < n - 1 - pass; j++) {
            if (a[j] > a[j + 1]) {
                int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
            }
        }
    }
    long long s = 0;
    for (int k = 0; k < n; k++) s += a[k];
    printf("%d\n%d\n%lld\n", a[0], a[n - 1], s);
    free(a);
    return 0;
}
