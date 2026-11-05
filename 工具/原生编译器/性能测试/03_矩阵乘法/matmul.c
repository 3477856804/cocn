/*
 * 03_矩阵乘法/matmul.c —— C 版本（gcc -O3 -march=native）
 * 测试：嵌套循环 + 内存访问（整数矩阵，与 coCN 类型系统对齐）
 * 说明：原生编译器对「列表中的浮点」拆箱有缺陷，故本基准用整数矩阵，
 *       C 与 coCN 使用完全相同的填充公式与三重循环。
 */
#include <stdio.h>

#define N 200

int main(void) {
    static int A[N][N], B[N][N], C[N][N];
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++) {
            A[i][j] = (i * 7 + j * 13) % 100;
            B[i][j] = (i * 11 + j * 5) % 100;
        }

    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++) {
            int s = 0;
            for (int k = 0; k < N; k++)
                s += A[i][k] * B[k][j];
            C[i][j] = s;
        }

    printf("RESULT=%d,%d\n", C[0][0], C[N - 1][N - 1]);
    return 0;
}
