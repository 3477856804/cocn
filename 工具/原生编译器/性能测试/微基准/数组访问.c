#include <stdio.h>
static int L[100000];
static int rnd(int s){ return (int)(((long long)s*1103515245+12345)&0x7fffffff); }
int main(void){
    for (int i=0;i<100000;i++) L[i]=i;
    int st=42; long long s=0;
    for (long k=0;k<10000000L;k++){ st=rnd(st); s+=L[st%100000]; }
    printf("RESULT=%lld\n", s);
    return 0;
}
