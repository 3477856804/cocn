// 基准演示：模拟 coCN 性能基准（斐波那契/循环求和/素数计数）
// 运行：node benchmark_demo.js
'use strict';
const I = require('./ir');
const { optimizeProgram } = require('./index');

// 斐波那契：递归
function fibFn() {
  const fn = new I.Func('fib', ['n']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.binop('lt','c','n','two'), I.const_('two',2));
  b0.term = I.branch('c', 1, 2);
  const b1 = fn.newBlock(); b1.term = I.ret('n');
  const b2 = fn.newBlock();
  b2.instrs.push(
    I.binop('sub','n1','n','one'), I.const_('one',1),
    I.call('r1','fib',['n1']),
    I.binop('sub','n2','n','two'),
    I.call('r2','fib',['n2']),
    I.binop('add','r3','r1','r2'),
  );
  b2.term = I.ret('r3');
  return fn;
}

// 循环求和
function sumFn() {
  const fn = new I.Func('sum', ['n']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.const_('s',0), I.const_('i',0));
  b0.term = I.jump(1);
  const b1 = fn.newBlock();
  b1.instrs.push(I.binop('lt','c','i','n'));
  b1.term = I.branch('c',2,3);
  const b2 = fn.newBlock();
  b2.instrs.push(I.const_('one',1), I.binop('add','s','s','i'), I.binop('add','i','i','one'));
  b2.term = I.jump(1);
  const b3 = fn.newBlock(); b3.term = I.ret('s');
  return fn;
}

// 素数计数（简化版）
function primeFn() {
  const fn = new I.Func('primes', ['n']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.const_('count',0), I.const_('i',2));
  b0.term = I.jump(1);
  const b1 = fn.newBlock();
  b1.instrs.push(I.binop('lt','c','i','n'));
  b1.term = I.branch('c',2,4);
  const b2 = fn.newBlock(); // 内层：检查 i 是否素数（简化：i%2==0?）
  b2.instrs.push(I.const_('two',2), I.binop('mod','r','i','two'));
  b2.term = I.branch('r',3,3); // 简化：都走 3
  const b3 = fn.newBlock();
  b3.instrs = [I.const_('one',1), I.binop('add','count','count','one'), I.binop('add','i','i','one')];
  b3.term = I.jump(1);
  const b4 = fn.newBlock(); b4.term = I.ret('count');
  return fn;
}

console.log('=== 优化前（指令数统计）===');
const prog = { functions: [fibFn(), sumFn(), primeFn()] };
for (const f of prog.functions) {
  const n = f.blocks.reduce((s,b)=>s+b.instrs.length, 0);
  console.log(`  ${f.name}: ${n} 条 IR 指令, ${f.blocks.length} 个块`);
}

console.log('\n=== 优化后 ===');
const result = optimizeProgram(prog, {});
for (const f of result.functions) {
  const n = f.blocks.reduce((s,b)=>s+b.instrs.length, 0);
  const a = result.allocation.get(f.name);
  console.log(`  ${f.name}: ${n} 条 IR 指令, ${f.blocks.length} 块, 溢出 ${a.spilled.length} 个变量`);
}
console.log('\n基准演示完成。');
