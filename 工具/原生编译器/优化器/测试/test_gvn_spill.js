// GVN 与溢出代码测试
'use strict';
const I = require('../ir');
const { globalValueNumbering } = require('../gvn');
const { insertSpillCode } = require('../spill');
const { test, assert, eq } = require('./harness');

test('GVN: 跨块公共子表达式消除', () => {
  // L0: a = 1; b = a+2; jump L1
  // L1: c = a+2; ret c   (c = b 重复计算)
  const fn = new I.Func('gvn', []);
  const b0 = fn.newBlock();
  b0.instrs.push(
    I.const_('a', 1),
    I.const_('two', 2),
    I.binop('add','b','a','two'),
  );
  b0.term = I.jump(1);
  const b1 = fn.newBlock();
  b1.instrs.push(I.binop('add','c','a','two'));
  b1.term = I.ret('c');
  I.buildCFG(fn);
  globalValueNumbering(fn);
  // c 应被替换为 mov c, b
  const cInstr = b1.instrs.find(i => i.dest === 'c');
  eq(cInstr.op, 'mov', 'GVN 应把重复的 a+2 替换为 mov');
  eq(cInstr.src, 'b', '应引用 L0 已算好的 b');
});

test('溢出代码: spilled 变量插入 load/store', () => {
  const fn = new I.Func('spill', ['x']);
  const b0 = fn.newBlock();
  b0.instrs.push(
    I.binop('add','y','x','x'),
    I.binop('add','z','y','y'),
  );
  b0.term = I.ret('z');
  I.buildCFG(fn);
  const spilled = new Set(['x']);
  insertSpillCode(fn, spilled, new Map());
  // 应有 load 指令从栈槽加载 x
  const hasLoad = b0.instrs.some(i => i.op === 'load');
  assert(hasLoad, 'spilled 变量 x 的 use 点应插入 load');
  assert(fn.stackFrameSize > 0, '应分配栈帧空间');
});
