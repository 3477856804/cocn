/* ============================================================
 * coCN 运行时 —— 列表 (动态数组)
 *   结构: { int length; int capacity; void** items; }
 *   热点路径 (append/get/set/pop) 在 rt.h 中 static inline
 *   扩容走 _rt_list_reserve, 利用 mremap 原地扩展
 * ============================================================ */
#include "rt.h"

#define INIT_CAP 16

rt_list_t *rt_list_create(void) {
    rt_list_t *l = (rt_list_t *)rt_alloc(sizeof(rt_list_t));
    if (!l) return NULL;
    l->length = 0;
    l->capacity = INIT_CAP;
    l->items = (void **)rt_alloc(INIT_CAP * sizeof(void *));
    return l;
}

void _rt_list_reserve(rt_list_t *l, int newcap) {
    if (newcap <= l->capacity) return;
    l->items = (void **)rt_realloc(l->items, (size_t)newcap * sizeof(void *));
    l->capacity = newcap;
}

/* 外部 API 包装 (调用内联版本) */
void rt_list_append(rt_list_t *l, void *val) {
    rt_list_append_inline(l, val);
}

void *rt_list_get(rt_list_t *l, int idx) {
    return rt_list_get_inline(l, idx);
}

void rt_list_set(rt_list_t *l, int idx, void *val) {
    if (idx < 0) return;
    if (idx >= l->capacity) _rt_list_reserve(l, idx + 1);
    l->items[idx] = val;
    if (idx + 1 > l->length) l->length = idx + 1;
}

int rt_list_length(rt_list_t *l) {
    return l->length;
}

void *rt_list_pop(rt_list_t *l) {
    return rt_list_pop_inline(l);
}

void rt_list_insert(rt_list_t *l, int idx, void *val) {
    if (idx < 0) idx = 0;
    if (idx > l->length) idx = l->length;
    if (l->length >= l->capacity)
        _rt_list_reserve(l, l->capacity * 2);
    for (int i = l->length; i > idx; i--)
        l->items[i] = l->items[i - 1];
    l->items[idx] = val;
    l->length++;
}

void rt_list_remove(rt_list_t *l, int idx) {
    if (idx < 0 || idx >= l->length) return;
    for (int i = idx; i < l->length - 1; i++)
        l->items[i] = l->items[i + 1];
    l->length--;
}

rt_list_t *rt_list_concat(rt_list_t *a, rt_list_t *b) {
    rt_list_t *out = rt_list_create();
    int total = a->length + b->length;
    if (total > out->capacity) _rt_list_reserve(out, total);
    for (int i = 0; i < a->length; i++) out->items[i] = a->items[i];
    for (int i = 0; i < b->length; i++) out->items[a->length + i] = b->items[i];
    out->length = total;
    return out;
}

rt_list_t *rt_list_slice(rt_list_t *l, int start, int end) {
    rt_list_t *out = rt_list_create();
    if (start < 0) start = 0;
    if (end > l->length) end = l->length;
    int n = end - start;
    if (n <= 0) return out;
    if (n > out->capacity) _rt_list_reserve(out, n);
    for (int i = 0; i < n; i++) out->items[i] = l->items[start + i];
    out->length = n;
    return out;
}

/* 快速排序: 小规模插入排序, 大规模递归 */
#define INSERTION_THRESHOLD 16

static void insertion_sort(rt_list_t *l, int lo, int hi,
                           int (*cmp)(void *a, void *b)) {
    for (int i = lo + 1; i <= hi; i++) {
        void *key = l->items[i];
        int j = i - 1;
        while (j >= lo && cmp(l->items[j], key) > 0) {
            l->items[j + 1] = l->items[j];
            j--;
        }
        l->items[j + 1] = key;
    }
}

static void qsort_range(rt_list_t *l, int lo, int hi,
                        int (*cmp)(void *a, void *b)) {
    while (hi - lo > INSERTION_THRESHOLD) {
        /* 三取样 pivot */
        int mid = (lo + hi) >> 1;
        if (cmp(l->items[lo], l->items[mid]) > 0) {
            void *t = l->items[lo]; l->items[lo] = l->items[mid]; l->items[mid] = t;
        }
        if (cmp(l->items[lo], l->items[hi]) > 0) {
            void *t = l->items[lo]; l->items[lo] = l->items[hi]; l->items[hi] = t;
        }
        if (cmp(l->items[mid], l->items[hi]) > 0) {
            void *t = l->items[mid]; l->items[mid] = l->items[hi]; l->items[hi] = t;
        }
        void *pivot = l->items[mid];

        int i = lo, j = hi;
        while (i <= j) {
            while (cmp(l->items[i], pivot) < 0) i++;
            while (cmp(l->items[j], pivot) > 0) j--;
            if (i <= j) {
                void *tmp = l->items[i];
                l->items[i] = l->items[j];
                l->items[j] = tmp;
                i++; j--;
            }
        }
        /* 尾递归优化: 先排小的一侧 */
        if (j - lo < hi - i) {
            qsort_range(l, lo, j, cmp);
            lo = i;
        } else {
            qsort_range(l, i, hi, cmp);
            hi = j;
        }
    }
}

void rt_list_sort(rt_list_t *l, int (*cmp)(void *a, void *b)) {
    if (l->length < 2) return;
    qsort_range(l, 0, l->length - 1, cmp);
    insertion_sort(l, 0, l->length - 1, cmp);
}
