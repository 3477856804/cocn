/*
 * 07_内存分配/alloc.c —— C 版本（gcc -O3 -march=native）
 * 测试：小对象分配吞吐。对象保持存活不 free，对齐 coCN 无 GC 语义。
 */
#include <stdio.h>
#include <stdlib.h>

#define N 1000000

int main(void) {
    void *ptrs[N];
    long sum = 0;
    for (int i = 0; i < N; i++) {
        ptrs[i] = malloc(24);              /* 与 Box 同尺寸 */
        ((char *)ptrs[i])[0] = (char)i;    /* 写一下防优化 */
        sum += (long)((char *)ptrs[i])[0];
    }
    printf("RESULT=%ld\n", sum);
    return 0;
}
