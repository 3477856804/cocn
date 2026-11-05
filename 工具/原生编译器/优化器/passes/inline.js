// ============================================================
// passes/inline.js —— Pass 6：函数内联
//
// - 调用图分析（哪些函数调用谁）
// - 小函数（IR 指令数 < 阈值）自动内联
// - 递归函数不内联
// - 内联后变量名加前缀避免冲突，返回值连接到调用点
// ============================================================
'use strict';

const I = require('../ir');

const DEFAULT_THRESHOLD = 20;

function countInstrs(fn) {
  return fn.blocks.reduce((s, b) => s + b.instrs.length, 0);
}

/**
 * 在 caller 函数体内，把对 callee 的调用内联。
 * call: {op:'call', dest, name:calleeName, args:[...]}
 * 在 caller 的 bid 块中，位置 idx。
 */
function inlineCall(caller, callee, callSiteBlockId, instrIdx, prefix) {
  const callInstr = caller.blocks[callSiteBlockId].instrs[instrIdx];
  const args = callInstr.args;

  // 1. 复制 callee 的所有块，块 id 整体偏移
  const oldN = caller.blocks.length;
  const idMap = new Map(); // callee block id -> caller block id
  const newBlocks = [];
  for (const cb of callee.blocks) {
    const nb = I.cloneBlock(cb);
    nb.id = oldN + newBlocks.length;
    // 重映射块内所有名字：加前缀
    for (const instr of nb.instrs) prefixInstr(instr, prefix);
    prefixTerm(nb.term, prefix);
    idMap.set(cb.id, nb.id);
    newBlocks.push(nb);
  }
  // 重映射 callee 块内的跳转目标
  for (const nb of newBlocks) {
    if (nb.term.kind === 'jump') nb.term.target = idMap.get(nb.term.target);
    else if (nb.term.kind === 'branch') {
      nb.term.then = idMap.get(nb.term.then);
      nb.term.else = idMap.get(nb.term.else);
    }
  }

  // 2. 把 callee 入口块的参数绑定为实参：
  //    在入口块开头插入 mov 形参名, 实参名
  const entry = newBlocks[0];
  for (let i = 0; i < callee.params.length; i++) {
    entry.instrs.unshift(I.mov(prefix + callee.params[i], args[i]));
  }

  // 3. 找 callee 的 return 块，把 return value 接到 callInstr.dest
  const returnBlocks = [];
  for (const nb of newBlocks) {
    if (nb.term.kind === 'return') {
      if (nb.term.value != null) {
        nb.instrs.push(I.mov(callInstr.dest, nb.term.value));
      }
      nb.term = I.jump(0); // 占位，下面改为 caller 后续块
      returnBlocks.push(nb);
    }
  }

  // 4. 切分 caller 当前块：call 之前部分留在原块，
  //    call 之后部分放到新的 continuation 块
  const callerBlk = caller.blocks[callSiteBlockId];
  const before = callerBlk.instrs.slice(0, instrIdx);
  const after = callerBlk.instrs.slice(instrIdx + 1);
  callerBlk.instrs = before;
  // continuation 块：包含 call 之后的指令，保留原 term
  const cont = new I.Block(caller.blocks.length);
  cont.instrs = after;
  cont.term = callerBlk.term;
  caller.blocks.push(cont);

  // caller 原块跳到 callee 入口
  callerBlk.term = I.jump(idMap.get(0));
  // callee 所有 return 块跳到 continuation
  for (const rb of returnBlocks) rb.term = I.jump(cont.id);

  // 把 callee 新块全部加入 caller
  caller.blocks.push(...newBlocks);
}

function prefixInstr(instr, prefix) {
  switch (instr.op) {
    case 'mov': case 'neg': case 'not':
      instr.dest = prefix + instr.dest; instr.src = prefix + instr.src; break;
    case 'call':
      instr.dest = prefix + instr.dest;
      instr.args = instr.args.map(a => prefix + a); break;
    case 'load':
      instr.dest = prefix + instr.dest; instr.base = prefix + instr.base; break;
    case 'store':
      instr.base = prefix + instr.base; instr.src = prefix + instr.src; break;
    case 'phi':
      instr.dest = prefix + instr.dest;
      instr.args = instr.args.map(a => prefix + a); break;
    default:
      instr.dest = prefix + instr.dest;
      instr.left = prefix + instr.left;
      instr.right = prefix + instr.right;
  }
}
function prefixTerm(term, prefix) {
  if (term.kind === 'branch') term.cond = prefix + term.cond;
  else if (term.kind === 'return' && term.value != null) term.value = prefix + term.value;
}

/**
 * 函数级内联：遍历 caller，找可内联的 call。
 * fnPool: Map<funcName, Func>
 */
function inlineFunctions(fnPool, threshold = DEFAULT_THRESHOLD) {
  for (const [name, caller] of fnPool) {
    I.buildCFG(caller);
    for (let b = 0; b < caller.blocks.length; b++) {
      const blk = caller.blocks[b];
      for (let i = 0; i < blk.instrs.length; i++) {
        const instr = blk.instrs[i];
        if (instr.op !== 'call') continue;
        const callee = fnPool.get(instr.name);
        if (!callee) continue;
        if (callee.name === name) continue; // 递归跳过
        if (countInstrs(callee) > threshold) continue;
        // 内联！
        const prefix = `__inl_${callee.name}_${b}_${i}__`;
        inlineCall(caller, callee, b, i, prefix);
        I.buildCFG(caller);
        // 内联后指令位置变了，重新扫
        i = -1; b = -1; break;
      }
    }
  }
}

module.exports = { inlineFunctions, countInstrs };
