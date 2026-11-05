// ============================================================
// index.js —— 优化器主流水线
//
// AST → 三地址码IR → 构建CFG → SSA转换 → 优化passes →
//      SSA销毁 → 寄存器分配 → 指令调度 → 窥孔 → 输出
//
// 用法：
//   const opt = require('./index');
//   const result = opt.optimizeProgram(program, options);
//   // program = { functions: [Func-like POJO] }
// ============================================================
'use strict';

const I = require('./ir');
const { toSSA, destroySSA } = require('./ssa');
const constProp = require('./passes/constProp');
const dce = require('./passes/dce');
const cse = require('./passes/cse');
const copyProp = require('./passes/copyProp');
const loopOpt = require('./passes/loopOpt');
const inline = require('./passes/inline');
const escape = require('./passes/escape');
const devirt = require('./passes/devirt');
const regalloc = require('./regalloc');
const scheduler = require('./scheduler');
const peephole = require('./peephole');
const gvn = require('./gvn');
const spill = require('./spill');

/**
 * 把 POJO 函数转成 Func 对象（若需要）
 */
function normalizeFunc(pojo) {
  if (pojo instanceof I.Func) return pojo;
  const fn = new I.Func(pojo.name, pojo.params || []);
  for (const bb of pojo.blocks) {
    const nb = new I.Block(bb.id);
    nb.instrs = bb.instrs.map(i => ({ ...i, args: i.args ? [...i.args] : undefined }));
    nb.term = { ...bb.term };
    fn.blocks.push(nb);
  }
  I.buildCFG(fn);
  return fn;
}

/**
 * 优化整个程序。
 * @param {{functions:Array}} program
 * @param {{dumpEach?:boolean, regs?:number}} opts
 * @returns {{functions:Func[], allocation:Map, scheduled:Array}}
 */
function optimizeProgram(program, opts = {}) {
  const fnPool = new Map();
  const funcs = program.functions.map(normalizeFunc);
  for (const f of funcs) fnPool.set(f.name, f);

  const dump = opts.dumpEach || false;

  for (const fn of funcs) {
    if (dump) console.log(`\n=== [原始] ${fn.name} ===\n` + I.funcToString(fn));

    // 1. CFG + SSA
    I.buildCFG(fn);
    toSSA(fn);
    if (dump) console.log(`\n=== [SSA] ${fn.name} ===\n` + I.funcToString(fn));

    // 2. 优化 pass 循环（跑 2 轮，让内联后重新优化）
    for (let round = 0; round < 2; round++) {
      constProp.constPropagate(fn);
      dce.eliminateDeadCode(fn);
      gvn.globalValueNumbering(fn);
      cse.eliminateCSE(fn);
      copyProp.propagateCopies(fn);
      dce.eliminateDeadCode(fn);
      loopOpt.optimizeLoops(fn);
      escape.escapeAnalysis(fn);
      devirt.devirtualize(fn, fnPool);
    }

    // 3. 函数内联（全局，跑一轮）
    inline.inlineFunctions(fnPool, opts.inlineThreshold || 20);
    // 内联后重跑一遍优化
    for (const f of fnPool.values()) {
      constProp.constPropagate(f);
      dce.eliminateDeadCode(f);
      cse.eliminateCSE(f);
      copyProp.propagateCopies(f);
      dce.eliminateDeadCode(f);
    }

    if (dump) console.log(`\n=== [优化后] ${fn.name} ===\n` + I.funcToString(fn));

    // 4. 销毁 SSA（phi -> mov）
    destroySSA(fn);
    if (dump) console.log(`\n=== [SSA销毁] ${fn.name} ===\n` + I.funcToString(fn));
  }

  // 5. 寄存器分配（每个函数独立）
  const allocation = new Map();
  for (const fn of funcs) {
    const allocResult = regalloc.allocate(fn, opts.numIntRegs || 13, opts.numFpRegs || 15);
    // 插入溢出 load/store 代码
    if (allocResult.spilled.length > 0) {
      spill.insertSpillCode(fn, new Set(allocResult.spilled), allocResult.color);
    }
    allocation.set(fn.name, allocResult);
  }

  // 6. 指令调度
  const scheduled = [];
  for (const fn of funcs) {
    scheduled.push(scheduler.scheduleFunction(fn, allocation.get(fn.name)));
  }

  // 7. 窥孔优化
  for (const fn of funcs) peephole.optimize(fn);

  return { functions: funcs, allocation, scheduled };
}

module.exports = { optimizeProgram, normalizeFunc };
