// ============================================================
// passes/escape.js —— Pass 7：逃逸分析
//
// 分析堆分配对象（call __alloc / load 后地址运算）是否逃逸出函数。
// 不逃逸的对象：
//   - 不传到其他函数作为参数
//   - 不存到全局/堆中
//   - 不被返回
// 就替换为栈分配（直接在 IR 上记录 stackAllocated=true）。
// ============================================================
'use strict';

const I = require('../ir');

function escapeAnalysis(fn) {
  // 收集所有分配点：call 到名字是 "__alloc_list"/"__alloc_dict" 的 dest
  const allocSites = new Set();
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op === 'call' && /^__alloc/.test(instr.name)) allocSites.add(instr.dest);
    }
  }

  // 对每个分配变量，检查它是否逃逸：
  //   作为 call 的实参 -> 逃逸
  //   作为 return 值 -> 逃逸
  //   被 store 到内存（base/offset 含该变量）-> 逃逸（保守）
  const escapes = new Set();
  const worklist = [...allocSites];
  const visited = new Set();

  while (worklist.length) {
    const v = worklist.pop();
    if (visited.has(v)) continue;
    visited.add(v);

    for (const blk of fn.blocks) {
      for (const instr of blk.instrs) {
        // 作为 call 实参
        if (instr.op === 'call' && instr.args.includes(v)) { escapes.add(v); continue; }
        // store 进去
        if (instr.op === 'store' && (instr.base === v || instr.src === v)) { escapes.add(v); continue; }
        // mov 传播：v = x 且 x 在 allocSites，或 x = v 且 x 也可能逃逸
        if (instr.op === 'mov') {
          if (instr.src === v && !escapes.has(instr.dest)) worklist.push(instr.dest);
          if (instr.dest === v && !escapes.has(instr.src)) worklist.push(instr.src);
        }
      }
      // 作为 return 值
      const t = blk.term;
      if (t.kind === 'return' && t.value === v) escapes.add(v);
    }
  }

  // 标记不逃逸的分配为栈分配
  for (const blk of fn.blocks) {
    for (const instr of blk.instrs) {
      if (instr.op === 'call' && /^__alloc/.test(instr.name) && !escapes.has(instr.dest)) {
        instr.stackAlloc = true; // 后端看到此标记就栈上分配
      }
    }
  }
  fn._escaped = escapes;
  return fn;
}

module.exports = { escapeAnalysis };
