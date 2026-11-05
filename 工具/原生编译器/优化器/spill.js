// ============================================================
// spill.js —— 溢出代码插入
//
// 寄存器分配后，对每个溢出变量：
//   - 在它的定义点插入 store 到栈槽
//   - 在它的每个 use 点插入 load 从栈槽
// ============================================================
'use strict';

const I = require('./ir');

/**
 * 为 spilled 变量插入 load/store。
 * @param {Func} fn
 * @param {Set<string>} spilled
 * @param {Map<string,string>} color - 已分配的寄存器映射
 * @returns {Map<string,number>} 栈槽偏移表
 */
function insertSpillCode(fn, spilled, color) {
  const stackSlots = new Map(); // var -> 栈偏移
  let nextOffset = 0;
  for (const v of spilled) {
    stackSlots.set(v, nextOffset);
    nextOffset += 8; // 每个槽 8 字节
  }

  for (const blk of fn.blocks) {
    const newInstrs = [];
    for (const instr of blk.instrs) {
      const d = I.instrDef(instr);
      // use 点：先把 spilled 变量 load 出来到临时寄存器
      const uses = I.instrUse(instr);
      for (const u of uses) {
        if (spilled.has(u)) {
          const tmp = `spillload_${u}`;
          newInstrs.push({ op: 'load', dest: tmp, base: 'rbp', offset: stackSlots.get(u) });
          // 替换 instr 里的 u
          replaceUse(instr, u, tmp);
        }
      }
      newInstrs.push(instr);
      // def 点：存回栈槽
      if (d && spilled.has(d)) {
        newInstrs.push({ op: 'store', base: 'rbp', offset: stackSlots.get(d), src: d });
      }
    }
    blk.instrs = newInstrs;
    // 终结符的 use 也处理
    if (blk.term.kind === 'branch' && spilled.has(blk.term.cond)) {
      const tmp = `spillload_${blk.term.cond}`;
      blk.instrs.push({ op: 'load', dest: tmp, base: 'rbp', offset: stackSlots.get(blk.term.cond) });
      blk.term.cond = tmp;
    }
  }
  fn.stackFrameSize = nextOffset;
  return stackSlots;
}

function replaceUse(instr, oldName, newName) {
  switch (instr.op) {
    case 'mov': case 'neg': case 'not':
      if (instr.src === oldName) instr.src = newName; break;
    case 'call':
      instr.args = instr.args.map(a => a === oldName ? newName : a); break;
    case 'load':
      if (instr.base === oldName) instr.base = newName; break;
    case 'store':
      if (instr.base === oldName) instr.base = newName;
      if (instr.src === oldName) instr.src = newName; break;
    case 'phi':
      instr.args = instr.args.map(a => a === oldName ? newName : a); break;
    default:
      if (instr.left === oldName) instr.left = newName;
      if (instr.right === oldName) instr.right = newName;
  }
}

module.exports = { insertSpillCode };
