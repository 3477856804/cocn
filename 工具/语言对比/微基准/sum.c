/* 1e7 累加：n 必须运行期传入，否则 gcc -O2 把循环折成闭式解 */
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv){
    long long n = argc > 1 ? atoll(argv[1]) : 10000000;
    long long s = 0;
    for (long long i = 0; i < n; i++) s += i;
    printf("%lld\n", s);
    return 0;
}
