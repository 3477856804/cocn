#include <stdio.h>
int main(void){
    double d=1.0;
    for (long i=0;i<100000000L;i++){ d=d*1.1+0.1; }
    printf("RESULT=%.10g\n", d);
    return 0;
}
