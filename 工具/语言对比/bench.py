# trio 基准 · Python 3 版
# 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
# 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
# 注意：长度按【字符】计（len(str) 对 str 即字符数），与 coCN 语义一致。
import sys
sys.setrecursionlimit(100000)


def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def main() -> None:
    N = 10000
    sieve = [True] * (N + 1)
    primes = 0
    for i in range(2, N + 1):
        if sieve[i]:
            primes += 1
            j = i * i
            while j <= N:
                sieve[j] = False
                j += i
    print("素数:", primes)
    print("fib:", fib(20))

    s = ""
    for k in range(1, 3001):
        s += "项目" + str(k) + ";"
    print("拼接:", len(s))


if __name__ == "__main__":
    main()
