// ============================================================
// ir.js —— 三地址码 IR 的数据结构与工具函数
//
// 这是优化器与代码生成器之间的【契约】：
//   输入：AST 后端产出的三地址码 IR（本格式）
//   输出：优化后的 IR + 寄存器分配结果 + 调度后的指令序列
//
// 设计：
//   Program  = { functions: [Function] }
//   Function = { name, params:[str], blocks:[Block] }
//   Block    = { id, instrs:[Instr], term:Term, preds:[id], succs:[id] }
//   Instr    = 三地址指令（见下）
//   Term     = {kind:'jump',target} | {kind:'branch',cond,then,else}
//            | {kind:'return',value} | {kind:'unreachable'}
//
// 指令形式（三地址）：
//   {op:'const', dest, value}                  // dest = 字面量
//   {op:'mov',   dest, src}                    // dest = src
//   {op:'add'|'sub'|'mul'|'div'|'mod'|
//     'lt'|'le'|'eq'|'ne'|'gt'|'ge'|
//     'and'|'or', dest, left, right}           // dest = left OP right
//   {op:'neg'|'not', dest, src}                // 一元
//   {op:'call',  dest, name, args:[...]}       // dest = name(args)
//   {op:'load',  dest, base, offset}           // dest = *(base+offset)
//   {op:'store', base, offset, src}            // *(base+offset) = src
//   {op:'phi',   dest, blocks:[...], args:[...]}  // SSA phi
//
// 操作数约定：
//   - 所有变量/临时量都是【名字】字符串（如 "t1"、"x"、"x#2"）。
//   - 常量只出现在 const 指令的 value 字段；指令里 left/right/src 都是名字。
//   - SSA 版本号通过名字后缀 "#n" 表示（如 "x#3"），由 ssa.js 重命名产生。
// ============================================================

'use strict';

// ---------- 指令构造器（便于手写测试 IR） ----------
const const_  = (dest, value) => ({ op: 'const', dest, value });
const mov     = (dest, src)   => ({ op: 'mov', dest, src });
const binop   = (op, dest, left, right) => ({ op, dest, left, right });
const unop    = (op, dest, src) => ({ op, dest, src });
const call    = (dest, name, args = []) => ({ op: 'call', dest, name, args });
const phi     = (dest, blocks, args) => ({ op: 'phi', dest, blocks: [...blocks], args: [...args] });
const unbox   = (dest, src, kind = 'int') => ({ op: 'unbox', dest, src, kind });
const itof    = (dest, src) => ({ op: 'itof', dest, src }); // int -> double 转换

// ---------- 终结符 ----------
const jump      = (target) => ({ kind: 'jump', target });
const branch    = (cond, thenBlock, elseBlock) => ({ kind: 'branch', cond, then: thenBlock, else: elseBlock });
const ret       = (value) => ({ kind: 'return', value });
const unreachable = () => ({ kind: 'unreachable' });

// ---------- 基本块 ----------
class Block {
  constructor(id) {
    this.id = id;
    this.instrs = [];   // 非终结指令
    this.term = unreachable();
    this.preds = [];    // 前驱块 id 列表
    this.succs = [];    // 后继块 id 列表
  }
}

// ---------- 函数 ----------
class Func {
  constructor(name, params = []) {
    this.name = name;
    this.params = [...params];
    this.blocks = [];
  }
  addBlock(b) { this.blocks.push(b); return b; }
  newBlock() { const b = new Block(this.blocks.length); this.blocks.push(b); return b; }
  block(id) { return this.blocks[id]; }
}

// ============================================================
// CFG 构建：根据 term 填充 preds / succs
// ============================================================
function buildCFG(fn) {
  // 清掉旧数据
  for (const b of fn.blocks) { b.preds = []; b.succs = []; }
  for (const b of fn.blocks) {
    const t = b.term;
    if (t.kind === 'jump') {
      b.succs.push(t.target);
    } else if (t.kind === 'branch') {
      b.succs.push(t.then, t.else);
    } else if (t.kind === 'return' || t.kind === 'unreachable') {
      // 无后继
    } else {
      throw new Error(`未知终结符: ${t.kind}`);
    }
  }
  // 反向填 preds
  for (const b of fn.blocks) {
    for (const s of b.succs) {
      fn.blocks[s].preds.push(b.id);
    }
  }
  return fn;
}

// ============================================================
// 指令操作数工具
// ============================================================

// 一条指令读取的所有变量（use 集合）
function instrUse(instr) {
  const uses = [];
  switch (instr.op) {
    case 'const':
    case 'phi':
      break;
    case 'mov':
    case 'neg':
    case 'not':
      uses.push(instr.src);
      break;
    case 'call':
      for (const a of instr.args) uses.push(a);
      break;
    case 'unbox':
      uses.push(instr.src);
      break;
    case 'itof':
      uses.push(instr.src);
      break;
    case 'load':
      uses.push(instr.base);
      break;
    case 'store':
      uses.push(instr.base, instr.src);
      break;
    default: // 二元运算
      uses.push(instr.left, instr.right);
  }
  return uses;
}

// 一条指令定义（写入）的变量
function instrDef(instr) {
  if (instr.op === 'store') return null;
  return instr.dest || null;
}

// 终结符读取的变量
function termUse(term) {
  switch (term.kind) {
    case 'branch': return [term.cond];
    case 'return': return term.value != null ? [term.value] : [];
    default: return [];
  }
}

// 判断指令是否有副作用（不能被 DCE 删除）
function hasSideEffect(instr) {
  switch (instr.op) {
    case 'call':   // 保守假设调用有副作用
    case 'store':
      return true;
    default:
      return false;
  }
}

// 判断指令是否是可折叠的纯计算（无副作用）
function isPure(instr) {
  return !hasSideEffect(instr);
}

// ============================================================
// 克隆工具（优化 pass 需要拷贝 IR）
// ============================================================
function cloneInstr(i) { return { ...i, args: i.args ? [...i.args] : undefined }; }
function cloneBlock(b) {
  const nb = new Block(b.id);
  nb.instrs = b.instrs.map(cloneInstr);
  nb.term = { ...b.term };
  return nb;
}
function cloneFunc(fn) {
  const nf = new Func(fn.name, fn.params);
  nf.blocks = fn.blocks.map(cloneBlock);
  buildCFG(nf);
  return nf;
}

// ============================================================
// 打印（调试用）
// ============================================================
function instrToString(i) {
  switch (i.op) {
    case 'const': return `  ${i.dest} = ${JSON.stringify(i.value)}`;
    case 'mov':    return `  ${i.dest} = ${i.src}`;
    case 'phi':    return `  ${i.dest} = phi(${i.args.join(', ')})  [from ${i.blocks.join(',')}]`;
    case 'call':   return `  ${i.dest} = call ${i.name}(${i.args.join(', ')})`;
    case 'unbox':  return `  ${i.dest} = unbox_${i.kind}(${i.src})`;
    case 'itof':   return `  ${i.dest} = itof(${i.src})`;
    case 'load':   return `  ${i.dest} = *(${i.base} + ${i.offset})`;
    case 'store':  return `  *(${i.base} + ${i.offset}) = ${i.src}`;
    default:
      if (['neg','not'].includes(i.op)) return `  ${i.dest} = ${i.op} ${i.src}`;
      return `  ${i.dest} = ${i.left} ${i.op} ${i.right}`;
  }
}
function termToString(t) {
  switch (t.kind) {
    case 'jump':      return `  goto L${t.target}`;
    case 'branch':    return `  if ${t.cond} goto L${t.then} else goto L${t.else}`;
    case 'return':    return `  ret ${t.value != null ? t.value : ''}`;
    case 'unreachable': return `  unreachable`;
  }
}
function funcToString(fn) {
  const lines = [`function ${fn.name}(${fn.params.join(', ')}) {`];
  for (const b of fn.blocks) {
    lines.push(`L${b.id}:`);
    for (const i of b.instrs) lines.push(instrToString(i));
    lines.push(termToString(b.term));
  }
  lines.push('}');
  return lines.join('\n');
}

module.exports = {
  // 构造器
  const_, mov, binop, unop, call, phi, unbox, itof,
  jump, branch, ret, unreachable,
  Block, Func,
  // CFG
  buildCFG,
  // 操作数
  instrUse, instrDef, termUse, hasSideEffect, isPure,
  // 克隆
  cloneInstr, cloneBlock, cloneFunc,
  // 打印
  instrToString, termToString, funcToString,
};
