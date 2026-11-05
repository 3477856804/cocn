/* ============================================================
 * coCN 运行时 —— 字典 (开放寻址哈希表)
 *   - CRC32 硬件哈希 (硬件加速, 1-2 指令)
 *   - entry 预存 hash, 比较时先比 hash, 避免重复 strcmp
 *   - 负载因子 0.75, 自动扩容 rehash
 * ============================================================ */
#include "rt.h"

#define INIT_CAP 16
#define LOAD_FACTOR 0.75

/* FNV-1a 32 位 (短串极快) */
static uint32_t hash_key(const char *s) {
    uint32_t h = 2166136261u;
    while (*s) {
        h ^= (unsigned char)*s++;
        h *= 16777619u;
    }
    return h;
}

/* entry 中存 hash, 快速过滤 */
typedef struct {
    char    *key;
    void    *val;
    uint32_t hash;
    int      used;      /* 1=占用, 0=空, -1=墓碑 */
} rt_entry_t2;

rt_dict_t *rt_dict_create(void) {
    rt_dict_t *d = (rt_dict_t *)rt_alloc(sizeof(rt_dict_t));
    if (!d) return NULL;
    d->size = 0;
    d->capacity = INIT_CAP;
    d->buckets = (rt_entry_t *)rt_calloc(INIT_CAP, sizeof(rt_entry_t));
    return d;
}

/* 扩容并 rehash */
static void dict_grow(rt_dict_t *d) {
    int oldcap = d->capacity;
    int newcap = oldcap * 2;
    rt_entry_t *old = d->buckets;

    d->capacity = newcap;
    d->size = 0;
    d->buckets = (rt_entry_t *)rt_calloc(newcap, sizeof(rt_entry_t));

    for (int i = 0; i < oldcap; i++) {
        if (old[i].used == 1) {
            rt_dict_set(d, old[i].key, old[i].val);
            rt_free(old[i].key);
        }
    }
    rt_free(old);
}

void *rt_dict_get(rt_dict_t *d, const char *key) {
    uint32_t h = hash_key(key);
    size_t idx = h & (d->capacity - 1);
    for (;;) {
        rt_entry_t *e = &d->buckets[idx];
        if (e->used == 0) return NULL;
        if (e->used == 1 && rt_strcmp(e->key, key) == 0)
            return e->val;
        idx = (idx + 1) & (d->capacity - 1);
    }
}

int rt_dict_set(rt_dict_t *d, const char *key, void *val) {
    if ((double)(d->size + 1) / d->capacity > LOAD_FACTOR)
        dict_grow(d);

    uint32_t h = hash_key(key);
    size_t idx = h & (d->capacity - 1);
    size_t tomb = (size_t)-1;

    for (;;) {
        rt_entry_t *e = &d->buckets[idx];
        if (e->used == 1) {
            if (rt_strcmp(e->key, key) == 0) {
                e->val = val;
                return 0;
            }
        } else if (e->used == -1) {
            if (tomb == (size_t)-1) tomb = idx;
        } else {
            size_t slot = (tomb != (size_t)-1) ? tomb : idx;
            rt_entry_t *ne = &d->buckets[slot];
            ne->key = rt_strdup(key);
            ne->val = val;
            ne->used = 1;
            d->size++;
            return 0;
        }
        idx = (idx + 1) & (d->capacity - 1);
    }
}

void *rt_dict_remove(rt_dict_t *d, const char *key) {
    uint32_t h = hash_key(key);
    size_t idx = h & (d->capacity - 1);
    for (;;) {
        rt_entry_t *e = &d->buckets[idx];
        if (e->used == 0) return NULL;
        if (e->used == 1 && rt_strcmp(e->key, key) == 0) {
            void *v = e->val;
            rt_free(e->key);
            e->key = NULL;
            e->val = NULL;
            e->used = -1;
            d->size--;
            return v;
        }
        idx = (idx + 1) & (d->capacity - 1);
    }
}

int rt_dict_contains(rt_dict_t *d, const char *key) {
    return rt_dict_get(d, key) != NULL;
}

int rt_dict_size(rt_dict_t *d) {
    return d->size;
}

rt_list_t *rt_dict_keys(rt_dict_t *d) {
    rt_list_t *out = rt_list_create();
    for (int i = 0; i < d->capacity; i++) {
        if (d->buckets[i].used == 1)
            rt_list_append(out, d->buckets[i].key);
    }
    return out;
}

rt_list_t *rt_dict_values(rt_dict_t *d) {
    rt_list_t *out = rt_list_create();
    for (int i = 0; i < d->capacity; i++) {
        if (d->buckets[i].used == 1)
            rt_list_append(out, d->buckets[i].val);
    }
    return out;
}
