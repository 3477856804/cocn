/*
 * 04_快速排序/qsort.c —— C 版本（gcc -O3 -march=native）
 * 测试：递归分区 + 交换。Hoare 分区，与 qsort.co 同算法、同 LCG。
 */
#include <stdio.h>

#define N 1000000

static int arr[N];

static int rnd(int s) { return (int)(((long long)s * 1103515245 + 12345) & 0x7fffffff); }

static void qsortc(int lo, int hi) {
    if (lo >= hi) return;
    int pivot = arr[(lo + hi) / 2];
    int i = lo, j = hi;
    while (i <= j) {
        while (arr[i] < pivot) i++;
        while (arr[j] > pivot) j--;
        if (i <= j) {
            int t = arr[i]; arr[i] = arr[j]; arr[j] = t;
            i++; j--;
        }
    }
    qsortc(lo, j);
    qsortc(i, hi);
}

int main(void) {
    int st = 42;
    for (int i = 0; i < N; i++) { st = rnd(st); arr[i] = st; }
    qsortc(0, N - 1);
    printf("RESULT=%d,%d\n", arr[0], arr[N - 1]);
    return 0;
}
