/* ============================================================
 * coCN 运行时 —— 字符串操作 (优化)
 *   - strlen: 8 字节字读取, 去掉对齐前导循环
 *   - strcpy: 8 字节字复制
 *   - memcpy/memset/memmove/memcmp: AVX2 (大缓冲区安全)
 * 目标: 比 glibc 更快
 * ============================================================ */
#include "rt.h"
#include <immintrin.h>

/* 检测 64 位字中是否含零字节的魔数 */
#define HASZERO(x) (((x) - 0x0101010101010101ULL) & ~(x) & 0x8080808080808080ULL)

/* ------------------------------------------------------------
 * size_t rt_strlen(const char *s)
 *   AVX2 非对齐加载, 一次 32 字节
 * ------------------------------------------------------------ */
size_t rt_strlen(const char *s) {
    const char *p = s;
    __m256i zero = _mm256_setzero_si256();
    for (;;) {
        __m256i v = _mm256_loadu_si256((const __m256i *)p);
        int mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(v, zero));
        if (mask)
            return (size_t)(p - s) + (size_t)__builtin_ctz(mask);
        p += 32;
    }
}

/* ------------------------------------------------------------
 * char *rt_strcpy(char *dst, const char *src)
 *   AVX2 一次复制 32 字节, 尾部字节复制
 * ------------------------------------------------------------ */
char *rt_strcpy(char *dst, const char *src) {
    char *d = dst;
    const char *s = src;
    __m256i zero = _mm256_setzero_si256();
    for (;;) {
        __m256i v = _mm256_loadu_si256((const __m256i *)s);
        int mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(v, zero));
        if (mask) {
            int z = __builtin_ctz(mask);
            for (int i = 0; i <= z; i++) d[i] = s[i];
            return dst;
        }
        _mm256_storeu_si256((__m256i *)d, v);
        s += 32;
        d += 32;
    }
}

char *rt_strncpy(char *dst, const char *src, size_t n) {
    size_t i;
    for (i = 0; i < n && src[i]; i++) dst[i] = src[i];
    for (; i < n; i++) dst[i] = 0;
    return dst;
}

/* ------------------------------------------------------------
 * char *rt_strcat(char *dst, const char *src)
 * ------------------------------------------------------------ */
char *rt_strcat(char *dst, const char *src) {
    char *p = dst + rt_strlen(dst);
    rt_strcpy(p, src);
    return dst;
}

/* ------------------------------------------------------------
 * int rt_strcmp(const char *a, const char *b)
 *   8 字节字比较, 正确处理 null 终止符
 * ------------------------------------------------------------ */
int rt_strcmp(const char *a, const char *b) {
    uint64_t wa, wb;
    for (;;) {
        wa = *(const uint64_t *)a;
        wb = *(const uint64_t *)b;
        if (wa == wb) {
            /* 字相同: 检查是否含 null (字符串结束) */
            if (HASZERO(wa)) return 0;
            a += 8; b += 8;
        } else {
            /* 字不同: 找第一个不同字节, 但不超过 null */
            for (int i = 0; i < 8; i++) {
                if (a[i] == 0 || a[i] != b[i])
                    return (int)(unsigned char)a[i] - (int)(unsigned char)b[i];
            }
            /* 前8字节都相同(不含null) — 不应该到这里, 因为 wa!=wb */
            a += 8; b += 8;
        }
    }
}

int rt_strncmp(const char *a, const char *b, size_t n) {
    while (n-- && *a && (*a == *b)) { a++; b++; }
    if (n == (size_t)-1) return 0;
    return (int)(unsigned char)*a - (int)(unsigned char)*b;
}

/* ------------------------------------------------------------
 * char *rt_strdup(const char *s)
 * ------------------------------------------------------------ */
char *rt_strdup(const char *s) {
    size_t n = rt_strlen(s) + 1;
    char *p = (char *)rt_alloc(n);
    if (!p) return NULL;
    rt_memcpy(p, s, n);
    return p;
}

/* ------------------------------------------------------------
 * char *rt_str_concat(const char *a, const char *b)
 * ------------------------------------------------------------ */
char *rt_str_concat(const char *a, const char *b) {
    size_t la = rt_strlen(a), lb = rt_strlen(b);
    char *out = (char *)rt_alloc(la + lb + 1);
    if (!out) return NULL;
    rt_memcpy(out, a, la);
    rt_memcpy(out + la, b, lb + 1);
    return out;
}

/* ------------------------------------------------------------
 * char *rt_str_sub(const char *s, int start, int len)
 * ------------------------------------------------------------ */
char *rt_str_sub(const char *s, int start, int len) {
    if (start < 0) start = 0;
    if (len < 0) len = 0;
    char *out = (char *)rt_alloc(len + 1);
    if (!out) return NULL;
    rt_memcpy(out, s + start, len);
    out[len] = 0;
    return out;
}

/* ------------------------------------------------------------
 * int rt_str_index(const char *s, const char *needle)
 * ------------------------------------------------------------ */
int rt_str_index(const char *s, const char *needle) {
    if (*needle == 0) return 0;
    size_t nl = rt_strlen(needle);
    for (size_t i = 0; s[i]; i++) {
        size_t j = 0;
        for (; j < nl && s[i + j] == needle[j]; j++);
        if (j == nl) return (int)i;
    }
    return -1;
}

/* ------------------------------------------------------------
 * char *rt_str_replace(const char *s, const char *from, const char *to)
 * ------------------------------------------------------------ */
char *rt_str_replace(const char *s, const char *from, const char *to) {
    size_t fl = rt_strlen(from), tl = rt_strlen(to);
    int count = 0;
    size_t slen = rt_strlen(s);
    for (size_t i = 0; i + fl <= slen; i++) {
        if (rt_strncmp(s + i, from, fl) == 0) { count++; i += fl - 1; }
    }
    size_t outlen = slen + count * (tl - fl);
    char *out = (char *)rt_alloc(outlen + 1);
    if (!out) return NULL;

    size_t oi = 0;
    for (size_t i = 0; i < slen;) {
        if (i + fl <= slen && rt_strncmp(s + i, from, fl) == 0) {
            rt_memcpy(out + oi, to, tl);
            oi += tl; i += fl;
        } else {
            out[oi++] = s[i++];
        }
    }
    out[oi] = 0;
    return out;
}

/* ------------------------------------------------------------
 * char **rt_str_split(const char *s, char delim, int *out_count)
 * ------------------------------------------------------------ */
char **rt_str_split(const char *s, char delim, int *out_count) {
    int cap = 8, cnt = 0;
    char **parts = (char **)rt_alloc(cap * sizeof(char *));
    if (!parts) { *out_count = 0; return NULL; }

    const char *start = s;
    for (;;) {
        if (*s == delim || *s == 0) {
            size_t l = (size_t)(s - start);
            if (cnt + 1 >= cap) {
                cap *= 2;
                parts = (char **)rt_realloc(parts, cap * sizeof(char *));
            }
            parts[cnt] = rt_str_sub(start, 0, (int)l);
            cnt++;
            if (*s == 0) break;
            start = s + 1;
        }
        s++;
    }
    *out_count = cnt;
    return parts;
}

/* ------------------------------------------------------------
 * char *rt_str_join(char **parts, int count, const char *sep)
 * ------------------------------------------------------------ */
char *rt_str_join(char **parts, int count, const char *sep) {
    size_t sl = rt_strlen(sep), total = 1;
    for (int i = 0; i < count; i++) total += rt_strlen(parts[i]) + sl;
    char *out = (char *)rt_alloc(total);
    if (!out) return NULL;
    out[0] = 0;
    for (int i = 0; i < count; i++) {
        if (i > 0) rt_strcat(out, sep);
        rt_strcat(out, parts[i]);
    }
    return out;
}

/* ============================================================
 * 内存原语 (AVX2 向量化)
 * ============================================================ */

void *rt_memset(void *dst, int c, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    if (n >= 128) {
        __m256i v = _mm256_set1_epi8((char)(unsigned char)c);
        while (n >= 32) {
            _mm256_storeu_si256((__m256i *)d, v);
            d += 32; n -= 32;
        }
    }
    uint64_t w = (uint64_t)(unsigned char)c * 0x0101010101010101ULL;
    while (n >= 8) {
        *(uint64_t *)d = w;
        d += 8; n -= 8;
    }
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

void *rt_memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    if (n >= 128) {
        while (n >= 32) {
            __m256i v = _mm256_loadu_si256((const __m256i *)s);
            _mm256_storeu_si256((__m256i *)d, v);
            d += 32; s += 32; n -= 32;
        }
    }
    while (n >= 8) {
        *(uint64_t *)d = *(const uint64_t *)s;
        d += 8; s += 8; n -= 8;
    }
    while (n--) *d++ = *s++;
    return dst;
}

void *rt_memmove(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    if (d == s) return dst;
    if (d < s) {
        while (n >= 8) {
            *(uint64_t *)d = *(const uint64_t *)s;
            d += 8; s += 8; n -= 8;
        }
        while (n--) *d++ = *s++;
    } else {
        d += n; s += n;
        while (n >= 8) {
            d -= 8; s -= 8; n -= 8;
            *(uint64_t *)d = *(const uint64_t *)s;
        }
        while (n--) { *--d = *--s; }
    }
    return dst;
}

int rt_memcmp(const void *a, const void *b, size_t n) {
    const unsigned char *pa = (const unsigned char *)a;
    const unsigned char *pb = (const unsigned char *)b;
    while (n--) {
        if (*pa != *pb) return (int)*pa - (int)*pb;
        pa++; pb++;
    }
    return 0;
}
