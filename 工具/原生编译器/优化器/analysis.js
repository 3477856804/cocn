// ============================================================
// analysis.js —— 共享数据流分析（活跃变量、use/def、可达性）
// ============================================================
'use strict';

const I = require('./ir');

// 二元常量折叠
function foldBinop(op, l, r) {
  switch (op) {
    case 'add': return l + r;
    case 'sub': return l - r;
    case 'mul': return l * r;
    case 'div': return r === 0 ? null : Math.trunc(l / r);
    case 'mod': return r === 0 ? null : l % r;
    case 'lt':  return l < r;
    case 'le':  return l <= r;
    case 'eq':  return l === r;
    case 'ne':  return l !== r;
    case 'gt':  return l > r;
    case 'ge':  return l >= r;
    case 'and': return l && r;
    case 'or':  return l || r;
  }
  return null;
}
function foldUnop(op, v) {
  switch (op) {
    case 'neg': return -v;
    case 'not': return !v;
  }
  return null;
}
// 把 JS 值转成 IR 字面量（布尔 -> 0/1）
function toLiteral(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * 活跃变量分析（逆向数据流）。
 * 正确处理 SSA phi：phi 在块 B 的第 k 个实参来自第 k 个前驱 P，
 * 该实参视为 P 的 liveOut，而非 B 的 liveIn。
 */
function liveness(fn) {
  const n = fn.blocks.length;
  const liveIn = Array.from({ length: n }, () => new Set());
  const liveOut = Array.from({ length: n }, () => new Set());

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let b = n - 1; b >= 0; b--) {
      const blk = fn.blocks[b];

      // liveOut(b) = 对每个后继 s：
      //   (liveIn(s) - s 中所有 phi 的 dest) ∪ { phi.args[k] | phi 来自 b->s 这条边 }
      const newOut = new Set();
      for (const s of blk.succs) {
        const succ = fn.blocks[s];
        // 先把 liveIn[s] 去掉 phi 定义的变量
        for (const v of liveIn[s]) {
          let isPhiDef = false;
          for (const instr of succ.instrs) {
            if (instr.op === 'phi' && instr.dest === v) { isPhiDef = true; break; }
          }
          if (!isPhiDef) newOut.add(v);
        }
        // 再把 phi 中来自 b 这条边的实参加进来
        const edgeIdx = succ.preds.indexOf(b);
        if (edgeIdx === -1) continue;
        for (const instr of succ.instrs) {
          if (instr.op !== 'phi') continue;
          const a = instr.args[edgeIdx];
          if (a != null && typeof a === 'string') newOut.add(a);
        }
      }

      // liveIn(b) = use(b) ∪ (liveOut(b) - def(b))
      let newIn = new Set([...newOut]);
      for (const v of I.termUse(blk.term)) newIn.add(v);
      for (let i = blk.instrs.length - 1; i >= 0; i--) {
        const instr = blk.instrs[i];
        const d = I.instrDef(instr);
        if (d) newIn.delete(d);
        // phi 的 use 已经在 liveOut 处理过了，不再重复加
        if (instr.op !== 'phi') {
          for (const u of I.instrUse(instr)) newIn.add(u);
        }
      }
      if (b === 0) for (const p of fn.params) newIn.add(p);

      if (!setEq(newOut, liveOut[b])) { liveOut[b] = newOut; changed = true; }
      if (!setEq(newIn, liveIn[b])) { liveIn[b] = newIn; changed = true; }
    }
  }
  return { liveIn, liveOut };
}
function setEq(a, b) { return a.size === b.size && [...a].every(v => b.has(v)); }

/**
 * 可达块分析：从入口 BFS。
 */
function reachable(fn) {
  const vis = new Array(fn.blocks.length).fill(false);
  const queue = [0];
  vis[0] = true;
  while (queue.length) {
    const b = queue.shift();
    for (const s of fn.blocks[b].succs) if (!vis[s]) { vis[s] = true; queue.push(s); }
  }
  return vis;
}

module.exports = { foldBinop, foldUnop, toLiteral, liveness, reachable };
