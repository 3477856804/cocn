// ============================================================
// regalloc.js —— 图着色寄存器分配（线性扫描简化版 + 着色）
//
// 流程：
//   1. 计算每个变量的活跃区间 [def, lastUse]
//   2. 构建干涉图：区间重叠的变量之间加边
//   3. Chaitin-Briggs 着色：
//      - 简化：度数 < k 的节点压栈（一定可着色）
//      - 溢出候选：度数 >= k 的节点，选全局溢出代价最低者压栈
//      - 选择：从栈弹出，选一个不冲突的颜色
//   4. 寄存器合并：mov a,b 若不干涉，a 和 b 用同一寄存器
//   5. 映射到 x86-64 物理寄存器
// ============================================================
'use strict';

const I = require('./ir');
const A = require('./analysis');

// x86-64 调用者保留/可分配寄存器（去掉 rsp/rbp 等特殊寄存器）
// 调用者保留：rax rcx rdx rsi rdi r8 r9 r10 r11（9个）
// 被调用者保留：rbx r12 r13 r14 r15（5个）
// 合计可分配 14 个整数寄存器；但保留几个给栈帧/参数传递，这里用 13 个。
const X86_INT_REGS = ['rax','rcx','rdx','rsi','rdi','r8','r9','r10','r11','rbx','r12','r13','r14'];
const X86_FP_REGS  = ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5','xmm6','xmm7',
                      'xmm8','xmm9','xmm10','xmm11','xmm12','xmm13','xmm14'];

/**
 * 计算每个变量的【全局编号顺序】：
 * 按 def 点在整个函数中的位置编号。
 */
function numberInstructions(fn) {
  let n = 0;
  for (const blk of fn.blocks) {
    blk._start = n;
    for (const instr of blk.instrs) { instr._num = n++; }
    blk._end = n;
  }
  fn._totalInstrs = n;
}

/**
 * 计算每个变量的活跃区间。
 * 简化：线性扫描，每个变量记 [firstDef, lastUse]。
 */
function computeLiveIntervals(fn) {
  numberInstructions(fn);
  const intervals = new Map(); // varName -> {v, start, end, blocks:Set}
  const ensure = (v) => {
    if (!intervals.has(v)) intervals.set(v, { v, start: fn._totalInstrs, end: -1, blocks: new Set() });
    return intervals.get(v);
  };
  // 参数从入口块 0 开始活跃
  for (const p of fn.params) {
    const iv = ensure(p); iv.start = 0; iv.blocks.add(0);
  }
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      const d = I.instrDef(instr);
      if (d) {
        const iv = ensure(d);
        iv.start = Math.min(iv.start, instr._num);
        iv.blocks.add(blk.id);
      }
      for (const u of I.instrUse(instr)) {
        const iv = ensure(u);
        iv.end = Math.max(iv.end, instr._num);
        iv.blocks.add(blk.id);
      }
    }
    for (const u of I.termUse(blk.term)) {
      const iv = ensure(u);
      iv.end = Math.max(iv.end, blk._end);
      iv.blocks.add(blk.id);
    }
  }
  return [...intervals.values()];
}

/**
 * 区间重叠检测：两个活跃区间是否干涉。
 * [s1,e1] 与 [s2,e2]：若 s1 <= e2 && s2 <= e1 即重叠。
 * 注意：严格的 SSA 里 def 点之后才算活跃，这里用半开区间 [start, end] 保守重叠。
 */
function interfere(a, b) {
  // 同一个变量不干涉自己
  if (a.v === b.v) return false;
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Chaitin-Briggs 图着色
 * @param {Array} intervals - 活跃区间列表
 * @param {number} k - 可用寄存器数
 * @param {Array} moveInstrs - mov 指令列表 [dst, src] 用于合并
 */
function colorGraph(intervals, k, moveInstrs) {
  const adj = new Map(); // var -> Set(var)
  for (const iv of intervals) adj.set(iv.v, new Set());
  // 建边
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      if (interfere(intervals[i], intervals[j])) {
        adj.get(intervals[i].v).add(intervals[j].v);
        adj.get(intervals[j].v).add(intervals[i].v);
      }
    }
  }
  // 合并候选：mov dst,src 若不干涉，记为约束（同色）
  const coalesce = new Map(); // v -> v'
  for (const [dst, src] of moveInstrs) {
    if (!adj.has(dst) || !adj.has(src)) continue;
    if (!adj.get(dst).has(src)) coalesce.set(dst, src);
  }

  const degree = (v) => adj.get(v).size;
  const removed = new Set();
  const stack = [];

  // 简化阶段
  let changed = true;
  while (changed) {
    changed = false;
    // 1) 先合并：度数低的 mov 对直接合并
    for (const [a, b] of coalesce) {
      if (removed.has(a) || removed.has(b)) continue;
      // a 并入 b：删除 a，所有 a 的邻居边转到 b（保守，不转，直接合并）
      removed.add(a);
      stack.push(a);
      changed = true;
    }
    // 2) 度数 < k 的节点压栈
    for (const iv of intervals) {
      const v = iv.v;
      if (removed.has(v)) continue;
      if (degree(v) < k) {
        removed.add(v);
        stack.push(v);
        changed = true;
      }
    }
    // 3) 还有没删的（度数>=k）：选一个“代价最低”的溢出候选
    if (!changed) {
      const remaining = intervals.filter(iv => !removed.has(iv.v));
      if (remaining.length > 0) {
        // 选度数最大（最简单）作为溢出候选
        remaining.sort((a, b) => degree(b.v) - degree(a.v));
        const spill = remaining[0].v;
        removed.add(spill);
        stack.push(spill);
        changed = true;
      }
    }
  }

  // 选择阶段：弹出栈，着色
  const color = new Map(); // v -> color (int)
  const spilled = new Set();
  while (stack.length) {
    const v = stack.pop();
    // 收集邻居已用颜色
    const used = new Set();
    for (const n of adj.get(v)) if (color.has(n)) used.add(color.get(n));
    // 找第一个空闲颜色
    let c = 0;
    while (used.has(c)) c++;
    if (c < k) {
      color.set(v, c);
    } else {
      spilled.add(v);
    }
    // 处理合并：如果 v 被合并进 coalesce 里的某个目标，让它继承颜色
    if (coalesce.has(v) && color.has(coalesce.get(v))) {
      color.set(v, color.get(coalesce.get(v)));
      spilled.delete(v);
    }
  }
  return { color, spilled, adj };
}

/**
 * 函数级寄存器分配入口。
 * 返回: { color:Map<var, regName>, spilled:Set<var>, intRegs:[...], fpRegs:[...] }
 */
function allocate(fn, numIntRegs = 13, numFpRegs = 15) {
  I.buildCFG(fn);
  const intervals = computeLiveIntervals(fn);

  // 收集 mov 指令用于合并
  const moves = [];
  for (const blk of fn.blocks) for (const instr of blk.instrs) {
    if (instr.op === 'mov') moves.push([instr.dest, instr.src]);
  }

  const { color, spilled } = colorGraph(intervals, numIntRegs, moves);

  // 把颜色号映射到具体寄存器名
  const regMap = new Map();
  for (const [v, c] of color) {
    regMap.set(v, X86_INT_REGS[c] || `stack_${v}`);
  }
  // 溢出变量分配到栈槽
  for (const v of spilled) regMap.set(v, `stack_${v}`);

  return {
    color: regMap,
    spilled: [...spilled],
    intRegs: X86_INT_REGS.slice(0, numIntRegs),
    fpRegs: X86_FP_REGS.slice(0, numFpRegs),
  };
}

module.exports = { allocate, computeLiveIntervals, colorGraph, interfere, X86_INT_REGS, X86_FP_REGS };
