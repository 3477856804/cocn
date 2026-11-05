// ============================================================
// passes/constProp.js —— Pass 1：常量传播与常量折叠
//
// - 局部块内常量传播：跟踪 var -> 字面值
// - 二元/一元常量折叠：1+2*3 在编译期算出
// - 条件为常量的分支：删除不可达分支
// - 跨块：通过支配关系做简单的全局常量传播（常量在块入口已知）
// ============================================================
'use strict';

const I = require('../ir');
const A = require('../analysis');

/**
 * 在单个基本块内做常量折叠 + 条件常量分支消解。
 * known: 入口处已知常量 map（var->literal），会被原地更新。
 * 返回该块出口仍成立的 known 快照（供后继使用）。
 */
function simplifyBlock(fn, bid, known) {
  const blk = fn.blocks[bid];
  const out = new Map(known); // 出口快照

  for (let i = 0; i < blk.instrs.length; i++) {
    const instr = blk.instrs[i];
    const d = I.instrDef(instr);

    switch (instr.op) {
      case 'const':
        out.set(instr.dest, instr.value);
        break;

      case 'mov': {
        // x = y ：若 y 已知常量，直接折叠成 const x
        if (out.has(instr.src)) {
          blk.instrs[i] = I.const_(instr.dest, out.get(instr.src));
          out.set(instr.dest, out.get(instr.src));
        } else {
          out.delete(instr.dest);
        }
        break;
      }

      case 'call':
      case 'load':
      case 'store':
        // 调用/加载结果未知
        if (d) out.delete(d);
        break;

      case 'phi':
        // phi 的每个参数常量值不一致就放弃；一致则传播
        {
          const vals = instr.args.map(a => (typeof a === 'string' && out.has(a)) ? out.get(a) : a);
          const first = vals[0];
          if (vals.every(v => v === first && typeof v !== 'string')) {
            blk.instrs[i] = I.const_(instr.dest, first);
            out.set(instr.dest, first);
          } else {
            out.delete(instr.dest);
          }
        }
        break;

      default:
        if (['neg', 'not'].includes(instr.op)) {
          if (out.has(instr.src)) {
            const r = A.foldUnop(instr.op, out.get(instr.src));
            if (r !== null) {
              blk.instrs[i] = I.const_(instr.dest, A.toLiteral(r));
              out.set(instr.dest, A.toLiteral(r));
            } else out.delete(instr.dest);
          } else out.delete(instr.dest);
        } else {
          // 二元
          if (out.has(instr.left) && out.has(instr.right)) {
            const r = A.foldBinop(instr.op, out.get(instr.left), out.get(instr.right));
            if (r !== null) {
              blk.instrs[i] = I.const_(instr.dest, A.toLiteral(r));
              out.set(instr.dest, A.toLiteral(r));
            } else out.delete(instr.dest);
          } else out.delete(instr.dest);
        }
    }
  }

  // 终结符：条件常量 -> 改为无条件跳转
  const t = blk.term;
  if (t.kind === 'branch' && out.has(t.cond)) {
    const cv = !!A.toLiteral(out.get(t.cond));
    const target = cv ? t.then : t.else;
    blk.term = I.jump(target);
  }
  return out;
}

/**
 * 函数级：迭代直到不动点（前向数据流）。
 * knownEntry[blockId] = Map of known constants at block entry。
 */
function constPropagate(fn) {
  const n = fn.blocks.length;
  const entryKnown = Array.from({ length: n }, () => new Map());
  entryKnown[0] = new Map(); // 入口未知

  let changed = true, guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (let b = 0; b < n; b++) {
      if (fn.blocks[b].instrs.length === 0 && fn.blocks[b].term.kind === 'unreachable') continue;
      const before = entryKnown[b];
      const after = simplifyBlock(fn, b, before);
      // 把 after 传播到后继
      for (const s of fn.blocks[b].succs) {
        const sk = entryKnown[s];
        // 合并：两个前驱都知道同一个常量才传播
        for (const [k, v] of after) {
          if (!sk.has(k)) { sk.set(k, v); changed = true; }
          else if (sk.get(k) !== v) sk.set(k, undefined); // 冲突 -> 未知
        }
      }
    }
  }
  return fn;
}

module.exports = { constPropagate, simplifyBlock };
