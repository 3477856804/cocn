/* 对 C 对比 · C 版：k 次中文拼接后取字符长度，默认 k=30000，期望输出 228894。
* 长度按计（UTF-8 continuation 字节不计），与 coCN 语义一致。
* k 来自命令行参数。与对C语言_拼接.co 同题，输出逐字节一致。
*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t utf8_len(const char *s) {
size_t n = 0;
for (const unsigned char *p = (const unsigned char *)s; *p; p++)
if ((*p & 0xC0)!= 0x80) n++;
return n;
}

int main(int argc, char **argv) {
int k_max = argc > 1? atoi(argv[1]): 30000;
size_t cap = 64, len = 0;
char *s = (char *)malloc(cap);
s[0] = '\0';
for (int k = 1; k <= k_max; k++) {
char buf[32];
int m = snprintf(buf, sizeof buf, "项目%d;", k);
while (len + (size_t)m + 1 > cap) { cap *= 2; s = (char *)realloc(s, cap);}
memcpy(s + len, buf, (size_t)m);
len += (size_t)m;
s[len] = '\0';
}
printf("%zu\n", utf8_len(s));
free(s);
return 0;
}
