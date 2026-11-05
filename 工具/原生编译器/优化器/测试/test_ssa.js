// SSA 转换测试
'use strict';
const I = require('../ir');
const { toSSA, destroySSA } = require('../ssa');
const { test, assert, eq } = require('./harness');

test('SSA-1: 菱形 if-else 在合并点插入 phi', () => {
  const fn = new I.Func('f', ['c']);
  const b0 = fn.newBlock(); b0.instrs.push(I.const_('x',1)); b0.term = I.branch('c',1,2);
  const b1 = fn.newBlock(); b1.instrs.push(I.const_('x',2)); b1.term = I.jump(3);
  const b2 = fn.newBlock(); b2.term = I.jump(3);
  const b3 = fn.newBlock(); b3.term = I.ret('x');
  I.buildCFG(fn);
  toSSA(fn);
  // L3 应有 phi
  const phi = fn.blocks[3].instrs.find(i => i.op === 'phi');
  assert(phi, '合并点 L3 应有 phi 节点');
  eq(phi.blocks.length, 2, 'phi 应有两个前驱');
  eq(phi.args.length, 2, 'phi 应有两个参数');
});

test('SSA-2: 变量重命名为 x#1, x#2...', () => {
  const fn = new I.Func('f', ['c']);
  const b0 = fn.newBlock(); b0.instrs.push(I.const_('x',1)); b0.term = I.branch('c',1,2);
  const b1 = fn.newBlock(); b1.instrs.push(I.const_('x',2)); b1.term = I.jump(3);
  const b2 = fn.newBlock(); b2.term = I.jump(3);
  const b3 = fn.newBlock(); b3.term = I.ret('x');
  I.buildCFG(fn);
  toSSA(fn);
  // L0 的 x 应该变成 x#1
  eq(fn.blocks[0].instrs[0].dest, 'x#1', '入口块 x 应为 x#1');
  eq(fn.blocks[1].instrs[0].dest, 'x#2', 'then 块 x 应为 x#2');
});

test('SSA-3: 循环头插入 phi（循环变量）', () => {
  const fn = new I.Func('loop', []);
  const b0 = fn.newBlock(); b0.instrs.push(I.const_('i',0)); b0.term = I.jump(1);
  const b1 = fn.newBlock(); b1.instrs.push(I.binop('lt','c','i','n')); b1.term = I.branch('c',2,3);
  const b2 = fn.newBlock(); b2.instrs.push(I.binop('add','i','i','one'), I.const_('one',1)); b2.term = I.jump(1);
  const b3 = fn.newBlock(); b3.term = I.ret('i');
  I.buildCFG(fn);
  toSSA(fn);
  const header = fn.blocks[1];
  const ivPhi = header.instrs.find(i => i.op === 'phi' && i.dest.startsWith('i#'));
  assert(ivPhi, '循环头应有 i 的 phi');
  eq(ivPhi.args.length, 2, '循环 phi 应有两个参数（初值 + 增量）');
});

test('SSA-4: SSA 销毁后 phi 变成 mov', () => {
  const fn = new I.Func('f', ['c']);
  const b0 = fn.newBlock(); b0.instrs.push(I.const_('x',1)); b0.term = I.branch('c',1,2);
  const b1 = fn.newBlock(); b1.instrs.push(I.const_('x',2)); b1.term = I.jump(3);
  const b2 = fn.newBlock(); b2.term = I.jump(3);
  const b3 = fn.newBlock(); b3.term = I.ret('x');
  I.buildCFG(fn);
  toSSA(fn);
  destroySSA(fn);
  // 不应再有 phi
  for (const b of fn.blocks) for (const i of b.instrs)
    assert(i.op !== 'phi', '销毁后不应再有 phi');
  // 前驱块末尾应有 mov
  const hasMov = fn.blocks[1].instrs.some(i => i.op === 'mov') ||
                 fn.blocks[2].instrs.some(i => i.op === 'mov');
  assert(hasMov, '前驱块应有 mov');
});
