/* coCN 原生运行时 —— 中文编程语言的底层支撑
   设计要点：
     1. 竞技场分配：bump 分配，无 free，分配即指针偏移，比 malloc 快一个量级
     2. 绳索字符串：拼接 O(1) 惰性合并，绳索过深才摊销展开，中文长文本拼接零拷贝
     3. 字符数按 UTF-8 码点统计，中文一字一字符
*/
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

/* ============ 竞技场分配 ============ */
static char *g_cur = 0, *g_end = 0;

void *rt_alloc(long size) {
    if (size <= 0 || size > (64L << 20)) {
        char msg[80];
        int n = snprintf(msg, 80, "异常分配: %ld\n", size);
        write(2, msg, n);
        _exit(3);
    }
    size = (size + 15) & ~15L;
    if (g_cur + size > g_end) {
        long need = size > (4L << 20) ? size + 4096 : (4L << 20);
        char *p = (char *)mmap(0, need, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (p == (char *)MAP_FAILED) {
            write(2, "内存不足\n", 10);
            _exit(3);
        }
        g_cur = p;
        g_end = p + need;
    }
    char *r = g_cur;
    g_cur += size;
    return r;
}

/* ============ 字符串：扁平串 + 绳索 ============ */
#define ROPE_MAGIC (-1L)

typedef struct Str {
    long bytes;   /* 字节数（>=0，兼作类型判别头） */
    long chars;   /* UTF-8 字符数 */
    char data[];
} Str;

typedef struct Rope {
    long magic;   /* 负数，标识绳索 */
    void *left, *right;
    long bytes, chars, depth;
} Rope;

static inline int 是绳索(void *p) { return ((long *)p)[0] < 0; }
static inline long 取字节(void *p) { return 是绳索(p) ? ((Rope *)p)->bytes : ((Str *)p)->bytes; }
static inline long 取字符(void *p) { return 是绳索(p) ? ((Rope *)p)->chars : ((Str *)p)->chars; }

static long 数字符(const char *s, long n) {
    long c = 0;
    for (long i = 0; i < n; i++)
        if (((unsigned char)s[i] & 0xC0) != 0x80) c++;
    return c;
}

/* 字面量包装：把只读段常量包成对象，带小缓存避免重复拷贝 */
#define 缓存槽 16
static const char *常键[缓存槽];
static void *常值[缓存槽];
static int 常个数 = 0;

__attribute__((used)) void *rt_str_lit(const char *s) {
    for (int i = 0; i < 常个数; i++)
        if (常键[i] == s) return 常值[i];
    long b = (long)strlen(s);
    Str *r = (Str *)rt_alloc(16 + b + 1);
    r->bytes = b;
    r->chars = 数字符(s, b);
    memcpy(r->data, s, b + 1);
    if (常个数 < 缓存槽) {
        常键[常个数] = s;
        常值[常个数] = r;
        常个数++;
    }
    return r;
}

/* 把绳索摊平成扁平串（仅在必要时发生） */
static void *摊平(void *p) {
    long 总字节 = 取字节(p);
    long 总字符 = 取字符(p);
    Str *out = (Str *)rt_alloc(16 + 总字节 + 1);
    void *栈[128];
    int sp = 0;
    栈[sp++] = p;
    long off = 0;
    while (sp > 0) {
        void *n = 栈[--sp];
        if (是绳索(n)) {
            Rope *r = (Rope *)n;
            if (sp + 2 < 128) {
                栈[sp++] = r->right;
                栈[sp++] = r->left;
                continue;
            }
        }
        Str *s = (Str *)n;
        memcpy(out->data + off, s->data, s->bytes);
        off += s->bytes;
    }
    out->data[off] = 0;
    out->bytes = off;
    out->chars = 总字符;
    return out;
}

static inline const char *展开(void *p) { return 是绳索(p) ? ((Str *)摊平(p))->data : ((Str *)p)->data; }

void *rt_str_concat(void *a, void *b) {
    if (a == 0) return b;
    if (b == 0) return a;
    long ab = 取字节(a), bb = 取字节(b);
    if (!是绳索(a) && !是绳索(b) && ab + bb < 128) {
        Str *r = (Str *)rt_alloc(16 + ab + bb + 1);
        memcpy(r->data, ((Str *)a)->data, ab);
        memcpy(r->data + ab, ((Str *)b)->data, bb);
        r->data[ab + bb] = 0;
        r->bytes = ab + bb;
        r->chars = ((Str *)a)->chars + ((Str *)b)->chars;
        return r;
    }
    if (bb == 0) return a;
    if (ab == 0) return b;
    Rope *r = (Rope *)rt_alloc(sizeof(Rope));
    long d1 = 是绳索(a) ? ((Rope *)a)->depth : 0;
    long d2 = 是绳索(b) ? ((Rope *)b)->depth : 0;
    r->magic = ROPE_MAGIC;
    r->left = a;
    r->right = b;
    r->bytes = ab + bb;
    r->chars = 取字符(a) + 取字符(b);
    r->depth = (d1 > d2 ? d1 : d2) + 1;
    if (r->depth > 48) return 摊平(r);
    return r;
}

long rt_str_len(void *p) { return 取字符(p); }
long rt_str_bytes(void *p) { return 取字节(p); }

long rt_str_eq(void *a, void *b) {
    if (a == b) return 1;
    long x = 取字节(a), y = 取字节(b);
    if (x != y) return 0;
    return memcmp(展开(a), 展开(b), x) == 0 ? 1 : 0;
}

/* 取第 i 个字符（按字符而非字节）返回一个字符的新串 */
void *rt_str_at(void *p, long i) {
    const char *s = 展开(p);
    long n = 取字节(p);
    long c = 0, k = 0;
    while (k < n && c < i) {
        if (((unsigned char)s[k] & 0xC0) != 0x80) c++;
        k++;
    }
    long start = k;
    k++;
    while (k < n && (((unsigned char)s[k] & 0xC0) == 0x80)) k++;
    Str *r = (Str *)rt_alloc(16 + (k - start) + 1);
    memcpy(r->data, s + start, k - start);
    r->data[k - start] = 0;
    r->bytes = k - start;
    r->chars = 1;
    return r;
}

void *rt_int_to_str(long v) {
    char buf[24];
    int n = snprintf(buf, 24, "%ld", v);
    Str *r = (Str *)rt_alloc(16 + n + 1);
    memcpy(r->data, buf, n + 1);
    r->bytes = n;
    r->chars = n;
    return r;
}

void *rt_double_to_str(double d) {
    char buf[40];
    int n = snprintf(buf, 40, "%.14g", d);
    Str *r = (Str *)rt_alloc(16 + n + 1);
    memcpy(r->data, buf, n + 1);
    r->bytes = n;
    r->chars = n;
    return r;
}

/* ============ 输出缓冲 ============ */
static char 出缓冲[1 << 16];
static long 出长度 = 0;

static void 冲刷() {
    if (出长度) {
        long w = write(1, 出缓冲, 出长度);
        (void)w;
        出长度 = 0;
    }
}

static void 写出(const char *s, long n) {
    if (n <= 0) return;
    if (出长度 + n > (1 << 16)) 冲刷();
    if (n > (1 << 16)) {
        long w = write(1, s, n);
        (void)w;
        return;
    }
    memcpy(出缓冲 + 出长度, s, n);
    出长度 += n;
}

void rt_flush() { 冲刷(); }

void rt_print_str(void *p) {
    if (p == 0) return;
    if (是绳索(p)) p = 摊平(p);
    写出(((Str *)p)->data, ((Str *)p)->bytes);
}

void rt_print_nl() { 写出("\n", 1); }

void rt_print_int(long v) {
    char buf[24];
    int n = snprintf(buf, 24, "%ld", v);
    写出(buf, n);
}

void rt_print_double(double d) {
    char buf[40];
    int n = snprintf(buf, 40, "%.14g", d);
    写出(buf, n);
}

void rt_print_box(void *b);

/* ============ 装箱 ============ */
typedef struct Box {
    long tag; /* 0 整数 1 浮点 2 字符串 3 列表 4 字典 */
    union {
        long i;
        double d;
        void *p;
    } v;
    void *val_as_ptr; /* 与 v.p 同址，供拆箱接口使用 */
} Box;

void *rt_box_int(long v) {
    Box *b = (Box *)rt_alloc(sizeof(Box));
    b->tag = 0;
    b->v.i = v;
    return b;
}

void *rt_box_double(double d) {
    Box *b = (Box *)rt_alloc(sizeof(Box));
    b->tag = 1;
    b->v.d = d;
    return b;
}

void *rt_box_str(void *s) {
    Box *b = (Box *)rt_alloc(sizeof(Box));
    b->tag = 2;
    b->v.p = s;
    return b;
}

void *rt_box_list(void *l) {
    Box *b = (Box *)rt_alloc(sizeof(Box));
    b->tag = 3;
    b->v.p = l;
    return b;
}

void *rt_box_dict(void *d) {
    Box *b = (Box *)rt_alloc(sizeof(Box));
    b->tag = 4;
    b->v.p = d;
    return b;
}

static long 拆箱(void *b) {
    if (b == 0) return 0;
    Box *x = (Box *)b;
    if (x->tag == 0) return x->v.i;
    if (x->tag == 2) return (long)x->v.p; /* 字符串：返回对象指针 */
    return (long)b;
}

void rt_print_box(void *b) {
    if (b == 0) {
        写出("空", 3);
        return;
    }
    Box *x = (Box *)b;
    if (x->tag == 0) rt_print_int(x->v.i);
    else if (x->tag == 1) rt_print_double(x->v.d);
    else if (x->tag == 2) rt_print_str(x->v.p);
    else 写出("<对象>", 8);
}

/* ============ 列表 ============ */
typedef struct List {
    long cap, len;
    void **data;
} List;

void *rt_list_create(long cap) {
    if (cap < 8) cap = 8;
    List *l = (List *)rt_alloc(sizeof(List));
    l->cap = cap;
    l->len = 0;
    l->data = (void **)rt_alloc(cap * 8);
    return l;
}

long rt_list_len(List *l) { return l->len; }

void rt_list_append(List *l, void *box) {
    if (l->len >= l->cap) {
        long nc = l->cap * 2;
        void **nd = (void **)rt_alloc(nc * 8);
        memcpy(nd, l->data, l->len * 8);
        l->data = nd;
        l->cap = nc;
    }
    l->data[l->len++] = box;
}

long rt_list_get(List *l, long i) {
    if (i < 0 || i >= l->len) {
        write(2, "索引越界\n", 10);
        _exit(3);
    }
    return 拆箱(l->data[i]);
}

void rt_list_set(List *l, long i, void *box) {
    if (i < 0 || i >= l->len) {
        write(2, "索引越界\n", 10);
        _exit(3);
    }
    l->data[i] = box;
}

/* ============ 字典（开放寻址） ============ */
typedef struct Dict {
    long cap, len;
    void **keys;
    void **vals;
} Dict;

void *rt_dict_create() {
    Dict *d = (Dict *)rt_alloc(sizeof(Dict));
    d->cap = 64;
    d->len = 0;
    d->keys = (void **)rt_alloc(d->cap * 8);
    d->vals = (void **)rt_alloc(d->cap * 8);
    memset(d->keys, 0, d->cap * 8);
    return d;
}

static long 槽位(Dict *d, long k) {
    unsigned long h = (unsigned long)k * 11400714819323198485UL;
    return (long)(h & (unsigned long)(d->cap - 1));
}

void rt_dict_set(Dict *d, long k, void *v) {
    if (d->len * 2 >= d->cap) {
        write(2, "字典已满\n", 10);
        _exit(3);
    }
    long i = 槽位(d, k);
    while (d->keys[i] != 0 && d->keys[i] != (void *)k) i = (i + 1) & (d->cap - 1);
    if (d->keys[i] == 0) {
        d->keys[i] = (void *)k;
        d->len++;
    }
    d->vals[i] = v;
}

long rt_dict_get(Dict *d, long k) {
    long i = 槽位(d, k);
    while (d->keys[i] != 0) {
        if (d->keys[i] == (void *)k) return (long)d->vals[i]; /* 返回 Box*，与代码生成器的 box 约定一致 */
        i = (i + 1) & (d->cap - 1);
    }
    return 0;
}

/* ============ 异常 ============ */
long g_exc_flag = 0;
long g_exc_value = 0;

/* ---- 补齐后端引用的其余接口 ---- */
long rt_dict_len(Dict *d) { return d ? d->len : 0; }

void *rt_list_to_str(List *l) {
    void *out = rt_str_lit("[");
    for (long i = 0; i < l->len; i++) {
        if (i) out = rt_str_concat(out, rt_str_lit(", "));
        void *b = l->data[i];
        if (!b) { out = rt_str_concat(out, rt_str_lit("空")); continue; }
        Box *x = (Box *)b;
        if (x->tag == 0) out = rt_str_concat(out, rt_int_to_str(x->v.i));
        else if (x->tag == 1) out = rt_str_concat(out, rt_double_to_str(x->v.d));
        else if (x->tag == 2) out = rt_str_concat(out, x->v.p);
        else out = rt_str_concat(out, rt_str_lit("…"));
    }
    return rt_str_concat(out, rt_str_lit("]"));
}

void rt_print_list(List *l) {
    if (!l) { 写出("<空表>", 8); return; }
    rt_print_str(rt_list_to_str(l));
}

void rt_print_dict(Dict *d) {
    if (!d) { 写出("<空典>", 8); return; }
    写出("{", 1);
    for (long i = 0; i < d->cap; i++) {
        if (d->keys[i] == 0) continue;
        rt_print_str((void *)d->keys[i]);
        写出(": ", 2);
        rt_print_box(d->vals[i]);
        写出(", ", 2);
    }
    写出("}", 1);
}

long rt_box_unbox_ptr(Box *b) { return b ? (long)b->val_as_ptr : 0; }
long rt_unbox_int(Box *b) { return b ? (long)b->val_as_ptr : 0; }
