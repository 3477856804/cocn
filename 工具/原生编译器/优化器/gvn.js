// ============================================================
// gvn.js —— 全局值编号（Global Value Numbering）
//
// 跨块公共子表达式消除：
//   为每个表达式分配一个全局编号，
//   同一表达式（交换律等价）在整个函数内只计算一次。
//   基于支配树：在 y 支配 x 的前提下，x 处的重复计算可替换为 y 的结果。
// ============================================================
'use strict';

const I = require('./ir');
const { computeDominators } = require('./dominance');
const { exprKey } = require('./passes/cse');

function globalValueNumbering(fn) {
  const dom = computeDominators(fn);
  // exprKey -> 第一个计算它的 (blockId, instr, resultName)
  const firstComputed = new Map();
  // 块的支配后代链上可见的表达式
  // 简化：DFS 支配树，传递 firstComputed 表
  const dfs = (bid, table) => {
    const blk = fn.blocks[bid];
    const localTable = new Map(table); // 继承父块的可见表
    for (let i = 0; i < blk.instrs.length; i++) {
      const instr = blk.instrs[i];
      if (instr.op === 'phi') continue;
      const key = exprKey(instr);
      if (!key) continue;
      if (localTable.has(key)) {
        // 已有相同表达式，替换为 mov
        const existing = localTable.get(key);
        if (existing !== instr.dest) {
          blk.instrs[i] = I.mov(instr.dest, existing);
        }
      } else {
        localTable.set(key, instr.dest);
      }
    }
    for (const child of dom.domChildren[bid]) dfs(child, localTable);
  };
  dfs(dom.entry, new Map());
  return fn;
}

module.exports = { globalValueNumbering };
