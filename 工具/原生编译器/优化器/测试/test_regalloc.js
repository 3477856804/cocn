// 寄存器分配测试
'use strict';
const I = require('../ir');
const { allocate, computeLiveIntervals, colorGraph, interfere } = require('../regalloc');
const { test, assert, eq } = require('./harness');

test('寄存器分配-1: 活跃区间正确重叠检测', () => {
  const a = { v: 'a', start: 0, end: 5 };
  const b = { v: 'b', start: 3, end: 8 };
  const c = { v: 'c', start: 6, end: 10 };
  assert(interfere(a, b), 'a[0,5] 与 b[3,8] 应干涉');
  assert(!interfere(a, c), 'a[0,5] 与 c[6,10] 不应干涉');
});

test('寄存器分配-2: 干涉图着色无冲突', () => {
  const intervals = [
    { v: 'a', start: 0, end: 5 },
    { v: 'b', start: 0, end: 10 },
    { v: 'c', start: 5, end: 10 },
  ];
  const { color, spilled } = colorGraph(intervals, 3, []);
  eq(spilled.size, 0, '3 色不应溢出');
  assert(color.get('a') !== color.get('b'), 'a 和 b 干涉，应不同色');
  assert(color.get('b') !== color.get('c'), 'b 和 c 干涉，应不同色');
});

test('寄存器分配-3: 函数级分配映射到 x86-64 寄存器', () => {
  const fn = new I.Func('add', ['x','y']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.binop('add','z','x','y'));
  b0.term = I.ret('z');
  I.buildCFG(fn);
  const result = allocate(fn, 13, 15);
  const xReg = result.color.get('x') || result.color.get('x#1');
  const yReg = result.color.get('y') || result.color.get('y#1');
  const zReg = result.color.get('z') || result.color.get('z#1');
  assert(xReg, 'x 应被分配');
  assert(yReg, 'y 应被分配');
  assert(zReg, 'z 应被分配');
});

test('寄存器分配-4: 寄存器数不足时正确溢出', () => {
  const intervals = [
    { v: 'a', start: 0, end: 10 },
    { v: 'b', start: 0, end: 10 },
    { v: 'c', start: 0, end: 10 },
    { v: 'd', start: 0, end: 10 },
  ];
  const { spilled } = colorGraph(intervals, 2, []);
  assert(spilled.size >= 2, '4 个互相干涉的变量用 2 寄存器至少溢出 2 个');
});
