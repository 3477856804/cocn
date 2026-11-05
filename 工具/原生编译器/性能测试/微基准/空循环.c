#include <stdio.h>
int main(void){
    volatile long long s=0;
    for (long i=0;i<100000000L;i++) s++;
    printf("RESULT=%lld\n", s);
    return 0;
}
