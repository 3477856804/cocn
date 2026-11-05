// ============================================================
// traceSched.js —— Trace 调度（跨基本块调度，可选）
//
// 把最频繁执行的路径（trace）连成一条直线，跨块调度。
// 这里只做 trace 选择，实际指令重排由后端完成。
// ============================================================
'use strict';

const I = require('./ir');

/**
 * 从入口开始，按分支概率（启发式：then 分支更可能走）选 trace。
 * 返回基本块 id 列表，代表一条热路径。
 */
function selectTrace(fn) {
  const trace = [];
  let cur = 0;
  const visited = new Set();
  while (cur != null && !visited.has(cur)) {
    visited.add(cur);
    trace.push(cur);
    const t = fn.blocks[cur].term;
    if (t.kind === 'jump') cur = t.target;
    else if (t.kind === 'branch') cur = t.then; // 启发式：默认走 then
    else cur = null;
  }
  return trace;
}

/**
 * 对 trace 上的块做跨块指令移动提示：
 * 把 trace 上每个块的第一条指令标记 traceHot，供后端调度参考。
 */
function annotateTrace(fn) {
  const trace = selectTrace(fn);
  const traceSet = new Set(trace);
  for (const bid of trace) {
    const blk = fn.blocks[bid];
    for (let i = 0; i < Math.min(2, blk.instrs.length); i++) {
      blk.instrs[i].traceHot = true;
    }
  }
  fn._trace = trace;
  return trace;
}

module.exports = { selectTrace, annotateTrace };
