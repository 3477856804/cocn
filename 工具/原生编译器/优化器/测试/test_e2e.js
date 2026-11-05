// 端到端测试：完整优化流水线
'use strict';
const I = require('../ir');
const { optimizeProgram } = require('../index');
const { test, assert, eq } = require('./harness');

test('E2E-1: 完整流水线跑通循环求和', () => {
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

  const res = optimizeProgram({functions:[fn]}, {});
  assert(res.functions.length === 1, '应输出 1 个函数');
  assert(res.allocation.has('sum'), '应有寄存器分配结果');
  assert(res.scheduled.length === 1, '应输出调度结果');
});

test('E2E-2: 多函数 + 内联', () => {
  // add(a,b) = a+b; caller() = add(3,4)
  const callee = new I.Func('add', ['a','b']);
  const cb0 = callee.newBlock();
  cb0.instrs.push(I.binop('add','r','a','b'));
  cb0.term = I.ret('r');

  const caller = new I.Func('caller', []);
  const db0 = caller.newBlock();
  db0.instrs.push(I.const_('x',3), I.const_('y',4), I.call('z','add',['x','y']));
  db0.term = I.ret('z');

  const res = optimizeProgram({functions:[callee, caller]}, {});
  // caller 内联后应该不再有 call 指令（因为 add 很小）
  const callerFn = res.functions.find(f => f.name === 'caller');
  let hasCall = false;
  for (const b of callerFn.blocks) for (const i of b.instrs) if (i.op === 'call') hasCall = true;
  assert(!hasCall, '小函数 add 应被内联，caller 内不应再有 call');
});

test('E2E-3: 窥孔优化消除 mov x,x', () => {
  const fn = new I.Func('peep', ['a']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.mov('b','a'), I.mov('c','c')); // mov c,c 冗余
  b0.term = I.ret('c');
  I.buildCFG(fn);
  // 直接跑 peephole
  const peephole = require('../peephole');
  peephole.optimize(fn);
  const hasSelfMov = b0.instrs.some(i => i.op === 'mov' && i.dest === i.src);
  assert(!hasSelfMov, 'mov c,c 应被窥孔删除');
});
