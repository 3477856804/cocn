/*
 * 08_二叉树遍历/tree.c —— C 版本（gcc -O3 -march=native）
 * 测试：递归中序遍历。用数组表示完全二叉树（左=2i+1, 右=2i+2），
 *       与 tree.co 对齐（coCN 无结构体/指针节点）。
 */
#include <stdio.h>

#define N 1000000
static int T[N];

static long walk(int i) {
    if (i >= N) return 0;
    long ls = walk(2 * i + 1);
    long rs = walk(2 * i + 2);
    return ls + T[i] + rs;
}

int main(void) {
    for (int i = 0; i < N; i++) T[i] = i;
    long s = walk(0);
    printf("RESULT=%ld\n", s);
    return 0;
}
