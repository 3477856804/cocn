// 循环不变量外提测试
'use strict';
const I = require('../ir');
const { toSSA } = require('../ssa');
const { optimizeLoops, findNaturalLoops } = require('../passes/loopOpt');
const { test, assert, eq } = require('./harness');

test('循环不变量外提: 循环内常量计算被提出', () => {
  // sum=0; i=0; while i<n: sum+= (a*b); i++
  // a*b 在循环外计算，应被提到前置块
  const fn = new I.Func('hoist', ['n','a','b']);
  const b0 = fn.newBlock();
  b0.instrs.push(I.const_('sum',0), I.const_('i',0));
  b0.term = I.jump(1);
  const b1 = fn.newBlock();
  b1.instrs.push(I.binop('lt','c','i','n'));
  b1.term = I.branch('c',2,3);
  const b2 = fn.newBlock();
  b2.instrs.push(
    I.binop('mul','ab','a','b'),   // 不变量：a,b 都不在循环内定义
    I.binop('add','sum','sum','ab'),
    I.binop('add','i','i','one'),
    I.const_('one',1),
  );
  b2.term = I.jump(1);
  const b3 = fn.newBlock(); b3.term = I.ret('sum');
  I.buildCFG(fn);
  toSSA(fn);
  optimizeLoops(fn);
  // 在 L0（前置块）应能找到 ab 的 mul
  const pre = fn.blocks[0];
  const hasHoisted = pre.instrs.some(i => i.op === 'mul' && i.dest.startsWith('ab'));
  assert(hasHoisted, '循环不变量 a*b 应被外提到前置块 L0');
});

test('自然循环识别: 找回到边', () => {
  const fn = new I.Func('loop', []);
  const b0 = fn.newBlock(); b0.term = I.jump(1);
  const b1 = fn.newBlock(); b1.term = I.branch('c',2,3);
  const b2 = fn.newBlock(); b2.term = I.jump(1);
  const b3 = fn.newBlock(); b3.term = I.ret('x');
  I.buildCFG(fn);
  const loops = findNaturalLoops(fn);
  assert(loops.length >= 1, '应识别出至少一个自然循环');
  eq(loops[0].header, 1, '循环头应为 L1');
});
