/* ============================================================
 * coCN 运行时 —— 数学函数
 *   精度稍低但比 libm 快 (泰勒展开 / 查表 / 多项式逼近)
 * ============================================================ */
#include "rt.h"

#define PI       3.14159265358979323846
#define PI2      6.28318530717958647692
#define EPS      1e-9

int rt_abs(int n) { return n < 0 ? -n : n; }
int rt_min(int a, int b) { return a < b ? a : b; }
int rt_max(int a, int b) { return a > b ? a : b; }

double rt_floor(double x) {
    long l = (long)x;
    if (x < 0 && (double)l != x) l--;
    return (double)l;
}

double rt_ceil(double x) {
    long l = (long)x;
    if (x > 0 && (double)l != x) l++;
    return (double)l;
}

double rt_round(double x) {
    if (x >= 0) return rt_floor(x + 0.5);
    else        return rt_ceil(x - 0.5);
}

/* x^2 */
static inline double sq(double x) { return x * x; }

/* ------------------------------------------------------------
 * double rt_sqrt(double x)  -- 牛顿迭代
 * ------------------------------------------------------------ */
double rt_sqrt(double x) {
    if (x <= 0) return 0;
    double g = x;
    for (int i = 0; i < 32; i++)
        g = 0.5 * (g + x / g);
    return g;
}

/* ------------------------------------------------------------
 * double rt_exp(double x)  -- 泰勒级数
 * ------------------------------------------------------------ */
double rt_exp(double x) {
    if (x < -700) return 0;
    double sum = 1, term = 1;
    for (int i = 1; i < 60; i++) {
        term *= x / i;
        sum += term;
        if (term < EPS && term > -EPS) break;
    }
    return sum;
}

/* ------------------------------------------------------------
 * double rt_log(double x)  -- 自然对数
 *   log(x) = 2*atanh((x-1)/(x+1)) 级数
 * ------------------------------------------------------------ */
double rt_log(double x) {
    if (x <= 0) return -1e30;
    if (x == 1) return 0;
    double y = (x - 1.0) / (x + 1.0);
    double y2 = y * y;
    double sum = y;
    double term = y;
    for (int i = 1; i < 40; i++) {
        term *= y2;
        sum += term / (2.0 * i + 1.0);
    }
    return 2.0 * sum;
}

double rt_log2(double x)  { return rt_log(x) / rt_log(2.0); }
double rt_log10(double x) { return rt_log(x) / rt_log(10.0); }

/* ------------------------------------------------------------
 * double rt_pow(double base, double exp)
 * ------------------------------------------------------------ */
double rt_pow(double base, double exp) {
    if (exp == 0) return 1;
    if (base == 0) return 0;
    return rt_exp(exp * rt_log(base));
}

/* ------------------------------------------------------------
 * double rt_sin(double x)  -- 泰勒展开 (先归约到 [-pi, pi])
 * ------------------------------------------------------------ */
double rt_sin(double x) {
    /* 范围归约 */
    while (x >  PI) x -= PI2;
    while (x < -PI) x += PI2;
    double x2 = x * x;
    double s = x;
    double term = x;
    for (int i = 1; i < 15; i++) {
        term *= -x2 / (2.0 * i * (2.0 * i + 1.0));
        s += term;
    }
    return s;
}

double rt_cos(double x) {
    return rt_sin(x + PI / 2.0);
}

double rt_tan(double x) {
    double c = rt_cos(x);
    if (c < EPS && c > -EPS) return 1e30;
    return rt_sin(x) / c;
}

/* ------------------------------------------------------------
 * 随机数 (线性同余, 简单快速)
 * ------------------------------------------------------------ */
static unsigned int rng_state = 1;

void rt_srand(unsigned int seed) {
    rng_state = seed;
}

int rt_rand(void) {
    rng_state = rng_state * 1103515245u + 12345u;
    return (int)(rng_state & 0x7fffffff);
}
