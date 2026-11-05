// ============================================================
// peephole.js —— 窥孔优化（最终一遍）
//
//  - 冗余 mov 消除：mov x, x 删除
//  - 常量 xor 优化：mov x, 0 -> xor x, x（后端提示，这里在 IR 层记录）
//  - 地址模式合并：base+offset*scale 提示
//  - 连续 mov 链折叠
// ============================================================
'use strict';

const I = require('./ir');

function optimize(fn) {
  for (const blk of fn.blocks) {
    const out = [];
    for (let i = 0; i < blk.instrs.length; i++) {
      const instr = blk.instrs[i];
      // mov x, x 冗余删除
      if (instr.op === 'mov' && instr.dest === instr.src) continue;
      // const x, 0 -> 记录 zeroFlag（后端用 xor）
      if (instr.op === 'const' && (instr.value === 0 || instr.value === false)) {
        instr.useXor = true;
      }
      // mov x, y 且前一条是 mov y, z（链折叠）—— 简化为 mov x, z
      if (instr.op === 'mov' && out.length > 0) {
        const prev = out[out.length - 1];
        if (prev.op === 'mov' && prev.dest === instr.src) {
          instr.src = prev.src;
        } else if (prev.op === 'const' && prev.dest === instr.src) {
          blk.instrs[i] = I.const_(instr.dest, prev.value);
          out.push(blk.instrs[i]);
          continue;
        }
      }
      out.push(instr);
    }
    blk.instrs = out;
  }
  return fn;
}

module.exports = { optimize };
