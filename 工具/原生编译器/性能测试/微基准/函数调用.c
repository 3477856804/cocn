#include <stdio.h>
static int f(int x){ return x; }
int main(void){
    volatile long long s = 0;
    for (long i = 0; i < 100000000L; i++) s += f((int)i);
    printf("RESULT=%lld\n", s);
    return 0;
}
