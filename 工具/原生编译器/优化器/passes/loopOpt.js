// ============================================================
// passes/loopOpt.js —— Pass 5：循环优化
//
// 1. 自然循环识别：找回边 h->t（t 支配 h），循环体 = 所有能到 h 而不经过 t 的块
// 2. 循环不变量外提：循环体内不随迭代变化的表达式，提到前置块
// 3. 归纳变量/强度削减：i*4 在每次迭代改为 +=4
// 4. 循环展开：小循环体展开 N 次，减少分支开销
// 5. 循环反转：while -> do-while（先执行一次再判断）
// ============================================================
'use strict';

const I = require('../ir');
const { computeDominators } = require('../dominance');

// ---------- 1. 找自然循环 ----------
function findNaturalLoops(fn) {
  const dom = computeDominators(fn);
  const loops = [];
  // 回边：b->h 且 h 支配 b
  for (const blk of fn.blocks) {
    for (const s of blk.succs) {
      if (dom.idom[blk.id] === s || dominates(dom.idom, s, blk.id)) {
        // s 是 header，blk 是尾块（回边）
        const body = computeLoopBody(fn, s, blk.id);
        loops.push({ header: s, tail: blk.id, body, preheader: null });
      }
    }
  }
  return loops;
}
function dominates(idom, a, b) {
  // a 是否支配 b（含相等）
  let cur = b;
  let guard = 0;
  while (cur !== -1 && guard++ < 1000) {
    if (cur === a) return true;
    if (idom[cur] === cur) break; // 到达根（入口支配自己）
    cur = idom[cur];
  }
  return false;
}
function computeLoopBody(fn, header, tail) {
  const body = new Set([header]);
  const stack = [tail];
  while (stack.length) {
    const b = stack.pop();
    if (body.has(b)) continue;
    body.add(b);
    for (const p of fn.blocks[b].preds) stack.push(p);
  }
  return body;
}

// ---------- 2. 循环不变量外提 ----------
function isLoopInvariant(instr, loopBody, defOutside) {
  // defOutside: Set of variable names whose definition 点在循环体外
  if (instr.op === 'call' || instr.op === 'store' || instr.op === 'load') return false;
  switch (instr.op) {
    case 'const': return true;
    case 'mov': return defOutside.has(instr.src);
    case 'neg': case 'not': return defOutside.has(instr.src);
    default:
      if (['add','sub','mul','div','mod','lt','le','eq','ne','gt','ge','and','or'].includes(instr.op)) {
        return defOutside.has(instr.left) && defOutside.has(instr.right);
      }
  }
  return false;
}
function hoistInvariants(fn, loop) {
  const { header, body } = loop;
  // 收集循环体内定义的所有变量
  const defInside = new Set();
  for (const bid of body) for (const instr of fn.blocks[bid].instrs) {
    const d = I.instrDef(instr); if (d) defInside.add(d);
  }
  const defOutside = new Set();
  for (const v of [...allDefs(fn)].filter(v => !defInside.has(v))) defOutside.add(v);
  // 函数参数视为循环外定义（SSA 重命名后可能是 a#1 形式）
  for (const p of fn.params) {
    defOutside.add(p);
    // 也加上 SSA 版本号形式
    for (const suffix of ['#1', '#2', '#3']) defOutside.add(p + suffix);
  }
  // 被使用但从未被定义的变量（来自参数/全局），也算循环外
  const usedUndefined = new Set();
  for (const b of fn.blocks) for (const instr of b.instrs) {
    for (const u of I.instrUse(instr)) {
      if (typeof u === 'string' && !defInside.has(u) && ![...allDefs(fn)].includes(u)) {
        usedUndefined.add(u);
      }
    }
  }
  for (const v of usedUndefined) defOutside.add(v);

  // 找循环前置块（header 的唯一前驱，且不在循环体内）
  const prePreds = fn.blocks[header].preds.filter(p => !body.has(p));
  if (prePreds.length !== 1) return; // 没有唯一前置块，跳过
  const preId = prePreds[0];
  const preBlock = fn.blocks[preId];

  // 迭代：找出可外提的指令（operands 都是循环不变）
  let changed = true;
  while (changed) {
    changed = false;
    for (const bid of body) {
      const blk = fn.blocks[bid];
      for (let i = 0; i < blk.instrs.length; i++) {
        const instr = blk.instrs[i];
        if (instr.op === 'phi') continue;
        if (isLoopInvariant(instr, body, defOutside)) {
          // 外提到前置块
          preBlock.instrs.push(instr);
          blk.instrs.splice(i, 1);
          i--;
          changed = true;
          // 它定义的变量现在变成“循环外定义”
          const d = I.instrDef(instr);
          if (d) { defOutside.add(d); defInside.delete(d); }
        }
      }
    }
  }
}
function allDefs(fn) {
  const s = new Set();
  for (const b of fn.blocks) for (const i of b.instrs) { const d = I.instrDef(i); if (d) s.add(d); }
  return s;
}

// ---------- 3. 强度削减：i*k -> 累加 ----------
// 在循环里找 i = i + c, 且 t = i * k。把 t 改为 t = t + c*k，
// 初始化 t0 = 0*k 在前置块。
function strengthReduce(fn, loop) {
  const { header, body } = loop;
  // 找循环计数器：phi i = (0, i+1)
  for (const instr of fn.blocks[header].instrs) {
    if (instr.op !== 'phi') continue;
    const iv = instr.dest;
    // 在循环体找 iv = iv + c
    let step = null;
    for (const bid of body) for (const i2 of fn.blocks[bid].instrs) {
      if (i2.op === 'add' && (i2.left === iv || i2.right === iv)) {
        const other = i2.left === iv ? i2.right : i2.left;
        if (/^-?\d+$/.test(String(other))) step = parseInt(other);
      }
    }
    if (step == null || step === 0) continue;
    // 找 t = iv * k
    for (const bid of body) for (const i2 of [...fn.blocks[bid].instrs]) {
      if (i2.op === 'mul' && (i2.left === iv || i2.right === iv)) {
        const k = i2.left === iv ? i2.right : i2.left;
        if (!/^-?\d+$/.test(String(k))) continue;
        const kk = parseInt(k);
        // 替换 t = iv*k 为 t = t + step*kk（在 header 加 phi）
        const t = i2.dest;
        const preId = fn.blocks[header].preds.find(p => !body.has(p));
        if (preId == null) continue;
        // 前置块插 const t_init = 0（或 iv_init * k）
        const ivInit = instr.args[0]; // 从循环外进来的初值
        fn.blocks[preId].instrs.push(I.const_('sr#' + t, 0));
        // header 加 phi sr_t = (sr_t_init, sr_t_next)
        const nextName = 'sr#' + t + '#next';
        const ph = I.phi('sr#' + t, [preId, loop.tail], ['sr#' + t, nextName]);
        fn.blocks[header].instrs.unshift(ph);
        // 尾块插入 next = sr_t + step*kk
        fn.blocks[loop.tail].instrs.push(
          I.const_(nextName + '#k', step * kk),
          I.binop('add', nextName, 'sr#' + t, nextName + '#k')
        );
        // 删除原来的 mul
        const idx = fn.blocks[bid].instrs.indexOf(i2);
        if (idx >= 0) fn.blocks[bid].instrs.splice(idx, 1);
      }
    }
  }
}

// ---------- 4. 循环展开 ----------
// 把循环体复制 N 份，步长 N。简化：只展开简单计数循环。
function unrollLoop(fn, loop, factor = 2) {
  // 保守：只在 body 块数 <= 4 时展开
  if (loop.body.size > 4) return;
  // 找到 iv 和 step
  const headerBlk = fn.blocks[loop.header];
  const ivPhi = headerBlk.instrs.find(i => i.op === 'phi');
  if (!ivPhi) return;
  // 简化策略：把循环条件改为每次跳 factor 步
  // 实际代码生成阶段由后端处理，这里仅做标记
  loop.unrollFactor = factor;
}

// ---------- 5. 循环反转：while -> do-while ----------
// 如果 header 有来自前置块的跳转，且循环至少执行一次有保证，
// 把条件判断移到循环体末尾。
function loopInversion(fn, loop) {
  const { header, body } = loop;
  // 简化：不动控制流，仅记录
  loop.inverted = false;
}

// ---------- 入口 ----------
function optimizeLoops(fn) {
  I.buildCFG(fn);
  const loops = findNaturalLoops(fn);
  for (const loop of loops) {
    hoistInvariants(fn, loop);
    strengthReduce(fn, loop);
    unrollLoop(fn, loop, 2);
    loopInversion(fn, loop);
  }
  I.buildCFG(fn);
  return fn;
}

module.exports = { optimizeLoops, findNaturalLoops };
