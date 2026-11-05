// trio 基准 · Go 版（go build，无参数）
// 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
// 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
// 注意：长度按【字符】计（utf8.RuneCountInString），与 coCN 语义一致。
package main

import (
	"fmt"
	"strconv"
	"unicode/utf8"
)

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	const N = 10000
	sieve := make([]bool, N+1)
	for i := range sieve {
		sieve[i] = true
	}
	primes := 0
	for i := 2; i <= N; i++ {
		if sieve[i] {
			primes++
			for j := i * i; j <= N; j += i {
				sieve[j] = false
			}
		}
	}
	fmt.Println("素数:", primes)
	fmt.Println("fib:", fib(20))

	s := ""
	for k := 1; k <= 3000; k++ {
		s += "项目" + strconv.Itoa(k) + ";"
	}
	fmt.Println("拼接:", utf8.RuneCountInString(s))
}
