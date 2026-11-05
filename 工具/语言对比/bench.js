// trio 基准 · JavaScript 版（node 基准.js）
// 负载：埃氏筛 10000（素数计数）+ 递归 fib(20) + 3000 次中文字符串拼接
// 输出与 coCN 紧凑基准逐字节一致：素数: 1229 / fib: 6765 / 拼接: 19893
// 注意：长度按【字符】计（[...s].length，按码点计，与 coCN 语义一致）。
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

const N = 10000;
const sieve = new Array(N + 1).fill(true);
let primes = 0;
for (let i = 2; i <= N; i++) {
  if (sieve[i]) {
    primes++;
    for (let j = i * i; j <= N; j += i) sieve[j] = false;
  }
}
console.log("素数:", primes);
console.log("fib:", fib(20));

let s = "";
for (let k = 1; k <= 3000; k++) s += "项目" + k + ";";
console.log("拼接:", [...s].length);
