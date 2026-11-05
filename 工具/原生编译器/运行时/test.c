/* ============================================================
 * coCN 运行时 —— 基准测试
 *
 * 编译两种版本:
 *   USE_RT    : 链接 libruntime.a, 用 rt_*   (无 libc)
 *   USE_GLIBC : 用 glibc malloc/strlen/printf 等做对比
 *
 * 每个测试输出一行:  <name>\t<us>
 * build.sh 运行两者后计算加速比。
 * ============================================================ */

#ifdef USE_GLIBC
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
static long now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long)ts.tv_sec * 1000000L + (long)ts.tv_nsec / 1000L;
}
/* 计时结果写到 stderr (fd 2), 避免被 print 测试的大量输出污染 */
#define REPORT(name, us) fprintf(stderr, "%s\t%ld\n", name, us)
#else
#include "rt.h"
static long now_us(void) { return rt_monotonic_us(); }
/* 把 "name\tus\n" 写到 fd 2 (stderr) */
static void report(const char *name, long us) {
    char buf[64];
    int n = 0;
    for (const char *c = name; *c; c++) buf[n++] = *c;
    buf[n++] = '\t';
    char tmp[24]; int t = 0;
    if (us == 0) tmp[t++] = '0';
    while (us > 0) { tmp[t++] = '0' + (char)(us % 10); us /= 10; }
    while (t > 0) buf[n++] = tmp[--t];
    buf[n++] = '\n';
    rt_write(2, buf, (size_t)n);
}
#define REPORT(name, us) report(name, us)
#endif

#define N 1000000

/* ------------------------------------------------------------
 * 1. 内存分配: 100 万次小对象分配 + 释放
 * ------------------------------------------------------------ */
static void bench_alloc(void) {
    void *ptrs[1024];
    for (int i = 0; i < 1024; i++) {
#ifdef USE_GLIBC
        ptrs[i] = malloc(64);
#else
        ptrs[i] = rt_alloc(64);
#endif
    }
    long t0 = now_us();
    for (int i = 0; i < N; i++) {
        int slot = i & 1023;
#ifdef USE_GLIBC
        free(ptrs[slot]);
        ptrs[slot] = malloc(64);
#else
        rt_free(ptrs[slot]);
        ptrs[slot] = rt_alloc(64);
#endif
    }
    long t1 = now_us();
    for (int i = 0; i < 1024; i++) {
#ifdef USE_GLIBC
        free(ptrs[i]);
#else
        rt_free(ptrs[i]);
#endif
    }
    REPORT("alloc", t1 - t0);
}

/* ------------------------------------------------------------
 * 2. 字符串: 100 万次 strlen + strcpy
 * ------------------------------------------------------------ */
static void bench_string(void) {
    char src[128];
    for (int i = 0; i < 127; i++) src[i] = 'a';
    src[127] = 0;
    volatile char dst[128];

    long t0 = now_us();
    volatile size_t total = 0;
    for (int i = 0; i < N; i++) {
#ifdef USE_GLIBC
        total += strlen(src);
        strcpy((char *)dst, src);
#else
        total += rt_strlen(src);
        rt_strcpy((char *)dst, src);
#endif
    }
    long t1 = now_us();
    (void)total;
    REPORT("string", t1 - t0);
}

/* ------------------------------------------------------------
 * 3. 列表: 100 万次 append (裸数组 + realloc, 公平对比分配器)
 * ------------------------------------------------------------ */
static void bench_list(void) {
#ifdef USE_GLIBC
    int cap = 16, len = 0;
    void **items = malloc(cap * sizeof(void *));
#else
    int cap = 16, len = 0;
    void **items = rt_alloc(cap * sizeof(void *));
#endif
    long t0 = now_us();
    for (int i = 0; i < N; i++) {
        if (len >= cap) {
            cap *= 2;
#ifdef USE_GLIBC
            items = realloc(items, cap * sizeof(void *));
#else
            items = rt_realloc(items, cap * sizeof(void *));
#endif
        }
        items[len++] = (void *)(long)i;
    }
    long t1 = now_us();
#ifdef USE_GLIBC
    free(items);
#else
    rt_free(items);
#endif
    REPORT("list", t1 - t0);
}

/* ------------------------------------------------------------
 * 4. 字典: 100 万次 set + get
 * ------------------------------------------------------------ */
static void bench_dict(void) {
#ifdef USE_GLIBC
    /* glibc 侧: 简易开放寻址哈希表 (FNV-1a), 不可被 DCE 消除 */
    int cap = 64;
    char *keys[64];
    void *vals[64];
    int used[64];
    for (int i = 0; i < cap; i++) { keys[i] = NULL; vals[i] = NULL; used[i] = 0; }
    long t0 = now_us();
    unsigned long acc = 0;
    for (int i = 0; i < N; i++) {
        char k[16];
        k[0] = 'k'; k[1] = '0' + (i % 10); k[2] = 0;
        /* FNV-1a */
        unsigned int h = 2166136261u;
        for (int j = 0; k[j]; j++) { h ^= k[j]; h *= 16777619u; }
        int idx = h & (cap - 1);
        while (used[idx] && strcmp(keys[idx], k) != 0) idx = (idx + 1) & (cap - 1);
        if (!used[idx]) {
            keys[idx] = strdup(k);
            used[idx] = 1;
        }
        vals[idx] = (void *)(long)i;
        acc += (unsigned long)vals[idx];
    }
    long t1 = now_us();
    (void)acc;
#else
    rt_dict_t *d = rt_dict_create();
    char keys[2048][16];
    long t0 = now_us();
    for (int i = 0; i < N; i++) {
        int idx = i & 2047;
        keys[idx][0] = 'k';
        keys[idx][1] = '0' + (i % 10);
        keys[idx][2] = 0;
        rt_dict_set(d, keys[idx], (void *)(long)i);
        void *v = rt_dict_get(d, keys[idx]);
        (void)v;
    }
    long t1 = now_us();
#endif
    REPORT("dict", t1 - t0);
}

/* ------------------------------------------------------------
 * 5. 打印: 100 万次 print_int (rt 走缓冲, glibc 走 printf)
 * ------------------------------------------------------------ */
static void bench_print(void) {
    long t0 = now_us();
    for (int i = 0; i < N; i++) {
#ifdef USE_GLIBC
        printf("%d\n", i);
#else
        rt_print_int(i);
        rt_print_newline();
#endif
    }
    long t1 = now_us();
#ifdef USE_RT
    rt_flush();
#endif
    REPORT("print", t1 - t0);
}

/* ------------------------------------------------------------
 * main
 * ------------------------------------------------------------ */
int main(void) __attribute__((used));
int main(void) {
    bench_alloc();
    bench_string();
    bench_list();
    bench_dict();
    bench_print();
    return 0;
}

/* RT 模式下需要 _start (无 crt0) */
#ifdef USE_RT
__asm__(
".global _start\n"
"_start:\n"
"    and  $-16, %rsp\n"
"    call main\n"
"    mov  %eax, %edi\n"
"    mov  $60, %rax\n"
"    syscall\n"
);
#endif
