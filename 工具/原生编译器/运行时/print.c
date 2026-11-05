/* ============================================================
 * coCN 运行时 —— 打印函数
 *   - 64KB 缓冲, 批量 write 系统调用
 *   - 查表法 itoa: 一次处理 2 位数字
 * ============================================================ */
#include "rt.h"

#define BUF_SIZE 65536

static char  pbuf[BUF_SIZE];
static int   poff = 0;

void rt_flush(void) {
    if (poff > 0) {
        rt_write(1, pbuf, (size_t)poff);
        poff = 0;
    }
}

void rt_print_char(char c) {
    if (poff >= BUF_SIZE) rt_flush();
    pbuf[poff++] = c;
}

void rt_print_newline(void) {
    rt_print_char('\n');
}

void rt_print_str(const char *s) {
    while (*s) {
        if (poff >= BUF_SIZE) rt_flush();
        pbuf[poff++] = *s++;
    }
}

/* ------------------------------------------------------------
 * 查表: 00..99 的两位 ASCII 表示
 * ------------------------------------------------------------ */
static const char digits[200] =
    "00010203040506070809"
    "10111213141516171819"
    "20212223242526272829"
    "30313233343536373839"
    "40414243444546474849"
    "50515253545556575859"
    "60616263646566676869"
    "70717273747576777879"
    "80818283848586878889"
    "90919293949596979899";

/* ------------------------------------------------------------
 * 无符号长整型 -> 字符串 (查表法, 一次 2 位)
 * ------------------------------------------------------------ */
static void append_ulong(unsigned long n) {
    char tmp[24];
    int len = 0;

    if (n == 0) {
        tmp[len++] = '0';
    } else {
        /* 一次处理 2 位数字 */
        while (n >= 100) {
            unsigned q = n / 100;
            unsigned r = n - q * 100;
            tmp[len++] = digits[r * 2 + 1];
            tmp[len++] = digits[r * 2];
            n = q;
        }
        /* 剩余 1-2 位 */
        if (n >= 10) {
            unsigned r = n;
            tmp[len++] = digits[r * 2 + 1];
            tmp[len++] = digits[r * 2];
        } else {
            tmp[len++] = '0' + (char)n;
        }
    }

    /* 逆序输出 */
    for (int i = len - 1; i >= 0; i--)
        rt_print_char(tmp[i]);
}

void rt_print_uint(unsigned int n) {
    append_ulong(n);
}

void rt_print_ulong(unsigned long n) {
    append_ulong(n);
}

void rt_print_int(int n) {
    if (n < 0) {
        rt_print_char('-');
        append_ulong((unsigned long)(-(unsigned int)n));
    } else {
        append_ulong((unsigned long)n);
    }
}

void rt_print_long(long n) {
    if (n < 0) {
        rt_print_char('-');
        append_ulong((unsigned long)(-(unsigned long)n));
    } else {
        append_ulong((unsigned long)n);
    }
}

void rt_print_bool(int b) {
    if (b) rt_print_str("真");
    else   rt_print_str("假");
}

/* ------------------------------------------------------------
 * void rt_print_double(double d)
 *   简单实现: 整数部分 + 6 位小数
 * ------------------------------------------------------------ */
void rt_print_double(double d) {
    if (d != d) { rt_print_str("NaN"); return; }
    if (d < 0) { rt_print_char('-'); d = -d; }

    long whole = (long)d;
    double frac = d - (double)whole;

    append_ulong((unsigned long)whole);
    rt_print_char('.');

    for (int i = 0; i < 6; i++) {
        frac *= 10.0;
        int digit = (int)frac;
        rt_print_char('0' + (char)digit);
        frac -= digit;
    }
}
