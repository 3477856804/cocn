/*
 * 微基准/内存访问.c —— C 版本
 * 测试：数组随机访问
 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define SIZE 1000000

int main(void) {
    int *arr = malloc(SIZE * sizeof(int));
    srand(42);
    for (int i = 0; i < SIZE; i++) arr[i] = rand();

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    volatile long sum = 0;
    for (int i = 0; i < 10000000; i++) {
        int idx = rand() % SIZE;
        sum += arr[idx];
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    printf("sum = %ld\n", sum);
    printf("TIME_C=%.6f\n", elapsed);

    free(arr);
    return 0;
}
