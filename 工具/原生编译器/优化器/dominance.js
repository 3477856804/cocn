// ============================================================
// dominance.js —— 支配树与支配边界计算
//
// 实现 Cooper-Harvey-Kennedy 的【简单迭代支配者算法】，
// 以及由支配树推导的【支配边界 (Dominance Frontier)】。
//
// 输入：已 buildCFG 的 Func
// 输出：
//   idom[blockId] = 直接支配者 id
//   domChildren[blockId] = [被支配的子块id]
//   domFrontier[blockId] = Set<blockId>
// ============================================================

'use strict';

/**
 * 迭代支配者算法（Cooper et al. "A Simple, Fast Dominance Algorithm"）
 *
 * 入口块 = 第 0 块。
 * 遍历顺序用逆后序（reverse postorder）收敛更快。
 */
function computeDominators(fn) {
  const n = fn.blocks.length;
  if (n === 0) return { idom: {}, domChildren: {}, domFrontier: {} };

  // --- 1. 计算逆后序 RPO ---
  const rpo = reversePostOrder(fn);
  // 记录每个块在 RPO 中的序号，用于快速比较“谁在前”
  const rpoNum = new Array(n).fill(-1);
  rpo.forEach((b, i) => { rpoNum[b] = i; });

  // --- 2. 初始化 ---
  const ENTRY = rpo[0]; // RPO 第一个是入口
  const idom = new Array(n).fill(-1);
  idom[ENTRY] = ENTRY; // 入口支配自己

  const intersect = (b1, b2) => {
    let f1 = b1, f2 = b2;
    // 不断把“更深”（RPO 序号更大）的手指沿支配树向上跳，直到相遇。
    // 入口 idom[ENTRY]=ENTRY，必然收敛。
    while (f1 !== f2) {
      while (rpoNum[f1] > rpoNum[f2]) f1 = idom[f1];
      while (rpoNum[f2] > rpoNum[f1]) f2 = idom[f2];
    }
    return f1;
  };

  // --- 3. 迭代直到不动点 ---
  let changed = true;
  while (changed) {
    changed = false;
    // 按 RPO 顺序遍历（跳过入口）
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i];
      // 选第一个已处理的前驱作为新的集合起点
      let newIdom = -1;
      for (const p of fn.blocks[b].preds) {
        if (idom[p] === -1) continue; // 还没处理过
        if (newIdom === -1) { newIdom = p; continue; }
        newIdom = intersect(p, newIdom);
      }
      if (newIdom !== -1 && idom[b] !== newIdom) {
        idom[b] = newIdom;
        changed = true;
      }
    }
  }

  // --- 4. 构造支配树子节点表 ---
  const domChildren = Array.from({ length: n }, () => []);
  for (let b = 0; b < n; b++) {
    if (b !== ENTRY && idom[b] !== -1) {
      domChildren[idom[b]].push(b);
    }
  }

  // --- 5. 计算支配边界 DF(b) ---
  const domFrontier = Array.from({ length: n }, () => new Set());
  for (let b = 0; b < n; b++) {
    const blk = fn.blocks[b];
    if (blk.preds.length < 2) continue; // 不是合并点，跳过
    for (const p of blk.preds) {
      let runner = p;
      // 沿支配树上跳，直到遇到 b 的直接支配者
      while (runner !== -1 && runner !== idom[b] && idom[runner] !== -1) {
        domFrontier[runner].add(b);
        runner = idom[runner];
      }
    }
  }

  return {
    idom,
    domChildren,
    domFrontier,
    entry: ENTRY,
  };
}

/**
 * 逆后序遍历（RPO）：DFS，先访问后继，再把块压栈。
 * 循环遍历（处理不可达块）。
 */
function reversePostOrder(fn) {
  const n = fn.blocks.length;
  const visited = new Array(n).fill(false);
  const order = [];

  const dfs = (start) => {
    const stack = [[start, 0]]; // [blockId, nextSuccIndex]
    visited[start] = true;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const b = top[0];
      const succs = fn.blocks[b].succs;
      if (top[1] < succs.length) {
        const s = succs[top[1]];
        top[1]++;
        if (!visited[s]) {
          visited[s] = true;
          stack.push([s, 0]);
        }
      } else {
        order.push(b);
        stack.pop();
      }
    }
  };

  dfs(0);
  // 处理不可达块
  for (let b = 0; b < n; b++) {
    if (!visited[b]) {
      // 不可达块也纳入（它们不会被 phi 影响，但要保证 idom 数组长度一致）
      visited[b] = true;
      dfs(b);
    }
  }
  // order 是后序；逆序 = 逆后序
  order.reverse();
  return order;
}

/**
 * 判断 a 是否支配 b（严格支配，a≠b）
 */
function strictlyDominates(idom, a, b) {
  let cur = b;
  let guard = 0;
  while (cur !== -1 && guard++ < 1000) {
    if (cur === a) return a !== b;
    if (idom[cur] === cur) break;
    cur = idom[cur];
  }
  return false;
}

module.exports = { computeDominators, reversePostOrder, strictlyDominates };
