/*
 * 06_哈希表/hashtable.c —— C 版本（gcc -O3 -march=native）
 * 测试：字典插入+查找（字符串键）。
 * 说明：coCN 运行时字典固定 16 桶不扩容，为可对比把 N 取 20000
 *       （C 侧同样 20000，链式哈希）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define N 20000
#define BITS 16
#define TSIZE (1 << BITS)

typedef struct Entry { char *key; long value; struct Entry *next; } Entry;
static Entry *table[TSIZE];

static unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    while (*s) h = ((h << 5) + h) + (unsigned char)(*s++);
    return h & (TSIZE - 1);
}

int main(void) {
    static char keys[N][16];
    for (int i = 0; i < N; i++) snprintf(keys[i], sizeof(keys[i]), "key_%d", i);

    for (int i = 0; i < N; i++) {
        unsigned idx = hash_str(keys[i]);
        Entry *e = malloc(sizeof(Entry));
        e->key = strdup(keys[i]);
        e->value = i * 10;
        e->next = table[idx];
        table[idx] = e;
    }
    long sum = 0;
    for (int i = 0; i < N; i++) {
        unsigned idx = hash_str(keys[i]);
        for (Entry *e = table[idx]; e; e = e->next)
            if (strcmp(e->key, keys[i]) == 0) { sum += e->value; break; }
    }
    printf("RESULT=%ld\n", sum);
    return 0;
}
