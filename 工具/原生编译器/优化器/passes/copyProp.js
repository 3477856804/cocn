// ============================================================
// passes/copyProp.js —— Pass 4：复制传播
//
// x = y 之后，把后续对 x 的 use 替换为 y，形成链 x=y=z。
// 减少寄存器压力，让 mov 最终被 DCE 删除。
// 在 SSA 形式下安全：每个变量只被赋值一次，无需跨块分析。
// ============================================================
'use strict';

const I = require('../ir');

function propagateCopies(fn) {
  // SSA 下：每个 dest 唯一定义。建立 dest -> src 的别名图。
  const alias = new Map(); // x -> y (x = y)
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op === 'mov') {
        alias.set(instr.dest, instr.src);
      }
    }
  }
  // 传递闭包：x -> y -> z 归约成 x -> z
  const resolve = (v) => {
    const seen = new Set();
    while (alias.has(v) && !seen.has(v)) { seen.add(v); v = alias.get(v); }
    return v;
  };

  // 替换所有 use
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op === 'mov' && alias.get(instr.dest) === instr.src) {
        continue; // 这是复制本身，不动
      }
      switch (instr.op) {
        case 'mov': case 'neg': case 'not':
          instr.src = resolve(instr.src); break;
        case 'call':
          instr.args = instr.args.map(resolve); break;
        case 'load':
          instr.base = resolve(instr.base); break;
        case 'store':
          instr.base = resolve(instr.base); instr.src = resolve(instr.src); break;
        case 'phi':
          instr.args = instr.args.map(resolve); break;
        default:
          instr.left = resolve(instr.left);
          instr.right = resolve(instr.right);
      }
    }
    if (blk.term.kind === 'branch') blk.term.cond = resolve(blk.term.cond);
    else if (blk.term.kind === 'return' && blk.term.value != null) blk.term.value = resolve(blk.term.value);
  }
  return fn;
}

module.exports = { propagateCopies };
