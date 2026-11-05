#include <stdio.h>
#include <stdlib.h>
int main(void){
    long long s=0;
    for (long i=0;i<1000000L;i++){ void*p=malloc(24); ((char*)p)[0]=(char)i; s+=((char*)p)[0]; free(p); }
    printf("RESULT=%lld\n", s);
    return 0;
}
