/* ============================================================
 * coCN 轻量级原生运行时 —— 公共头文件
 * 纯 freestanding 环境：不依赖 libc，直接系统调用
 * 目标：比 glibc 更快的内存分配与字符串操作
 * ============================================================ */
#ifndef RT_H
#define RT_H

/* ---------- 基础类型（freestanding，不引入 stddef.h/stdint.h） ---------- */
typedef unsigned long       size_t;
typedef long                ssize_t;
typedef unsigned long       uintptr_t;
typedef unsigned char       uint8_t;
typedef unsigned short      uint16_t;
typedef unsigned int        uint32_t;
typedef unsigned long long  uint64_t;
/* int64_t 不自定义: SSE2 头文件会从系统 stdint 引入, 避免冲突 */

#ifndef NULL
#define NULL ((void *)0)
#endif

#define likely(x)   __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

/* ---------- 系统调用封装（来自 syscall.asm） ---------- */
/* ssize_t rt_write(int fd, const void *buf, size_t count); */
long rt_write(int fd, const void *buf, size_t count);
/* void rt_exit(int code) __attribute__((noreturn)); */
void rt_exit(int code);
/* void *rt_mmap(void *addr, size_t len, int prot, int flags, int fd, long offset); */
void *rt_mmap(void *addr, size_t len, int prot, int flags, int fd, long offset);
/* void *rt_mremap(void *old_addr, size_t old_size, size_t new_size, int flags); */
void *rt_mremap(void *old_addr, size_t old_size, size_t new_size, int flags);
/* int rt_munmap(void *addr, size_t len); */
int rt_munmap(void *addr, size_t len);
/* int rt_brk(void *addr); */
long rt_brk(void *addr);
/* int rt_open(const char *path, int flags, int mode); */
int rt_open(const char *path, int flags, int mode);
/* ssize_t rt_read(int fd, void *buf, size_t count); */
long rt_read(int fd, void *buf, size_t count);
/* int rt_close(int fd); */
int rt_close(int fd);
/* long rt_gettimeofday(void);  返回微秒时间戳 */
long rt_gettimeofday(void);
/* long rt_monotonic_us(void);  返回单调时钟微秒（用于 benchmark） */
long rt_monotonic_us(void);

/* mmap 常量（x86-64 Linux） */
#define RT_PROT_READ   0x1
#define RT_PROT_WRITE  0x2
#define RT_MAP_PRIVATE 0x02
#define RT_MAP_ANON    0x20
#define RT_FD_ANON     (-1)

/* ---------- 内存分配器（alloc.c） ---------- */
void  *rt_alloc(size_t size);
void   rt_free(void *ptr);
void  *rt_realloc(void *ptr, size_t size);
void  *rt_calloc(size_t nmemb, size_t size);

/* ---------- 字符串操作（string.c） ---------- */
size_t rt_strlen(const char *s);
char  *rt_strcpy(char *dst, const char *src);
char  *rt_strncpy(char *dst, const char *src, size_t n);
char  *rt_strcat(char *dst, const char *src);
int    rt_strcmp(const char *a, const char *b);
int    rt_strncmp(const char *a, const char *b, size_t n);
char  *rt_strdup(const char *s);
char  *rt_str_concat(const char *a, const char *b);
char  *rt_str_sub(const char *s, int start, int len);
int    rt_str_index(const char *s, const char *needle);
char  *rt_str_replace(const char *s, const char *from, const char *to);
char **rt_str_split(const char *s, char delim, int *out_count);
char  *rt_str_join(char **parts, int count, const char *sep);

/* 编译器可能隐式调用的内存原语 */
void  *rt_memset(void *dst, int c, size_t n);
void  *rt_memcpy(void *dst, const void *src, size_t n);
void  *rt_memmove(void *dst, const void *src, size_t n);
int    rt_memcmp(const void *a, const void *b, size_t n);

/* ---------- 列表 list.c ---------- */
typedef struct {
    int    length;
    int    capacity;
    void **items;
} rt_list_t;

rt_list_t *rt_list_create(void);
void       rt_list_append(rt_list_t *l, void *val);
void      *rt_list_get(rt_list_t *l, int idx);
void       rt_list_set(rt_list_t *l, int idx, void *val);
int        rt_list_length(rt_list_t *l);
void      *rt_list_pop(rt_list_t *l);
void       rt_list_insert(rt_list_t *l, int idx, void *val);
void       rt_list_remove(rt_list_t *l, int idx);
rt_list_t *rt_list_concat(rt_list_t *a, rt_list_t *b);
rt_list_t *rt_list_slice(rt_list_t *l, int start, int end);
void       rt_list_sort(rt_list_t *l, int (*cmp)(void *a, void *b));

/* 内部: 扩容 (list.c 中定义) */
void _rt_list_reserve(rt_list_t *l, int newcap);

/* 热点路径内联: append/get/set/length/pop 可被编译器内联 */
static inline void rt_list_append_inline(rt_list_t *l, void *val) {
    if (unlikely(l->length >= l->capacity))
        _rt_list_reserve(l, l->capacity * 2);
    l->items[l->length++] = val;
}
static inline void *rt_list_get_inline(rt_list_t *l, int idx) {
    if (idx < 0 || idx >= l->length) return NULL;
    return l->items[idx];
}
static inline int rt_list_length_inline(rt_list_t *l) {
    return l->length;
}
static inline void *rt_list_pop_inline(rt_list_t *l) {
    if (l->length <= 0) return NULL;
    return l->items[--l->length];
}

/* ---------- 字典 dict.c ---------- */
typedef struct {
    char  *key;
    void  *val;
    int    used;      /* 1=占用, 0=空, -1=已删除(墓碑) */
} rt_entry_t;

typedef struct {
    int    size;
    int    capacity;
    rt_entry_t *buckets;
} rt_dict_t;

rt_dict_t *rt_dict_create(void);
void      *rt_dict_get(rt_dict_t *d, const char *key);
int        rt_dict_set(rt_dict_t *d, const char *key, void *val);
void      *rt_dict_remove(rt_dict_t *d, const char *key);
int        rt_dict_contains(rt_dict_t *d, const char *key);
int        rt_dict_size(rt_dict_t *d);
rt_list_t *rt_dict_keys(rt_dict_t *d);
rt_list_t *rt_dict_values(rt_dict_t *d);

/* ---------- 打印 print.c ---------- */
void rt_print_int(int n);
void rt_print_uint(unsigned int n);
void rt_print_long(long n);
void rt_print_ulong(unsigned long n);
void rt_print_double(double d);
void rt_print_str(const char *s);
void rt_print_bool(int b);
void rt_print_newline(void);
void rt_print_char(char c);
void rt_flush(void);

/* ---------- 数学 math.c ---------- */
int     rt_abs(int n);
int     rt_min(int a, int b);
int     rt_max(int a, int b);
double  rt_pow(double base, double exp);
double  rt_sqrt(double x);
double  rt_sin(double x);
double  rt_cos(double x);
double  rt_tan(double x);
double  rt_log(double x);
double  rt_log2(double x);
double  rt_log10(double x);
double  rt_exp(double x);
double  rt_floor(double x);
double  rt_ceil(double x);
double  rt_round(double x);
int     rt_rand(void);
void    rt_srand(unsigned int seed);

#endif /* RT_H */
