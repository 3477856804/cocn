#include <stdio.h>
int main(void){
    long long a=12345, b=67890, c=0;
    for (long i=0;i<100000000L;i++){ c=a+b; c=c-a; c=c*3; c=c/2; }
    printf("RESULT=%lld\n", c);
    return 0;
}
