// trio 基准 · Java 版（单文件直接运行：java 基准.java，JDK 11+）
// 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
// 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
// 注意：长度按【字符】计（String.length() 对 UTF-16 恰好一致——全 BMP 内汉字与 ASCII 均 1 单元）。
class Bench {
    static long fib(int n) {
        if (n < 2) return n;
        return fib(n - 1) + fib(n - 2);
    }

    public static void main(String[] args) {
        final int N = 10000;
        boolean[] sieve = new boolean[N + 1];
        java.util.Arrays.fill(sieve, true);
        long primes = 0;
        for (int i = 2; i <= N; i++) {
            if (sieve[i]) {
                primes++;
                for (long j = (long) i * i; j <= N; j += i) sieve[(int) j] = false;
            }
        }
        System.out.println("素数: " + primes);
        System.out.println("fib: " + fib(20));

        StringBuilder sb = new StringBuilder();
        for (int k = 1; k <= 3000; k++) sb.append("项目").append(k).append(';');
        System.out.println("拼接: " + sb.length());
    }
}
