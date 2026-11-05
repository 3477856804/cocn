/*
 * 05_字符串处理/str.c —— C 版本（gcc -O3 -march=native）
 * 测试：字符串拼接（每次 malloc 新串 + 拷贝旧串）。与 str.co 对齐。
 * 说明：原生编译器无 查找/替换 内置，故基准聚焦「重复拼接」这一最能
 *       体现字符串分配/拷贝开销的操作。
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int main(void) {
    char *s = strdup("The quick brown fox ");
    /* 不 free：对齐 coCN 无 GC/无 free 的语义，否则 C 因复用内存而不公平 */
    for (int i = 0; i < 100000; i++) {
        size_t n = strlen(s);
        char *t = malloc(n + 2);
        memcpy(t, s, n);
        t[n] = 'x'; t[n + 1] = 0;
        s = t;
    }
    long len = (long)strlen(s);
    printf("RESULT=%ld\n", len);
    return 0;
}
