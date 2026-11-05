// 死代码消除测试
'use strict';
const I = require('../ir');
const { eliminateDeadCode } = require('../passes/dce');
const { test, assert, eq } = require('./harness');

test('DCE-1: 未使用的赋值被删除', () => {
  const fn = new I.Func('dead', []);
  const b0 = fn.newBlock();
  b0.instrs.push(
    I.const_('a', 1),
    I.const_('b', 2),   // b 从未被使用
    I.binop('add','c','a','a'),
  );
  b0.term = I.ret('c');
  I.buildCFG(fn);
  eliminateDeadCode(fn);
  const hasB = b0.instrs.some(i => i.dest === 'b');
  assert(!hasB, '未使用的 b=2 应被删除');
  const hasC = b0.instrs.some(i => i.dest === 'c');
  assert(hasC, 'c 被返回，应保留');
});

test('DCE-2: 有副作用的 call 不删除', () => {
  const fn = new I.Func('side', []);
  const b0 = fn.newBlock();
  b0.instrs.push(
    I.call('r', '__printf', ['"hello"']),  // call 有副作用
    I.const_('a', 1),
  );
  b0.term = I.ret('a');
  I.buildCFG(fn);
  eliminateDeadCode(fn);
  const hasCall = b0.instrs.some(i => i.op === 'call');
  assert(hasCall, '有副作用的 call 应保留');
});

test('DCE-3: 不可达块被清空', () => {
  const fn = new I.Func('unreach', []);
  const b0 = fn.newBlock(); b0.term = I.ret(I.const_('x',0) || 'x');
  fn.blocks[0].instrs = [I.const_('x',0)];
  fn.blocks[0].term = I.ret('x');
  const b1 = fn.newBlock(); // 不可达
  b1.instrs.push(I.const_('dead', 999));
  b1.term = I.ret('dead');
  I.buildCFG(fn);
  eliminateDeadCode(fn);
  eq(b1.instrs.length, 0, '不可达块的指令应清空');
});
