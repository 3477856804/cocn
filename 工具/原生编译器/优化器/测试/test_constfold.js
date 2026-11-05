// 常量折叠测试：1+2*3 -> 7
'use strict';
const I = require('../ir');
const { constPropagate } = require('../passes/constProp');
const { test, assert, eq } = require('./harness');

test('常量折叠: 1+2*3 -> 7', () => {
  const fn = new I.Func('calc', []);
  const b0 = fn.newBlock();
  // t1 = 1; t2 = 2; t3 = 3; t4 = t2*t3; t5 = t1+t4
  b0.instrs.push(
    I.const_('a', 1),
    I.const_('b', 2),
    I.const_('c', 3),
    I.binop('mul', 'd', 'b', 'c'),
    I.binop('add', 'e', 'a', 'd'),
  );
  b0.term = I.ret('e');
  I.buildCFG(fn);
  constPropagate(fn);
  // e 应该被折叠成 const 7
  const eInstr = b0.instrs.find(i => i.dest === 'e' || (i.op === 'const' && false));
  // 折叠后 d 和 e 都应变成 const
  const allConst = b0.instrs.filter(i => i.op === 'const');
  const eConst = allConst.find(i => i.dest === 'e');
  assert(eConst, 'e 应被折叠为常量');
  eq(eConst.value, 7, '1+2*3 应 = 7');
});

test('常量折叠: 比较常量条件分支', () => {
  const fn = new I.Func('br', []);
  const b0 = fn.newBlock();
  b0.instrs.push(
    I.const_('x', 5),
    I.const_('ten', 10),
    I.binop('lt','c','x','ten'),
  );
  b0.term = I.branch('c', 1, 2);
  const b1 = fn.newBlock(); b1.term = I.ret('x');
  const b2 = fn.newBlock(); b2.term = I.ret('x');
  I.buildCFG(fn);
  constPropagate(fn);
  // c = 5 < 10 = true，branch 应变成 jump 到 L1
  eq(b0.term.kind, 'jump', '常量真分支应消解为 jump');
  eq(b0.term.target, 1, '应跳转到 L1');
});

test('常量折叠: 布尔 not', () => {
  const fn = new I.Func('not', []);
  const b0 = fn.newBlock();
  b0.instrs.push(I.const_('x', true), I.unop('not','y','x'));
  b0.term = I.ret('y');
  I.buildCFG(fn);
  constPropagate(fn);
  const y = b0.instrs.find(i => i.dest === 'y');
  eq(y.op, 'const', 'not true 应折叠');
  eq(y.value, 0, 'not true = false = 0');
});
