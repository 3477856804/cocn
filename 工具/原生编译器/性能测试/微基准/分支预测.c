/*
 * 微基准/分支预测.c —— C 版本
 * 测试：随机分支对分支预测的影响
 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void) {
    int n = 1000000;
    int *data = malloc(n * sizeof(int));
    srand(42);
    for (int i = 0; i < n; i++) data[i] = rand() % 100;

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    long sum = 0;
    for (int rep = 0; rep < 100; rep++) {
        for (int i = 0; i < n; i++) {
            if (data[i] >= 50) {
                sum += data[i];
            } else {
                sum -= data[i];
            }
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    printf("sum = %ld\n", sum);
    printf("TIME_C=%.6f\n", elapsed);

    free(data);
    return 0;
}
