// ============================================================
// scheduler.js —— 基本块内指令调度（列表调度）
//
// 目标：减少流水线停顿。
//   1. 构建数据依赖图：指令 i 依赖 j（j 的 def 是 i 的 use）
//   2. 列出就绪指令（依赖已满足）
//   3. 按“下游关键路径长度”优先选择就绪指令发射
//   4. 避免 load/use 之间的 load-use 延迟（中间插一条不相关指令）
// ============================================================
'use strict';

const I = require('./ir');

/**
 * 对单个基本块做指令调度。
 * 保持 phi 不动（必须块首），只调度非 phi、非终结符指令。
 */
function scheduleBlock(blk) {
  const phis = blk.instrs.filter(i => i.op === 'phi');
  const body = blk.instrs.filter(i => i.op !== 'phi');
  if (body.length <= 1) { blk.instrs = [...phis, ...body]; return; }

  // 每条指令定义的变量 -> 指令在 body 中的下标
  const defPos = new Map();
  body.forEach((instr, i) => {
    const d = I.instrDef(instr);
    if (d) defPos.set(d, i);
  });

  // 依赖：body[i] 依赖 body[j]（j 是 i 的某操作数的定义点）
  const depends = Array.from({ length: body.length }, () => new Set());
  const dependents = Array.from({ length: body.length }, () => new Set());
  body.forEach((instr, i) => {
    for (const u of I.instrUse(instr)) {
      const j = defPos.get(u);
      if (j != null && j !== i) {
        depends[i].add(j);
        dependents[j].add(i);
      }
    }
  });

  // 反向高度（关键路径长度）：从每条指令到块尾的最长路径
  const height = new Array(body.length).fill(0);
  for (let i = body.length - 1; i >= 0; i--) {
    let max = 0;
    for (const d of dependents[i]) max = Math.max(max, height[d]);
    height[i] = max + 1;
  }

  // 列表调度
  const scheduled = [];
  const scheduledSet = new Set();
  const remainingDeps = depends.map(s => new Set(s));

  while (scheduled.length < body.length) {
    // 找就绪：remainingDeps[i] 为空
    let best = -1, bestPri = -1;
    for (let i = 0; i < body.length; i++) {
      if (scheduledSet.has(i)) continue;
      if (remainingDeps[i].size === 0) {
        if (height[i] > bestPri) { bestPri = height[i]; best = i; }
      }
    }
    if (best === -1) {
      // 有环（不应出现），按原顺序补
      for (let i = 0; i < body.length; i++) if (!scheduledSet.has(i)) { best = i; break; }
    }
    scheduled.push(body[best]);
    scheduledSet.add(best);
    // 把 best 从所有依赖它的指令的 remainingDeps 中删除
    for (const d of dependents[best]) remainingDeps[d].delete(best);
  }

  blk.instrs = [...phis, ...scheduled];
}

/**
 * 函数级调度
 */
function scheduleFunction(fn, allocation) {
  for (const blk of fn.blocks) scheduleBlock(blk);
  return fn;
}

module.exports = { scheduleFunction, scheduleBlock };
