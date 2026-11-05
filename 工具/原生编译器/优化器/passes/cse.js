// ============================================================
// passes/cse.js —— Pass 3：公共子表达式消除（局部 + 全局）
//
// 可用表达式（available expressions）：
//   表达式 key = op(left,right)（或 unop src）
//   块内：若同一表达式已算过一次（结果为 y），后续重复计算替换为 mov
//   失效：出现 call/store/load 或对 left/right 的重新定义时，
//         包含该变量的表达式全部失效（保守）
// ============================================================
'use strict';

const I = require('../ir');

function exprKey(instr) {
  if (['add','sub','mul','div','mod','lt','le','eq','ne','gt','ge','and','or'].includes(instr.op)) {
    // 交换律规范化：add/and/or/eq/ne 的操作数排序，让 a+b 与 b+a 命中
    if (['add','mul','and','or','eq','ne'].includes(instr.op)) {
      const [l, r] = instr.left <= instr.right ? [instr.left, instr.right] : [instr.right, instr.left];
      return `${instr.op}(${l},${r})`;
    }
    return `${instr.op}(${instr.left},${instr.right})`;
  }
  if (['neg','not'].includes(instr.op)) return `${instr.op}(${instr.src})`;
  return null;
}

function eliminateCSE(fn) {
  for (const blk of fn.blocks) {
    // avail: exprKey -> 结果变量名
    const avail = new Map();
    for (let i = 0; i < blk.instrs.length; i++) {
      const instr = blk.instrs[i];
      if (instr.op === 'phi') continue;
      const key = exprKey(instr);

      if (key && avail.has(key)) {
        // 已有相同表达式，结果在 avail.get(key)，替换为 mov
        const existing = avail.get(key);
        if (existing !== instr.dest) {
          blk.instrs[i] = I.mov(instr.dest, existing);
          // dest 现在是 existing 的别名，继续
        }
        continue;
      }

      // 这条指令定义了新变量，把 avail 中所有用到该变量的表达式删掉
      const d = I.instrDef(instr);
      if (d) {
        for (const [k, v] of avail) {
          if (k.includes(`(${d}`) || k.includes(`,${d})`) || k === `${instr.op}(${d})`) avail.delete(k);
        }
      }
      // 有副作用的指令：保守清空 avail（因为可能改内存）
      if (I.hasSideEffect(instr)) avail.clear();

      if (key) avail.set(key, instr.dest);
    }
  }
  return fn;
}

module.exports = { eliminateCSE, exprKey };
