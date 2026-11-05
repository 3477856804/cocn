// trio 基准 · Rust 版（rustc -O）
// 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
// 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
// 注意：长度按【字符】计（chars().count()），与 coCN 语义一致。

fn fib(n: u64) -> u64 {
    if n < 2 { return n; }
    fib(n - 1) + fib(n - 2)
}

fn main() {
    const N: usize = 10000;
    let mut sieve = vec![true; N + 1];
    let mut primes: u64 = 0;
    for i in 2..=N {
        if sieve[i] {
            primes += 1;
            let mut j = i * i;
            while j <= N {
                sieve[j] = false;
                j += i;
            }
        }
    }
    println!("素数: {}", primes);
    println!("fib: {}", fib(20));

    let mut s = String::new();
    for k in 1..=3000 {
        s.push_str("项目");
        s.push_str(&k.to_string());
        s.push(';');
    }
    println!("拼接: {}", s.chars().count());
}
