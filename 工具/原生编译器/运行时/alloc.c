/* ============================================================
 * coCN 运行时 —— 内存分配器 (v3, bump pointer + tcache)
 *
 * 设计:
 *   - 每个 size class: tcache 空闲链表 + bump pointer
 *   - tcache 空时, 从 bump pointer 分配 (懒加载, 不预写空闲链表)
 *   - bump pointer 耗尽时, mmap 新 span
 *   - free: 直接 push 到 tcache
 *   - 大对象: mmap, realloc 优先 mremap
 *   - per-object header (P-8): 小对象=size_class, 大对象=总长度
 * ============================================================ */
#include "rt.h"

#define SPAN_SIZE      (64UL * 1024)                  /* 64KB span (减少页错误) */
#define SPAN_MASK      (~(uintptr_t)(SPAN_SIZE - 1))
#define SMALL_MAX      4096UL
#define HDR_SIZE       8UL
#define MREMAP_MAYMOVE 1

#define NUM_CLASSES 29
static const size_t size_classes[NUM_CLASSES] = {
    8, 16, 32, 48, 64, 80, 96, 112, 128,
    160, 192, 224, 256, 320, 384, 448, 512,
    640, 768, 896, 1024, 1280, 1536, 1792, 2048,
    2560, 3072, 3584, 4096
};

typedef struct FreeNode {
    struct FreeNode *next;
} FreeNode;

/* 每个 size class: tcache 链表 + bump pointer */
static FreeNode *tcache[NUM_CLASSES];
static uintptr_t bump_start[NUM_CLASSES];   /* 当前 span 起始 */
static uintptr_t bump_ptr[NUM_CLASSES];     /* 当前分配位置 */
static uintptr_t bump_end[NUM_CLASSES];     /* 当前 span 结束 */

#define MMAP_PROT  (RT_PROT_READ | RT_PROT_WRITE)
#define MMAP_FLAGS (RT_MAP_PRIVATE | RT_MAP_ANON)

/* ------------------------------------------------------------
 * 为 size class 申请新 span (bump pointer 区域)
 * ------------------------------------------------------------ */
static void new_span(int sc) {
    size_t objsize = size_classes[sc];
    size_t slot = (HDR_SIZE + objsize + 15UL) & ~(uintptr_t)15;

    size_t alloc_len = SPAN_SIZE;
    char *raw = (char *)rt_mmap(NULL, alloc_len, MMAP_PROT, MMAP_FLAGS,
                                RT_FD_ANON, 0);
    if ((long)raw < 0) return;

    /* 对象从 span 起始处开始 (无需对齐, 8 字节 header 即可) */
    bump_start[sc] = (uintptr_t)raw;
    bump_ptr[sc]   = (uintptr_t)raw;
    bump_end[sc]   = (uintptr_t)raw + alloc_len;
}

/* ------------------------------------------------------------
 * size class 快速查表
 * ------------------------------------------------------------ */
static uint8_t small_class[257];
static int classes_inited = 0;

static void init_classes(void) {
    if (classes_inited) return;
    int ci = 0;
    for (int s = 0; s <= 256; s++) {
        while (ci < NUM_CLASSES && (int)size_classes[ci] < s) ci++;
        small_class[s] = (uint8_t)ci;
    }
    classes_inited = 1;
}

static inline int size_to_class(size_t size) {
    if (size <= 256) return small_class[size];
    int lo = 0, hi = NUM_CLASSES - 1;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        if (size_classes[mid] < size) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/* ------------------------------------------------------------
 * 大对象分配
 * ------------------------------------------------------------ */
static void *alloc_large(size_t size) {
    size_t total = size + HDR_SIZE + SPAN_SIZE;
    total = (total + SPAN_SIZE - 1) & SPAN_MASK;

    char *raw = (char *)rt_mmap(NULL, total, MMAP_PROT, MMAP_FLAGS,
                                RT_FD_ANON, 0);
    if ((long)raw < 0) return NULL;

    uintptr_t base = ((uintptr_t)raw + SPAN_SIZE - 1) & SPAN_MASK;
    if (base > (uintptr_t)raw)
        rt_munmap(raw, base - (uintptr_t)raw);
    uintptr_t tail = base + total;
    size_t tail_len = (uintptr_t)raw + total - tail;
    if (tail_len > 0) rt_munmap((void *)tail, tail_len);

    /* header 在 span 起始处, 用户指针 = header + 8 */
    *(uint64_t *)base = (uint64_t)total;
    return (void *)(base + HDR_SIZE);
}

/* ============================================================
 * 公共 API
 * ============================================================ */

void *rt_alloc(size_t size) {
    if (unlikely(!classes_inited)) init_classes();
    if (size == 0) size = 1;

    if (unlikely(size > SMALL_MAX))
        return alloc_large(size);

    int sc = size_to_class(size);
    size_t objsize = size_classes[sc];
    size_t slot = (HDR_SIZE + objsize + 15UL) & ~(uintptr_t)15;

    /* 快速路径 1: tcache 有空闲对象 */
    FreeNode *node = tcache[sc];
    if (likely(node != NULL)) {
        tcache[sc] = node->next;
        return (void *)node;
    }

    /* 快速路径 2: bump pointer 还有空间 */
    if (bump_ptr[sc] + slot <= bump_end[sc]) {
        uintptr_t p = bump_ptr[sc];
        bump_ptr[sc] += slot;
        *(uint64_t *)p = (uint64_t)sc;
        return (void *)(p + HDR_SIZE);
    }

    /* 需要新 span */
    new_span(sc);
    uintptr_t p = bump_ptr[sc];
    bump_ptr[sc] += slot;
    *(uint64_t *)p = (uint64_t)sc;
    return (void *)(p + HDR_SIZE);
}

void rt_free(void *ptr) {
    if (!ptr) return;
    uint64_t hdr = *(uint64_t *)((char *)ptr - HDR_SIZE);

    if (hdr < (uint64_t)NUM_CLASSES) {
        int sc = (int)hdr;
        FreeNode *node = (FreeNode *)ptr;
        node->next = tcache[sc];
        tcache[sc] = node;
    } else {
        /* 大对象: munmap. base = ptr - HDR_SIZE */
        uintptr_t base = (uintptr_t)ptr - HDR_SIZE;
        rt_munmap((void *)base, (size_t)hdr);
    }
}

void *rt_realloc(void *ptr, size_t size) {
    if (!ptr) return rt_alloc(size);
    if (size == 0) { rt_free(ptr); return NULL; }

    uint64_t hdr = *(uint64_t *)((char *)ptr - HDR_SIZE);

    if (hdr < (uint64_t)NUM_CLASSES) {
        size_t oldsz = size_classes[(int)hdr];
        if (size <= oldsz) return ptr;

        void *newp = rt_alloc(size);
        if (!newp) return NULL;
        rt_memcpy(newp, ptr, oldsz);
        rt_free(ptr);
        return newp;
    }

    /* 大对象 */
    size_t old_total = (size_t)hdr;
    size_t old_user = old_total - HDR_SIZE;
    if (size <= old_user) return ptr;

    size_t new_total = size + HDR_SIZE + SPAN_SIZE;
    new_total = (new_total + SPAN_SIZE - 1) & SPAN_MASK;

    uintptr_t base = (uintptr_t)ptr - HDR_SIZE;
    void *p = rt_mremap((void *)base, old_total, new_total, MREMAP_MAYMOVE);
    if ((long)p > 0 && p != (void *)-1) {
        *(uint64_t *)p = (uint64_t)new_total;
        return (void *)((char *)p + HDR_SIZE);
    }
    void *newp = rt_alloc(size);
    if (!newp) return NULL;
    rt_memcpy(newp, ptr, old_user < size ? old_user : size);
    rt_free(ptr);
    return newp;
}

void *rt_calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    void *p = rt_alloc(total);
    if (p) rt_memset(p, 0, total);
    return p;
}
