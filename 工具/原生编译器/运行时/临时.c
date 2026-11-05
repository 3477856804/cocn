// ============================================================
// 临时.c —— coCN 原生编译器的临时运行时（C 实现）
//
// 由生成的 x86-64 汇编通过 System V AMD64 ABI 调用。
// 后续会被纯汇编运行时取代；当前版本借助 libc 实现内存/IO。
//
// 值表示（Box）：列表/字典元素统一为 Box 指针（8 字节）。
//   tag: 0=int  1=double  2=str  3=list  4=dict  5=none
// 局部标量变量不装箱（int 在 rax、double 在 xmm0、指针在 rax），
// 仅在「进入列表/字典」时装箱，「取出使用」时拆箱。
//
// 性能优化：Box 分配器使用 bump arena 池，避免每次 malloc 开销。
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// ---------------- Box ----------------
typedef struct box {
    int64_t tag;
    union {
        int64_t i;
        double  d;
        char*   s;
        void*   p;
    } u;
} Box;

// ---------------- Box 内存池（bump allocator，分块，绝不大块 reloc） ----------------
// Box 大小 = 16 字节（tag 8 + union 8）。预分配大块 arena，
// 每次 box 分配仅移动指针。空间不够时新开一块，绝不 realloc
// （realloc 会移动内存，使所有已发出的 Box* 失效）。
#define BOX_CHUNK_SIZE (64 * 1024 * 1024)  // 每块 64 MB

typedef struct box_chunk {
    struct box_chunk* next;
    size_t used;
    char   data[];
} BoxChunk;

static BoxChunk* box_chunk_head = NULL;
static BoxChunk* box_chunk_cur  = NULL;

static Box* box_pool_alloc(void) {
    if (box_chunk_cur == NULL ||
        box_chunk_cur->used + sizeof(Box) > BOX_CHUNK_SIZE) {
        BoxChunk* nc = (BoxChunk*)malloc(sizeof(BoxChunk) + BOX_CHUNK_SIZE);
        nc->next = box_chunk_head;
        nc->used = 0;
        box_chunk_head = nc;
        box_chunk_cur  = nc;
    }
    Box* b = (Box*)(box_chunk_cur->data + box_chunk_cur->used);
    box_chunk_cur->used += sizeof(Box);
    return b;
}

Box* rt_box_int(int64_t i) {
    Box* b = box_pool_alloc();
    b->tag = 0; b->u.i = i;
    return b;
}
Box* rt_box_double(double d) {
    Box* b = box_pool_alloc();
    b->tag = 1; b->u.d = d;
    return b;
}
Box* rt_box_str(const char* s) {
    Box* b = box_pool_alloc();
    b->tag = 2;
    b->u.s = (char*)malloc(strlen(s) + 1);
    strcpy(b->u.s, s);
    return b;
}
Box* rt_box_ptr(int64_t tag, void* p) {
    Box* b = box_pool_alloc();
    b->tag = tag; b->u.p = p;
    return b;
}

// 前置声明（列表/字典定义在后）
void rt_print_list(void* L);
void rt_print_dict(void* D);

int64_t  rt_unbox_int(Box* b)    { return b ? b->u.i : 0; }
double   rt_unbox_double(Box* b){ return b ? b->u.d : 0.0; }
char*    rt_unbox_str(Box* b)    { return b ? b->u.s : (char*)""; }
int64_t  rt_box_tag(Box* b)      { return b ? b->tag : 5; }

// ---------------- 内存 ----------------
void* rt_alloc(int64_t n) {
    void* p = malloc((size_t)n);
    if (!p) { fprintf(stderr, "rt_alloc: 内存不足\n"); exit(1); }
    return p;
}

// ---------------- 打印 ----------------
// 打印一个值（不换行），返回打印的类型（供 输出 决定是否加空格）
void rt_print_int(int64_t i)   { printf("%lld", (long long)i); }
void rt_print_double(double d) {
    // 去掉多余的 .0，模仿常见动态语言打印
    if (d == (double)(int64_t)d && d < 1e15 && d > -1e15) {
        printf("%lld.0", (long long)d);
    } else {
        printf("%g", d);
    }
}
void rt_print_str(const char* s) { fputs(s, stdout); }
void rt_print_space(void) { fputc(' ', stdout); }
void rt_print_nl(void)    { fputc('\n', stdout); }

// ---------------- 字符串 ----------------
int64_t rt_str_len(const char* s) { return (int64_t)strlen(s); }

char* rt_str_concat(const char* a, const char* b) {
    size_t la = strlen(a), lb = strlen(b);
    char* r = (char*)malloc(la + lb + 1);
    memcpy(r, a, la);
    memcpy(r + la, b, lb);
    r[la + lb] = '\0';
    return r;
}

int64_t rt_str_eq(const char* a, const char* b) {
    return strcmp(a, b) == 0 ? 1 : 0;
}

// 字符串索引：返回 idx 处的单个字符（malloc 的小字符串，按字节简化）
char* rt_str_at(const char* s, int64_t idx) {
    int64_t n = (int64_t)strlen(s);
    if (idx < 0) idx = n + idx;
    char* r = (char*)malloc(3);
    if (idx < 0 || idx >= n) { r[0] = 0; return r; }
    r[0] = s[idx]; r[1] = 0;
    return r;
}

// 把 Box* 中打包的 list/dict 指针取出
void* rt_box_unbox_ptr(Box* b) {
    return b ? b->u.p : NULL;
}

// ---------------- 数值->字符串：无 malloc 的轮转静态缓冲 ----------------
// 热点路径（如哈希表 D["key_"+转字符串(i)]）每次都调用 int_to_str/double_to_str，
// 每次 malloc+snprintf 成本极高。coCN 中这类返回值几乎总是「立即被
// rt_str_concat / rt_dict_set 消费并复制」，极少长期持有。
// 用 8 个轮转缓冲覆盖「同时存活少量字符串」的常见情形（如 f(转字符串(a),转字符串(b))）。
#define N_TSBUF 8
static char ts_buf[N_TSBUF][40];
static int  ts_idx = 0;

char* rt_int_to_str(int64_t i) {
    char* r = ts_buf[ts_idx];
    ts_idx = (ts_idx + 1) & (N_TSBUF - 1);
    snprintf(r, 40, "%lld", (long long)i);
    return r;
}

char* rt_double_to_str(double d) {
    char* r = ts_buf[ts_idx];
    ts_idx = (ts_idx + 1) & (N_TSBUF - 1);
    if (d == (double)(int64_t)d && d < 1e15 && d > -1e15) {
        snprintf(r, 40, "%lld.0", (long long)d);
    } else {
        snprintf(r, 40, "%g", d);
    }
    return r;
}

// 把任意 Box 打印到 stdout（不换行）
void rt_print_box(Box* b) {
    if (b == NULL) { fputs("空", stdout); return; }
    switch (b->tag) {
        case 0: printf("%lld", (long long)b->u.i); break;
        case 1: rt_print_double(b->u.d); break;
        case 2: fputs(b->u.s, stdout); break;
        case 3: rt_print_list(b->u.p); break;
        case 4: rt_print_dict(b->u.p); break;
        default: fputs("空", stdout); break;
    }
}

// ---------------- 列表（动态数组） ----------------
// List 布局：[capacity(0), length(8), data(16), is_int(24)]
// is_int=0: data 是 Box**  （通用列表，元素装箱）
// is_int=1: data 是 int64_t*（无装箱整数列表，直接存整数）
// 内联代码假设 data 在偏移 16，这对两种模式都成立。
typedef struct list {
    int64_t capacity;
    int64_t length;
    void*   data;
    int64_t is_int;
} List;

List* rt_list_create(void) {
    List* L = (List*)malloc(sizeof(List));
    L->capacity = 16;
    L->length = 0;
    L->data = (Box**)malloc(sizeof(Box*) * 16);
    L->is_int = 0;
    return L;
}

// 无装箱整数列表：data 直接是 int64_t 数组
List* rt_intlist_create(void) {
    List* L = (List*)malloc(sizeof(List));
    L->capacity = 16;
    L->length = 0;
    L->data = (int64_t*)malloc(sizeof(int64_t) * 16);
    L->is_int = 1;
    return L;
}

void rt_list_append(List* L, Box* v) {
    if (L->length >= L->capacity) {
        L->capacity *= 2;
        L->data = realloc(L->data, sizeof(Box*) * L->capacity);
    }
    ((Box**)L->data)[L->length++] = v;
}

// 无装箱整数追加：直接存 int，不经过 Box
void rt_intlist_append(List* L, int64_t v) {
    if (L->length >= L->capacity) {
        L->capacity *= 2;
        L->data = realloc(L->data, sizeof(int64_t) * L->capacity);
    }
    ((int64_t*)L->data)[L->length++] = v;
}

Box* rt_list_get(List* L, int64_t idx) {
    if (idx < 0) idx = L->length + idx;
    return ((Box**)L->data)[idx];
}

void rt_list_set(List* L, int64_t idx, Box* v) {
    if (idx < 0) idx = L->length + idx;
    ((Box**)L->data)[idx] = v;
}

int64_t rt_list_len(List* L) { return L->length; }

// ---------------- 字典（开链哈希表） ----------------
typedef struct dentry {
    char* key;
    Box*  val;
    struct dentry* next;
} DEntry;

typedef struct dict {
    int64_t  size;
    int64_t  count;
    DEntry** buckets;
} Dict;

static uint64_t dhash(const char* s) {
    uint64_t h = 1469598103934665603ULL;
    while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ULL; }
    return h;
}

Dict* rt_dict_create(void) {
    Dict* D = (Dict*)malloc(sizeof(Dict));
    D->size = 64;
    D->count = 0;
    D->buckets = (DEntry**)calloc(64, sizeof(DEntry*));
    return D;
}

static void dict_resize(Dict* D) {
    int64_t oldSize = D->size;
    int64_t newSize = oldSize * 2;
    DEntry** newBuckets = (DEntry**)calloc(newSize, sizeof(DEntry*));
    // 重新哈希所有条目
    for (int64_t i = 0; i < oldSize; i++) {
        DEntry* e = D->buckets[i];
        while (e) {
            DEntry* next = e->next;
            uint64_t h = dhash(e->key) % (uint64_t)newSize;
            e->next = newBuckets[h];
            newBuckets[h] = e;
            e = next;
        }
    }
    free(D->buckets);
    D->buckets = newBuckets;
    D->size = newSize;
}

Box* rt_dict_get(Dict* D, const char* key) {
    uint64_t h = dhash(key) % (uint64_t)D->size;
    DEntry* e = D->buckets[h];
    while (e) {
        if (strcmp(e->key, key) == 0) return e->val;
        e = e->next;
    }
    return NULL; // 缺失：调用方按「空」处理
}

void rt_dict_set(Dict* D, const char* key, Box* v) {
    uint64_t h = dhash(key) % (uint64_t)D->size;
    DEntry* e = D->buckets[h];
    while (e) {
        if (strcmp(e->key, key) == 0) { e->val = v; return; }
        e = e->next;
    }
    DEntry* n = (DEntry*)malloc(sizeof(DEntry));
    n->key = (char*)malloc(strlen(key) + 1);
    strcpy(n->key, key);
    n->val = v;
    n->next = D->buckets[h];
    D->buckets[h] = n;
    D->count++;
    // 负载因子 > 2 时扩容
    if (D->count > D->size * 2) dict_resize(D);
}

int64_t rt_dict_len(Dict* D) { return D->count; }

// 字典键迭代器：返回第 idx 个键（字符串），越界返回 NULL
char* rt_dict_key_at(Dict* D, int64_t idx) {
    int64_t seen = 0;
    for (int64_t i = 0; i < D->size; i++) {
        DEntry* e = D->buckets[i];
        while (e) {
            if (seen == idx) return e->key;
            seen++;
            e = e->next;
        }
    }
    return NULL;
}

// ---------------- 程序入口（由生成代码调用） ----------------
// 生成代码的 _start 不直接用 libc；我们提供一个 main 包装：
// 生成代码导出 co_main()，这里调用它。
extern int64_t co_main(void);

void rt_print_list(void* Lv) {
    List* L = (List*)Lv;
    fputc('[', stdout);
    if (L->is_int) {
        int64_t* data = (int64_t*)L->data;
        for (int64_t i = 0; i < L->length; i++) {
            if (i) fputs(", ", stdout);
            printf("%lld", (long long)data[i]);
        }
    } else {
        for (int64_t i = 0; i < L->length; i++) {
            if (i) fputs(", ", stdout);
            rt_print_box(((Box**)L->data)[i]);
        }
    }
    fputc(']', stdout);
}

void rt_print_dict(void* Dv) {
    Dict* D = (Dict*)Dv;
    fputc('{', stdout);
    int64_t first = 1;
    for (int64_t i = 0; i < D->size; i++) {
        DEntry* e = D->buckets[i];
        while (e) {
            if (!first) fputs(", ", stdout);
            first = 0;
            fputs("\"", stdout); fputs(e->key, stdout); fputs("\": ", stdout);
            rt_print_box(e->val);
            e = e->next;
        }
    }
    fputc('}', stdout);
}

int main(void) {
    int64_t r = co_main();
    return (int)(r & 0xff);
}
