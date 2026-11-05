// ============================================================
// ssa.js —— 静态单赋值 (SSA) 形式转换
//
// 流程：
//   1. 收集每个原始变量在哪些块被【定义】
//   2. 标准 phi 插入算法：
//      - 对每个变量 v，把所有定义块放进 worklist
//      - 沿支配树向上，在支配边界 DF 中插入 phi（若尚未插入）
//      - 插入 phi 的块成为新的“定义点”，继续向上传播
//   3. 重命名：DFS 支配树，每个变量维护版本栈，
//      每次定义弹出栈顶生成新版本，use 处取栈顶。
//
// SSA 销毁（destruction）：
//   优化结束后，把 phi 的参数变成前驱块末尾的 mov。
// ============================================================

'use strict';

const I = require('./ir');
const { computeDominators } = require('./dominance');

/**
 * 把函数转为 SSA 形式（原地修改）。
 * 前置：已经 buildCFG。
 */
function toSSA(fn) {
  const dom = computeDominators(fn);
  const { idom, domFrontier } = dom;
  const n = fn.blocks.length;

  // ---- 1. 收集每个变量被哪些块定义 ----
  // defBlock[v] = Set of block ids that define v
  const defBlock = new Map();
  const recordDef = (v, bid) => {
    if (!defBlock.has(v)) defBlock.set(v, new Set());
    defBlock.get(v).add(bid);
  };
  // 函数参数视为在入口块定义
  for (const p of fn.params) recordDef(p, dom.entry);
  for (const b of fn.blocks) {
    for (const instr of b.instrs) {
      const d = I.instrDef(instr);
      if (d) recordDef(d, b.id);
    }
  }

  // ---- 2. phi 插入 ----
  // phiAlready[b] = Set of variables that already have a phi in block b
  const phiAlready = Array.from({ length: n }, () => new Set());
  // phiInserted[b] = Set of vars that we newly discovered need processing
  const phiInserted = Array.from({ length: n }, () => new Set());

  for (const [v, defBlocks] of defBlock) {
    // worklist = 该变量的所有定义块
    const worklist = [...defBlocks];
    while (worklist.length > 0) {
      const x = worklist.pop();
      // 遍历 x 的支配边界
      for (const y of domFrontier[x]) {
        if (!phiAlready[y].has(v)) {
          // 在块 y 插入 phi: v = phi(v, v, ...)
          const ph = I.phi(v, [], []);
          fn.blocks[y].instrs.unshift(ph); // phi 必须在块首
          phiAlready[y].add(v);
          // 块 y 现在定义了 v，如果它之前没定义过，加入 worklist
          if (!defBlock.get(v).has(y)) {
            defBlock.get(v).add(y);
            worklist.push(y);
          }
        }
      }
    }
  }

  // ---- 3. 重命名 ----
  // 每个变量的版本计数
  const varCount = new Map();
  // 每个变量的版本栈（栈顶 = 当前可见版本）
  const varStack = new Map();
  // 记录所有定义点 -> 新版本号，供后续 pass 使用
  const versions = new Map(); // 原名 -> 当前版本号

  const pushVersion = (v) => {
    const cnt = (varCount.get(v) || 0) + 1;
    varCount.set(v, cnt);
    const newName = `${v}#${cnt}`;
    if (!varStack.has(v)) varStack.set(v, []);
    varStack.get(v).push(newName);
    return newName;
  };
  const peekVersion = (v) => {
    const s = varStack.get(v);
    if (!s || s.length === 0) return v; // 未定义的（全局/参数外部）保持原名
    return s[s.length - 1];
  };
  const popVersion = (v) => {
    const s = varStack.get(v);
    if (s && s.length > 0) s.pop();
  };

  // 参数在入口块先压栈
  for (const p of fn.params) pushVersion(p);

  // 对 phi 里记录的 blocks/args，重命名后回填
  const renameBlock = (bid) => {
    const b = fn.blocks[bid];
    const defsThisBlock = []; // 本块新定义的变量名，退出时 pop

    // 先处理本块的 phi：它们定义的是新版本
    for (const instr of b.instrs) {
      if (instr.op !== 'phi') continue;
      const v = instr.dest; // 注意：phi 的 dest 现在还是原名
      const newName = pushVersion(v);
      instr.dest = newName;
      defsThisBlock.push(v);
    }

    // 处理普通指令：先重命名 use，再重命名 dest
    for (const instr of b.instrs) {
      if (instr.op === 'phi') continue;
      renameUses(instr, peekVersion);
      const d = I.instrDef(instr);
      if (d) {
        const newName = pushVersion(d);
        instr.dest = newName;
        defsThisBlock.push(d);
      }
    }

    // 重命名终结符的 use
    renameTermUses(b.term, peekVersion);

    // 把当前版本信息填进每个后继块的 phi
    for (const s of b.succs) {
      const succ = fn.blocks[s];
      for (const instr of succ.instrs) {
        if (instr.op !== 'phi') continue;
        // phi 的 args 对应各个前驱；我们要找到 b 在 phi.blocks 中的位置
        // 注意：此时 phi.blocks 还是空的，需要动态维护。
        // 约定：按【前驱顺序】填。我们在 succ.preds 中找 b 的索引。
        const predIdx = succ.preds.indexOf(bid);
        if (predIdx === -1) continue;
        // phi 对应的变量原名 = instr.dest 去掉 #n 后缀
        const orig = stripSSA(instr.dest);
        const cur = peekVersion(orig);
        // 保证 args/blocks 数组长度
        while (instr.blocks.length <= predIdx) { instr.blocks.push(-1); instr.args.push(null); }
        instr.blocks[predIdx] = bid;
        instr.args[predIdx] = cur;
      }
    }

    // 递归支配树子节点
    for (const child of dom.domChildren[bid]) {
      renameBlock(child);
    }

    // 退出：pop 本块定义的版本
    for (const v of defsThisBlock) popVersion(v);
  };

  renameBlock(dom.entry);

  fn._ssa = true;
  fn._dom = dom;
  return fn;
}

// 重命名一条普通指令的所有 use
function renameUses(instr, peek) {
  switch (instr.op) {
    case 'mov':
    case 'neg':
    case 'not':
      instr.src = peek(instr.src); break;
    case 'call':
      instr.args = instr.args.map(peek); break;
    case 'load':
      instr.base = peek(instr.base); break;
    case 'store':
      instr.base = peek(instr.base); instr.src = peek(instr.src); break;
    case 'phi':
      break;
    default:
      instr.left = peek(instr.left);
      instr.right = peek(instr.right);
  }
}
function renameTermUses(term, peek) {
  if (term.kind === 'branch') term.cond = peek(term.cond);
  else if (term.kind === 'return' && term.value != null) term.value = peek(term.value);
}

// 去掉 SSA 版本后缀： "x#3" -> "x"
function stripSSA(name) {
  if (typeof name !== 'string') return name;
  const idx = name.lastIndexOf('#');
  // 只在 # 后面全是数字时才剥离
  if (idx > 0 && /^\d+$/.test(name.slice(idx + 1))) return name.slice(0, idx);
  return name;
}

/**
 * SSA 销毁：把每个块首的 phi 指令展开为前驱块末尾的 mov。
 *
 * 对 phi: x = phi(a from P1, b from P2)：
 *   在 P1 末尾（终结符前）插入 mov x, a
 *   在 P2 末尾（终结符前）插入 mov x, b
 * 然后删除所有 phi。
 *
 * 注意：这是寄存器分配前的最后一步。
 */
function destroySSA(fn) {
  for (const b of fn.blocks) {
    const phis = b.instrs.filter(i => i.op === 'phi');
    if (phis.length === 0) continue;

    for (const ph of phis) {
      for (let k = 0; k < ph.blocks.length; k++) {
        const predId = ph.blocks[k];
        const arg = ph.args[k];
        if (predId == null || arg == null) continue;
        const pred = fn.blocks[predId];
        // 在 pred 的终结符前插入 mov
        pred.instrs.push(I.mov(ph.dest, arg));
      }
    }
    // 删除本块的 phi
    b.instrs = b.instrs.filter(i => i.op !== 'phi');
  }
  fn._ssa = false;
  return fn;
}

module.exports = { toSSA, destroySSA, stripSSA, computeDominators };
