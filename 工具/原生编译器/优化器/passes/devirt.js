// ============================================================
// passes/devirt.js —— Pass 8：去虚拟化
//
// 分析 call 指令的目标是否可静态确定。
// coCN 里函数是一等公民，但：
//   - 直接调用用户定义函数名（call foo(args)）本来就是直接调用
//   - 通过变量调用：f = foo; call f(...) —— 若 f 在函数内只被赋值一次且
//     目标已知，可替换为直接 call foo
// 内联会进一步消费直接调用。
// ============================================================
'use strict';

const I = require('../ir');

function devirtualize(fn, fnPool) {
  // 收集每个变量被赋值成了哪个函数名（mov v, funcName 形式）
  const funcPtr = new Map();
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op === 'mov' && typeof instr.src === 'string' && fnPool && fnPool.has(instr.src)) {
        funcPtr.set(instr.dest, instr.src);
      }
    }
  }
  // 替换间接调用：call dest, varName(args) -> call dest, realFunc(args)
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op !== 'call') continue;
      if (funcPtr.has(instr.name)) {
        instr.name = funcPtr.get(instr.name);
        instr.devirtualized = true;
      }
    }
  }
  return fn;
}

module.exports = { devirtualize };
