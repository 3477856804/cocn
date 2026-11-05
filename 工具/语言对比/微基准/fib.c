/* fib(n)：n 运行期传入，否则 gcc 常量折叠 */
#include <stdio.h>
#include <stdlib.h>
static long long fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }
int main(int argc, char **argv){
    int n = argc > 1 ? atoi(argv[1]) : 30;
    printf("%lld\n", fib(n));
    return 0;
}
