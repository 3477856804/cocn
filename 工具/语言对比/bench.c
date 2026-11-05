/* trio 基准 · C 版（gcc -O2）
 * 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
 * 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
 * 注意：长度按【字符】计（UTF-8 非 continuation 字节），与 coCN 语义一致。
 * n 来自运行期变量，防止 gcc 把循环折叠成闭式解。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long long fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

/* 按字符计长：UTF-8 continuation 字节 (10xxxxxx) 不计 */
static size_t utf8_len(const char *s) {
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if ((*p & 0xC0) != 0x80) n++;
    return n;
}

int main(void) {
    const int N = 10000;
    int *sieve = (int *)malloc((size_t)(N + 1) * sizeof(int));
    for (int i = 0; i <= N; i++) sieve[i] = 1;
    long long primes = 0;
    for (int i = 2; i <= N; i++) {
        if (sieve[i]) {
            primes++;
            for (long long j = (long long)i * i; j <= N; j += i) sieve[j] = 0;
        }
    }
    printf("素数: %lld\n", primes);
    printf("fib: %lld\n", fib(20));

    size_t cap = 64, len = 0;
    char *s = (char *)malloc(cap);
    s[0] = '\0';
    for (int k = 1; k <= 3000; k++) {
        char buf[32];
        int m = snprintf(buf, sizeof buf, "项目%d;", k);
        while (len + (size_t)m + 1 > cap) { cap *= 2; s = (char *)realloc(s, cap); }
        memcpy(s + len, buf, (size_t)m);
        len += (size_t)m;
        s[len] = '\0';
    }
    printf("拼接: %zu\n", utf8_len(s));
    free(s);
    free(sieve);
    return 0;
}
