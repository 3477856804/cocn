#include <unistd.h>
int main(void){
    char x='x';
    for (long i=0;i<1000000L;i++) write(1,&x,1);
    return 0;
}
