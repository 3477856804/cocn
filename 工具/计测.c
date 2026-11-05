/* coCN 跑分计测器 —— fork/exec/wait 环路计时
 *
 * 为什么不用 shell 的 time：一次 `time ./prog` 里，bash 自身的 fork、
 * date 的 fork、管道都混进读数，测到的“启动开销”是 shell 的，不是语言运行时的。
 * 本计测器在同一个进程里连续 fork+exec+wait 目标程序 N 次：
 *   - 总耗时：从 fork 前到 waitpid 返回（含 execve、动态链接、运行时初始化、计算、退出）
 *   - 最快值：取最小样本，抗调度噪声
 *   子进程输出可选重定向到 /dev/null（COCN_NULL=1），排除终端写开销。
 *
 * 用法: 计测 <可执行文件> [参数...]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>

#define N 200

static long long diff_us(const struct timespec *a, const struct timespec *b) {
    return (b->tv_sec - a->tv_sec) * 1000000LL + (b->tv_nsec - a->tv_nsec) / 1000LL;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "用法: %s 可执行文件 [参数...]\n", argv[0]); return 1; }
    int null_out = getenv("COCN_NULL") != NULL;

    /* 预热：让页缓存、动态链接器缓存先热起来 */
    for (int w = 0; w < 20; w++) {
        pid_t p = fork();
        if (p == 0) {
            if (null_out) { int fd = open("/dev/null", O_WRONLY); dup2(fd, 1); dup2(fd, 2); }
            execv(argv[1], argv + 1);
            _exit(127);
        }
        int st; waitpid(p, &st, 0);
    }

    long long total = 0, best = 1LL << 60;
    int bad = 0;
    for (int i = 0; i < N; i++) {
        struct timespec a, b;
        clock_gettime(CLOCK_MONOTONIC, &a);
        pid_t p = fork();
        if (p < 0) { perror("fork"); return 1; }
        if (p == 0) {
            if (null_out) { int fd = open("/dev/null", O_WRONLY); dup2(fd, 1); dup2(fd, 2); }
            execv(argv[1], argv + 1);
            _exit(127);
        }
        int st; waitpid(p, &st, 0);
        clock_gettime(CLOCK_MONOTONIC, &b);
        if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) bad++;
        long long us = diff_us(&a, &b);
        total += us;
        if (us < best) best = us;
    }
    /* 基线：同样的环路空转（exec 一个 _exit(0) 的最小程序）由调用方另行测量后相减 */
    printf("平均 %lld us | 最快 %lld us | 失败 %d\n", total / N, best, bad);
    return bad ? 1 : 0;
}
