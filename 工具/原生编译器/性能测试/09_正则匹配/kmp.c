/*
 * 09_正则匹配/kmp.c —— C 版本（gcc -O3 -march=native）
 * 测试：KMP 字符串匹配（与 kmp.co 同文本/同模式/同次数 10000）。
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static void build_next(const char *pat, int *next, int m) {
    next[0] = -1;
    int i = 0, j = -1;
    while (i < m - 1) {
        if (j == -1 || pat[i] == pat[j]) { i++; j++; next[i] = j; }
        else j = next[j];
    }
}

static int kmp_count(const char *text, const char *pat, int n, int m) {
    int *next = malloc((m + 1) * sizeof(int));
    build_next(pat, next, m);
    int i = 0, j = 0, count = 0;
    while (i < n) {
        if (j == -1 || text[i] == pat[j]) {
            i++; j++;
            if (j == m) { count++; j = next[j]; }
        } else {
            j = next[j];
        }
    }
    free(next);
    return count;
}

int main(void) {
    const char *text = "ababcabcabababdababcabcabababdababcabcabababdababcabcabababd";
    const char *pat  = "ababd";
    int n = (int)strlen(text), m = (int)strlen(pat);
    int total = 0;
    for (int k = 0; k < 10000; k++) total += kmp_count(text, pat, n, m);
    printf("RESULT=%d\n", total);
    return 0;
}
