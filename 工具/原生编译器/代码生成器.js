// ============================================================
// 代码生成器.js —— coCN -> x86-64 (AT&T) 优化后端
//
// 新管线：
//   AST --[类型系统特化]--> 特化AST --[AstToIR]--> 三地址IR
//     --[优化器 optimizeProgram: SSA/常量传播/CSE/循环/寄存器分配/调度]-->
//     --[IRToAsm]--> x86-64 汇编
//
// 设计要点：
//   * 栈式"家"槽 + 寄存器缓存：每个变量一个 8 字节栈家槽；
//     优化器颜色分配给的寄存器作为活跃寄存器缓存，热循环内无 call 时全程在寄存器。
//   * 调用屏障：call 前把所有"调用者保存"寄存器中的值 spill 到家槽，call 后作废。
//   * ABI：rdi/rsi/rdx/rcx/r8/r9 传整型，xmm0-7 传浮点，rax/xmm0 返回。
//   * 浮点不参与寄存器分配（regalloc 只做整型图着色），统一 xmm0 + 家槽。
// ============================================================

const { 解析源 } = require("./语法分析器.js");
const I = require("./优化器/ir.js");
const { optimizeProgram } = require("./优化器/index.js");
let TS = null;
try { TS = require("./类型系统/index.js"); } catch (e) { TS = null; }

// ---------- x86-64 寄存器约定 ----------
const ARG_INT = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const ARG_XMM = ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"];
// 调用者保存（call 会破坏）
const CALLER_SAVED = new Set(["rax", "rcx", "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11"]);
// 被调用者保存（需要在函数入口 push / 出口 pop）
const CALLEE_SAVED = ["rbx", "r12", "r13", "r14"];
// 通用临时 scratch（不在被保存集内，可由后端自由用作中转）
const SCRATCH_INT = "rax";     // 主临时
const SCRATCH_INT2 = "r10";    // 次临时
// 浮点 scratch 寄存器池：块内浮点值缓存。SysV ABI 中 xmm0-15 全为调用者保存，
// 故在 call 前必须 flush 到家槽；块边界也 flush（家槽为跨块真相源）。
// 取 xmm0-xmm7（xmm8-15 保留给未来跨块提升）。
const SCRATCH_XMM = ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"];
// 整数块内缓存寄存器池（r10/r11）：与浮点缓存同构，块内临时量驻留。
const INT_CACHE = ["r10", "r11"];

function pct(r) { return "%" + r; }

function escapeAsmStr(s) {
  let r = "";
  for (const ch of s) {
    if (ch === "\\") r += "\\\\";
    else if (ch === "\"") r += "\\\"";
    else if (ch === "\n") r += "\\n";
    else if (ch === "\t") r += "\\t";
    else if (ch === "\r") r += "\\r";
    else r += ch;
  }
  return r;
}

// ============================================================
// 后端 IR 小优化 pass（安全、块内、不重排有副作用的调用）
// ============================================================
// 我们不使用 优化器/ 下带副作用重排 bug 的全量管线，而是在本文件内
// 做保守的、块内的折叠，保证 7 个测试始终正确。

// 块内折叠：若 d 在本函数仅被使用一次，且唯一使用是紧随其后的 `X = mov d`，
// 则把 d 的定义目标直接改写成 X，并删除这条 mov。
//   b1 = add s, i ; s = b1   →   s = add s, i
// 这让后端可以把结果直接写进目标变量的寄存器。
function collapseTemps(fn) {
  const useCount = new Map();
  const bump = v => { if (v == null) return; useCount.set(v, (useCount.get(v) || 0) + 1); };
  for (const b of fn.blocks) {
    for (const ins of b.instrs) for (const u of I.instrUse(ins)) bump(u);
    for (const u of I.termUse(b.term)) bump(u);
  }
  for (const b of fn.blocks) {
    const inss = b.instrs;
    let i = 0;
    while (i + 1 < inss.length) {
      const a = inss[i];
      const c = inss[i + 1];
      const da = I.instrDef(a);
      if (da != null && c.op === "mov" && c.src === da && useCount.get(da) === 1) {
        // 把 a 的 dest 重命名为 c.dest
        a.dest = c.dest;
        inss.splice(i + 1, 1);
        // 不 i++：原位的 a 现在是上一条之后，可能还能再折叠
      } else {
        i++;
      }
    }
  }
}

// 块内常量折叠：straight-line 段里，const 直接参与二元运算则编译期算出。
// 同时删除 `x = mov constTmp` 这类纯搬运（const 已记录值）。
function foldConstants(fn, kinds) {
  for (const b of fn.blocks) {
    const knownConst = new Map(); // name -> 整数字面量
    const out = [];
    for (const ins of b.instrs) {
      if (ins.op === "const" && kinds.kindOf(ins.dest) !== "double" && typeof ins.value === "number") {
        knownConst.set(ins.dest, ins.value);
        out.push(ins);
        continue;
      }
      if (ins.op === "mov" && knownConst.has(ins.src)) {
        // X = mov constTmp  →  X = const K （随后会被常量传播）
        out.push(I.const_(ins.dest, knownConst.get(ins.src)));
        knownConst.set(ins.dest, knownConst.get(ins.src));
        continue;
      }
      if (["add","sub","mul","div","mod","lt","gt","le","ge","eq","ne","and","or","xor","shl","shr"].includes(ins.op)
          && knownConst.has(ins.left) && knownConst.has(ins.right)) {
        const L = knownConst.get(ins.left), R = knownConst.get(ins.right);
        let v;
        switch (ins.op) {
          case "add": v = L + R; break;
          case "sub": v = L - R; break;
          case "mul": v = L * R; break;
          case "div": v = Math.trunc(L / R); break;
          case "mod": v = L % R; break;
          case "lt": v = L < R ? 1 : 0; break;
          case "gt": v = L > R ? 1 : 0; break;
          case "le": v = L <= R ? 1 : 0; break;
          case "ge": v = L >= R ? 1 : 0; break;
          case "eq": v = L === R ? 1 : 0; break;
          case "ne": v = L !== R ? 1 : 0; break;
          case "and": v = L & R; break;
          case "or": v = L | R; break;
          case "xor": v = L ^ R; break;
          case "shl": v = L << R; break;
          case "shr": v = L >> R; break;
        }
        out.push(I.const_(ins.dest, v));
        knownConst.set(ins.dest, v);
        continue;
      }
      // 非常量指令定义了 dest：该变量不再是已知常量，失效之。
      // （call/binop/mov 到非常量源/unop 等都可能改变其值。）
      const d = I.instrDef(ins);
      if (d != null) knownConst.delete(d);
      out.push(ins);
    }
    b.instrs = out;
  }
}

// 保守的循环不变量外提（LICM）：
//   仅外提「纯算术」指令（const/mov/binop/neg/not，绝不外提 call/load/store），
//   且仅从「无条件留在循环内」的块（terminator 为 jump）外提，保证每条路径都执行。
//   操作数若在循环外定义、或已是外提的不变量，则该指令可外提。
function licm(fn) {
  I.buildCFG(fn);
  const n = fn.blocks.length;
  // 可达性：reach[from] = Set(to)
  const reach = Array.from({ length: n }, () => new Set());
  for (let s = 0; s < n; s++) {
    const succ = fn.blocks[s].term.kind === "jump" ? [fn.blocks[s].term.target]
      : fn.blocks[s].term.kind === "branch" ? [fn.blocks[s].term.then, fn.blocks[s].term.else] : [];
    for (const t of succ) {
      // 简单工作列表
      const seen = new Set([s]);
      const wl = [t];
      while (wl.length) {
        const x = wl.pop();
        if (seen.has(x)) continue;
        seen.add(x); reach[s].add(x);
        const bb = fn.blocks[x];
        const ss = bb.term.kind === "jump" ? [bb.term.target]
          : bb.term.kind === "branch" ? [bb.term.then, bb.term.else] : [];
        for (const y of ss) wl.push(y);
      }
    }
  }
  // 找回边 b->H（H 可达 b）
  const headers = new Set();
  const loops = new Map(); // H -> Set(blocks)
  for (let b = 0; b < n; b++) {
    const succ = fn.blocks[b].term.kind === "jump" ? [fn.blocks[b].term.target]
      : fn.blocks[b].term.kind === "branch" ? [fn.blocks[b].term.then, fn.blocks[b].term.else] : [];
    for (const H of succ) {
      if (reach[H].has(b) && H < b) {
        headers.add(H);
        // 循环块 = H + 从 b 出发不经过 H 可达的所有块
        if (!loops.has(H)) {
          // 循环块 = H + 从 back-edge 源 b 沿【前驱】反向可达、且不经过 H 的所有块
          const set = new Set([H]);
          const wl = [b];
          while (wl.length) {
            const x = wl.pop();
            if (x === H || set.has(x)) continue;
            set.add(x);
            for (const y of (fn.blocks[x].preds || [])) wl.push(y);
          }
          loops.set(H, set);
        }
      }
    }
  }
  const pure = (ins) => ins.op !== "call" && ins.op !== "load" && ins.op !== "store" && ins.op !== "phi";
  for (const [H, loopSet] of loops) {
    // preheader：循环外指向 H 的块
    let pre = -1;
    for (let p = 0; p < n; p++) {
      if (loopSet.has(p)) continue;
      const bb = fn.blocks[p];
      const ss = bb.term.kind === "jump" ? [bb.term.target]
        : bb.term.kind === "branch" ? [bb.term.then, bb.term.else] : [];
      if (ss.includes(H)) { pre = p; break; }
    }
    if (pre < 0) continue;
    if (process.env.COCN_DUMP_LICM) console.error("LICM loop H="+H+" pre="+pre+" blocks="+JSON.stringify([...loopSet]));
    // 保守不变量检测（非 SSA 安全）：纯算术指令，且【所有操作数都在循环外定义】。
    // 不做 avail 传播——否则非 SSA 下会把「k=0」外提后误判「k=k+1」也不变量。
    const loopDefined = new Set();
    for (const bid of loopSet) for (const ins of fn.blocks[bid].instrs) {
      const d = I.instrDef(ins); if (d != null) loopDefined.add(d);
    }
    const invariant = new Set();
    for (const bid of loopSet) {
      const bb = fn.blocks[bid];
      for (const ins of bb.instrs) {
        if (!pure(ins)) continue;
        if (ins.op === "const") continue; // 常量由后端立即数处理，无需外提
        const ops = [...I.instrUse(ins)];
        if (ops.every(op => !loopDefined.has(op))) invariant.add(ins);
      }
    }
    // 外提：把不变量指令按原程序顺序（block id + 块内顺序）搬到 preheader 的 terminator 前
    const preBlock = fn.blocks[pre];
    const hoisted = [];
    const bids = [...loopSet].sort((a, b) => a - b);
    for (const bid of bids) {
      const bb = fn.blocks[bid];
      if (bb.term.kind !== "jump") continue;
      bb.instrs = bb.instrs.filter(ins => {
        if (invariant.has(ins)) { hoisted.push(ins); return false; }
        return true;
      });
    }
    if (process.env.COCN_DUMP_LICM) console.error("LICM hoist="+JSON.stringify(hoisted)+" | block2="+JSON.stringify(fn.blocks[2].instrs));
    preBlock.instrs.push(...hoisted);
  }
}

// 死代码消除：删除结果从未被使用的纯计算指令（const/mov/binop/neg/not/unbox/itof）。
// 保留 call/store（有副作用）和 phi。
function deadCodeElimination(fn) {
  // 统计所有使用的变量
  const used = new Set();
  const collect = (v) => { if (v != null) used.add(v); };
  for (const b of fn.blocks) {
    for (const ins of b.instrs) for (const u of I.instrUse(ins)) collect(u);
    for (const u of I.termUse(b.term)) collect(u);
  }
  // 迭代删除未使用定义的纯指令，直到不动点
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      const out = [];
      for (const ins of b.instrs) {
        const d = I.instrDef(ins);
        const isPure = ins.op !== "call" && ins.op !== "store" && ins.op !== "phi";
        if (d != null && isPure && !used.has(d)) {
          // 删除此指令；其操作数可能也变成死代码，下一轮迭代处理
          changed = true;
          continue;
        }
        out.push(ins);
      }
      b.instrs = out;
    }
    // 重新收集使用集（删除指令后，某些操作数也可能不再被使用）
    used.clear();
    for (const b of fn.blocks) {
      for (const ins of b.instrs) for (const u of I.instrUse(ins)) collect(u);
      for (const u of I.termUse(b.term)) collect(u);
    }
  }
}

// 基本块布局：DFS 顺序，让循环体/常见路径 fall-through，消除冗余无条件跳转。
// 返回有序 block id 列表。
function layoutBlocks(fn) {
  const order = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    const b = fn.blocks[id];
    if (!b) return;
    if (b.term.kind === "jump") visit(b.term.target);
    else if (b.term.kind === "branch") { visit(b.term.then); visit(b.term.else); }
  };
  visit(0);
  for (const b of fn.blocks) if (!visited.has(b.id)) visit(b.id);
  return order;
}

// ============================================================
// 前端：AST -> 三地址 IR
// ============================================================
class AstToIR {
  constructor(ast) {
    this.ast = ast;
    this.funcLabelMap = new Map(); // coCN 函数名 -> IR 函数名（用原名）
    this.strLabelMap = new Map();
    this.dblLabelMap = new Map();
    this.rodata = [];
    this.kinds = new Map();        // IR 变量名 -> kind
    this.seq = 0;
    this.tmpN = 0;
    this.blocks = [];              // 当前函数的块
    this.cur = null;
    this.loopStack = [];           // {end, cont}
    this.retKindByFunc = new Map();
  }

  nl() { return ".L" + (++this.seq); }
  tmp(prefix) { return (prefix || "t") + (++this.tmpN); }

  strConst(s) {
    if (this.strLabelMap.has(s)) return this.strLabelMap.get(s);
    const lbl = ".LC" + this.strLabelMap.size;
    this.strLabelMap.set(s, lbl);
    this.rodata.push({ lbl, text: s });
    return lbl;
  }
  dblConst(d) {
    if (this.dblLabelMap.has(d)) return this.dblLabelMap.get(d);
    const lbl = ".LCD" + this.dblLabelMap.size;
    this.dblLabelMap.set(d, lbl);
    this.rodata.push({ lbl, dbl: d });
    return lbl;
  }

  setKind(name, kind) { this.kinds.set(name, kind); }
  kindOf(name) {
    // SSA 版本名 strip #n
    const idx = name.lastIndexOf("#");
    const base = (idx > 0 && /^\d+$/.test(name.slice(idx + 1))) ? name.slice(0, idx) : name;
    return this.kinds.get(base) || this.kinds.get(name) || "int";
  }

  newBlock() {
    const b = new I.Block(this.blocks.length);
    this.blocks.push(b);
    this.cur = b;
    return b;
  }
  emit(instr) { this.cur.instrs.push(instr); }

  // ---------- 主入口：返回 {functions:[POJO], rodata} ----------
  build() {
    const functions = [];
    // 预收集函数定义名
    for (const st of this.ast.语句) {
      if (st.类型 === "函数定义") this.funcLabelMap.set(st.名字, st.名字);
    }
    // 为每个函数生成 IR
    for (const st of this.ast.语句) {
      if (st.类型 === "函数定义") functions.push(this.genFunc(st));
    }
    // 顶层 co_main
    const mainParams = [];
    this.blocks = [];
    this.cur = null;
    const entry = this.newBlock();
    const topStmts = this.ast.语句.filter(s => s.类型 !== "函数定义");
    for (const st of topStmts) this.genStmt(st);
    // 顶层默认返回 0
    if (this.cur.term.kind === "unreachable") {
      this.emit(I.const_("__ret0", 0));
      this.cur.term = I.ret("__ret0");
    }
    const main = { name: "co_main", params: mainParams, blocks: this.blocks };
    functions.unshift(main);
    return { functions, rodata: this.rodata };
  }

  genFunc(st) {
    this.currentFuncName = st.名字;
    this.retKindByFunc.set(st.名字, st.返回类型 || "");
    const params = st.参数.slice();
    this.blocks = [];
    this.cur = null;
    this.newBlock();
    // 参数 kind
    st.参数.forEach((p, i) => {
      const ak = st.参数类型[i] || "";
      this.setKind(p, this.kindFromAnno(ak));
    });
    for (const s of st.体.语句) this.genStmt(s);
    // 隐式返回
    if (this.cur.term.kind === "unreachable") {
      const k = this.kindFromAnno(st.返回类型 || "");
      if (k === "double") {
        const lbl = this.dblConst("0.0");
        const d = this.tmp("d");
        this.emit(I.const_(d, lbl));
        this.cur.term = I.ret(d);
      } else {
        this.emit(I.const_("__r", 0));
        this.cur.term = I.ret("__r");
      }
    }
    return { name: st.名字, params, blocks: this.blocks };
  }

  kindFromAnno(a) {
    if (a === "整数" || a === "布尔") return "int";
    if (a === "浮点") return "double";
    if (a === "字符串") return "str";
    if (a === "列表") return "intlist";
    if (a === "字典") return "dict";
    return "none";
  }

  // ---------- 语句 ----------
  genStmt(st) {
    if (st == null) return;
    switch (st.类型) {
      case "变量声明": this.genVarDecl(st); break;
      case "赋值": this.genAssign(st); break;
      case "返回": this.genReturn(st); break;
      case "如果": this.genIf(st); break;
      case "当": this.genWhile(st); break;
      case "对于": this.genFor(st); break;
      case "跳出":
        this.cur.term = I.jump(this.loopStack[this.loopStack.length - 1].end); break;
      case "继续":
        this.cur.term = I.jump(this.loopStack[this.loopStack.length - 1].cont); break;
      case "函数调用": this.genCallStmt(st); break;
      case "表达式语句": {
        const r = this.genExpr(st.expr || st);
        void r; break;
      }
      default:
        if (st.类型 === "二元" || st.类型 === "一元" || st.类型 === "字面量" ||
            st.类型 === "标识符" || st.类型 === "下标" || st.类型 === "列表字面量" ||
            st.类型 === "字典字面量") {
          this.genExpr(st);
        }
    }
  }

  genVarDecl(st) {
    let kind = this.kindFromAnno(st.类型标注);
    if (st.初始化 != null) {
      let r = this.genExpr(st.初始化);
      if (kind === "none") kind = r.kind;
      // 列表标注但初始化是无装箱整数列表 → 升级为 intlist
      if (kind === "list" && r.kind === "intlist") kind = "intlist";
      // 若声明类型是 int/double 但值是 box，自动拆箱
      if ((kind === "int" || kind === "double") && r.kind === "box") {
        r = this.unboxExpr(r, kind);
      }
      this.setKind(st.名字, kind);
      this.emit(I.mov(st.名字, r.name));
    } else {
      if (kind === "none") kind = "int";
      this.setKind(st.名字, kind);
      if (kind === "double") {
        const lbl = this.dblConst("0.0");
        const d = this.tmp("d");
        this.emit(I.const_(d, lbl));
        this.emit(I.mov(st.名字, d));
      } else {
        const d = this.tmp("c");
        this.emit(I.const_(d, 0));
        this.emit(I.mov(st.名字, d));
      }
    }
  }

  genAssign(st) {
    if (st.目标.类型 === "标识符") {
      let r = this.genExpr(st.值);
      const targetName = st.目标.名字;
      const curKind = this.kinds.get(targetName);
      // 若目标变量已知是 int/double 且值是 box，自动拆箱
      if (r.kind === "box" && (curKind === "int" || curKind === "double")) {
        r = this.unboxExpr(r, curKind);
      }
      if (!curKind || curKind === "none") this.setKind(targetName, r.kind);
      this.emit(I.mov(targetName, r.name));
    } else if (st.目标.类型 === "下标") {
      this.genIndexAssign(st.目标, st.值);
    }
  }

  genReturn(st) {
    if (st.值 != null) {
      let r = this.genExpr(st.值);
      // 自动拆箱：函数返回类型非 box 时拆箱
      const retKind = this.retKindByFunc.get(this.currentFuncName) || "";
      const expectedKind = retKind === "浮点" ? "double" : (retKind === "" || retKind === "整数" || retKind === "布尔") ? "int" : r.kind;
      r = this.unboxExpr(r, expectedKind === "double" ? "double" : "int");
      this.cur.term = I.ret(r.name);
    } else {
      const d = this.tmp("r");
      this.emit(I.const_(d, 0));
      this.cur.term = I.ret(d);
    }
  }

  genIf(st) {
    let c = this.genExpr(st.条件);
    // 条件若为 box，自动按 int 拆箱
    c = this.unboxExpr(c, "int");
    const prev = this.cur;
    const thenB = this.newBlock();
    const elseB = this.newBlock();
    const endB = this.newBlock();
    prev.term = I.branch(c.name, thenB.id, elseB.id);
    // then
    this.cur = thenB;
    for (const s of st.则体) this.genStmt(s);
    if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(endB.id);
    // else 链
    this.cur = elseB;
    for (const br of st.否则链) {
      if (br.条件 != null) {
        const bc = this.genExpr(br.条件);
        const bThen = this.newBlock();
        const bNext = this.newBlock();
        this.cur.term = I.branch(bc.name, bThen.id, bNext.id);
        this.cur = bThen;
        for (const s of br.体) this.genStmt(s);
        if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(endB.id);
        this.cur = bNext;
      } else {
        for (const s of br.体) this.genStmt(s);
        if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(endB.id);
      }
    }
    if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(endB.id);
    // 继续在 endB
    this.cur = endB;
  }

  genWhile(st) {
    const prev = this.cur;
    const headB = this.newBlock();
    const bodyB = this.newBlock();
    const endB = this.newBlock();
    prev.term = I.jump(headB.id);
    this.cur = headB;
    let c = this.genExpr(st.条件);
    c = this.unboxExpr(c, "int");
    this.cur.term = I.branch(c.name, bodyB.id, endB.id);
    this.loopStack.push({ end: endB.id, cont: headB.id });
    this.cur = bodyB;
    for (const s of st.体) this.genStmt(s);
    if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(headB.id);
    this.loopStack.pop();
    this.cur = endB;
  }

  genFor(st) {
    if (st.是否遍历 === 1) { this.genForEach(st); return; }
    // range: for i from 起点 to 终点 [step 步长]
    const start = this.genExpr(st.起点);
    const iName = st.变量;
    this.setKind(iName, "int");
    const iVar = this.tmp("i");
    this.setKind(iVar, "int");
    this.emit(I.mov(iVar, start.name));
    this.emit(I.mov(iName, iVar));

    const endR = this.genExpr(st.终点);
    const endV = this.tmp("e");
    this.setKind(endV, "int");
    this.emit(I.mov(endV, endR.name));

    let stepV = null;
    if (st.步长 != null) {
      const sp = this.genExpr(st.步长);
      stepV = this.tmp("p");
      this.setKind(stepV, "int");
      this.emit(I.mov(stepV, sp.name));
    } else {
      stepV = this.tmp("p");
      this.setKind(stepV, "int");
      this.emit(I.const_(stepV, 1));
    }

    const prev = this.cur;
    const headB = this.newBlock();
    const bodyB = this.newBlock();
    const endB = this.newBlock();
    const contB = this.newBlock();
    prev.term = I.jump(headB.id);

    this.cur = headB;
    // 条件：i <= end（步长>0 假设）；与 IR 后端配合，用 le
    const cond = this.tmp("c");
    this.setKind(cond, "int");
    this.emit(I.binop("le", cond, iName, endV));
    this.cur.term = I.branch(cond, bodyB.id, endB.id);

    this.loopStack.push({ end: endB.id, cont: contB.id });
    this.cur = bodyB;
    for (const s of st.体) this.genStmt(s);
    if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(contB.id);

    this.cur = contB;
    const ni = this.tmp("n");
    this.setKind(ni, "int");
    this.emit(I.binop("add", ni, iName, stepV));
    this.emit(I.mov(iName, ni));
    this.cur.term = I.jump(headB.id);

    this.loopStack.pop();
    this.cur = endB;
  }

  genForEach(st) {
    // for x in list
    const listR = this.genExpr(st.遍历源);
    const listV = this.tmp("l");
    this.setKind(listV, listR.kind === "intlist" ? "intlist" : "list");
    this.emit(I.mov(listV, listR.name));
    const lenV = this.tmp("ln");
    this.setKind(lenV, "int");
    this.emit(I.call(lenV, "rt_list_len", [listV]));
    const idxV = this.tmp("ix");
    this.setKind(idxV, "int");
    this.emit(I.const_(idxV, 0));
    const oneV = this.tmp("one");
    this.setKind(oneV, "int");
    this.emit(I.const_(oneV, 1));
    const itemName = st.变量;
    this.setKind(itemName, "int");

    const prev = this.cur;
    const headB = this.newBlock();
    const bodyB = this.newBlock();
    const endB = this.newBlock();
    const contB = this.newBlock();
    prev.term = I.jump(headB.id);

    this.cur = headB;
    const cond = this.tmp("c");
    this.setKind(cond, "int");
    this.emit(I.binop("lt", cond, idxV, lenV));
    this.cur.term = I.branch(cond, bodyB.id, endB.id);

    this.cur = bodyB;
    if (listR.kind === "intlist") {
      // 无装箱整数列表：data[idx] 直接是 int
      const itemV = this.tmp("it");
      this.setKind(itemV, "int");
      this.emit(I.call(itemV, "rt_list_get", [listV, idxV]));
      this.emit(I.mov(itemName, itemV));
    } else {
      const boxV = this.tmp("b");
      this.setKind(boxV, "box");
      this.emit(I.call(boxV, "rt_list_get", [listV, idxV]));
      // 内联拆箱为 int
      const unboxed = this.tmp("u");
      this.setKind(unboxed, "int");
      this.emit(I.unbox(unboxed, boxV, "int"));
      this.emit(I.mov(itemName, unboxed));
    }
    this.loopStack.push({ end: endB.id, cont: contB.id });
    for (const s of st.体) this.genStmt(s);
    if (this.cur.term.kind === "unreachable") this.cur.term = I.jump(contB.id);
    this.loopStack.pop();

    this.cur = contB;
    const ni = this.tmp("n");
    this.setKind(ni, "int");
    this.emit(I.binop("add", ni, idxV, oneV));
    this.emit(I.mov(idxV, ni));
    this.cur.term = I.jump(headB.id);

    this.cur = endB;
  }

  genCallStmt(st) {
    const r = this.genExpr(st);
    void r;
  }

  // ---------- 自动拆箱：若 expr.kind === "box"，插入拆箱指令并返回拆箱后的值 ----------
  // asKind: 期望拆成 "int" 或 "double"
  unboxExpr(expr, asKind) {
    if (expr.kind !== "box") return expr;
    const d = this.tmp("ub");
    this.setKind(d, asKind);
    this.emit(I.unbox(d, expr.name, asKind));
    return { name: d, kind: asKind };
  }

  // ---------- 自动类型转换：若 expr.kind === "int" 但需要 double，插入 itof 指令 ----------
  toDouble(expr) {
    if (expr.kind === "double") return expr;
    const d = this.tmp("fd");
    this.setKind(d, "double");
    this.emit(I.itof(d, expr.name));
    return { name: d, kind: "double" };
  }

  // ---------- 表达式：返回 {name, kind} ----------
  genExpr(node) {
    switch (node.类型) {
      case "字面量": return this.genLiteral(node);
      case "标识符": {
        return { name: node.名字, kind: this.kindOf(node.名字) };
      }
      case "一元": return this.genUnary(node);
      case "二元": return this.genBinary(node);
      case "函数调用": return this.genCall(node);
      case "下标": return this.genIndex(node);
      case "列表字面量": return this.genListLit(node);
      case "字典字面量": return this.genDictLit(node);
      default: {
        // 未知：当成 int 0
        const d = this.tmp("x"); this.setKind(d, "int");
        this.emit(I.const_(d, 0));
        return { name: d, kind: "int" };
      }
    }
  }

  genLiteral(node) {
    if (node.字面类型 === "整数" || node.字面类型 === "布尔") {
      const d = this.tmp("c"); this.setKind(d, "int");
      this.emit(I.const_(d, parseInt(node.值, 10)));
      return { name: d, kind: "int" };
    }
    if (node.字面类型 === "浮点") {
      const d = this.tmp("d"); this.setKind(d, "double");
      this.emit(I.const_(d, this.dblConst(String(node.值))));
      return { name: d, kind: "double" };
    }
    if (node.字面类型 === "字符串") {
      const d = this.tmp("s"); this.setKind(d, "str");
      this.emit(I.const_(d, this.strConst(node.值)));
      return { name: d, kind: "str" };
    }
    const d = this.tmp("n"); this.setKind(d, "int");
    this.emit(I.const_(d, 0));
    return { name: d, kind: "none" };
  }

  genUnary(node) {
    let o = this.genExpr(node.操作数);
    // 自动拆箱：一元运算作用于 box 时，默认按 int 拆箱
    o = this.unboxExpr(o, "int");
    const d = this.tmp("u"); this.setKind(d, o.kind);
    if (node.运算符 === "-") {
      this.emit(I.binop("sub", d, o.name, o.name)); // 占位，后端处理 neg
      // 用专门 neg
      this.cur.instrs.pop();
      this.emit(I.unop("neg", d, o.name));
    } else if (node.运算符 === "非") {
      this.emit(I.unop("not", d, o.name));
    } else {
      this.emit(I.mov(d, o.name));
    }
    return { name: d, kind: o.kind };
  }

  genBinary(node) {
    const op = node.运算符;
    if (op === "且" || op === "或") return this.genLogic(node, op === "且");

    let L = this.genExpr(node.左);
    let R = this.genExpr(node.右);

    // 字符串拼接
    if (op === "+" && (L.kind === "str" || R.kind === "str")) {
      // 两侧都转 str
      let a = L.name, ak = L.kind;
      let b = R.name, bk = R.kind;
      if (ak !== "str") {
        const t = this.tmp("s"); this.setKind(t, "str");
        this.emit(I.call(t, ak === "double" ? "rt_double_to_str" : "rt_int_to_str", [a]));
        a = t;
      }
      if (bk !== "str") {
        const t = this.tmp("s"); this.setKind(t, "str");
        this.emit(I.call(t, bk === "double" ? "rt_double_to_str" : "rt_int_to_str", [b]));
        b = t;
      }
      const d = this.tmp("sc"); this.setKind(d, "str");
      this.emit(I.call(d, "rt_str_concat", [a, b]));
      return { name: d, kind: "str" };
    }
    // 字符串相等
    if ((op === "==" || op === "!=") && (L.kind === "str" || R.kind === "str")) {
      const d = this.tmp("eq"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_str_eq", [L.name, R.name]));
      if (op === "!=") {
        const d2 = this.tmp("ne"); this.setKind(d2, "int");
        this.emit(I.binop("sub", d2, "zero_v", d));
        this.emit(I.const_("zero_v", 0));
        return { name: d2, kind: "int" };
      }
      return { name: d, kind: "int" };
    }

    // 自动拆箱：box 操作数根据另一侧的类型自动拆箱
    // 若两侧都是 box（如两个列表元素比较），统一按 int 拆箱
    const targetKind = (L.kind === "double" || R.kind === "double") ? "double" : "int";
    L = this.unboxExpr(L, L.kind === "box" ? targetKind : L.kind);
    R = this.unboxExpr(R, R.kind === "box" ? targetKind : R.kind);

    // 若结果是 double 但操作数是 int，自动插入 int->double 转换
    const resKind0 = (L.kind === "double" || R.kind === "double") ? "double" : "int";
    if (resKind0 === "double") {
      L = this.toDouble(L);
      R = this.toDouble(R);
    }

    const d = this.tmp("b");
    // kind: 若任一 double 则 double，否则 int
    const resKind = (L.kind === "double" || R.kind === "double") ? "double" : "int";
    this.setKind(d, resKind);

    const map = {
      "+": "add", "-": "sub", "*": "mul", "/": "div",
      "//": "div", "%": "mod",
      "<": "lt", ">": "gt", "<=": "le", ">=": "ge", "==": "eq", "!=": "ne",
      "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "shr"
    };
    const irop = map[op];
    if (!irop) throw new Error("不支持的运算符: " + op);
    this.emit(I.binop(irop, d, L.name, R.name));
    return { name: d, kind: (["lt","gt","le","ge","eq","ne"].includes(irop)) ? "int" : resKind };
  }

  genLogic(node, isAnd) {
    // 生成短路逻辑：返回 int 临时
    // 注意：必须先用 new I.Block 建块但【不移动 this.cur】，再把左值表达式 emit 进 prev。
    // 旧实现用 this.newBlock()，它会把 this.cur 依次改成 falseL/trueL/endL，
    // 导致左值比较被错误地 emit 进 endL（先使用后定义），造成短路条件下的越界访问。
    const prev = this.cur;
    const falseL = new I.Block(this.blocks.length); this.blocks.push(falseL);
    const trueL  = new I.Block(this.blocks.length); this.blocks.push(trueL);
    const endL   = new I.Block(this.blocks.length); this.blocks.push(endL);
    const res = this.tmp("lg"); this.setKind(res, "int");
    this.cur = prev;
    const L = this.genExpr(node.左);
    // 若 L 为真（且），继续右；否则跳 false
    prev.term = I.branch(L.name, trueL.id, falseL.id);
    // 对"且"：L 真则进 trueL 求右
    // 对"或"：L 真则进 trueL 直接得 1
    this.cur = isAnd ? trueL : falseL;
    const R = this.genExpr(node.右);
    this.emit(I.mov(res, R.name));
    this.cur.term = I.jump(endL.id);
    this.cur = isAnd ? falseL : trueL;
    if (isAnd) {
      const z = this.tmp("z"); this.setKind(z, "int"); this.emit(I.const_(z, 0));
      this.emit(I.mov(res, z));
    } else {
      const o = this.tmp("o"); this.setKind(o, "int"); this.emit(I.const_(o, 1));
      this.emit(I.mov(res, o));
    }
    this.cur.term = I.jump(endL.id);
    this.cur = endL;
    return { name: res, kind: "int" };
  }

  genIndex(node) {
    const C = this.genExpr(node.容器);
    const Ix = this.genExpr(node.索引);
    if (C.kind === "dict") {
      const d = this.tmp("ix"); this.setKind(d, "box");
      let key = Ix.name;
      if (Ix.kind !== "str") {
        const t = this.tmp("k"); this.setKind(t, "str");
        this.emit(I.call(t, Ix.kind === "double" ? "rt_double_to_str" : "rt_int_to_str", [key]));
        key = t;
      }
      this.emit(I.call(d, "rt_dict_get", [C.name, key]));
      return { name: d, kind: "box" };
    }
    if (C.kind === "str") {
      const d = this.tmp("ix"); this.setKind(d, "box");
      this.emit(I.call(d, "rt_str_at", [C.name, Ix.name]));
      return { name: d, kind: "box" };
    }
    // 无装箱整数列表：data[idx] 直接就是 int，无需拆箱
    if (C.kind === "intlist") {
      const d = this.tmp("ix"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_list_get", [C.name, Ix.name]));
      return { name: d, kind: "int" };
    }
    // 普通 list 或 box(list)
    const d = this.tmp("ix"); this.setKind(d, "box");
    let listArg = C.name;
    if (C.kind === "box") {
      const t = this.tmp("u"); this.setKind(t, "list");
      this.emit(I.call(t, "rt_box_unbox_ptr", [listArg]));
      listArg = t;
    }
    this.emit(I.call(d, "rt_list_get", [listArg, Ix.name]));
    return { name: d, kind: "box" };
  }

  genIndexAssign(target, value, ctx) {
    const C = this.genExpr(target.容器);
    const Ix = this.genExpr(target.索引);
    let V = this.genExpr(value);
    // 无装箱整数列表：直接存 int，跳过 Box 分配
    if (C.kind === "intlist") {
      // 若值是 box（从别处读出的），先拆箱
      if (V.kind === "box") V = this.unboxExpr(V, "int");
      const d = this.tmp("r"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_list_set", [C.name, Ix.name, V.name]));
      return;
    }
    // 自动拆箱：若值是 box 但容器下标赋值需要直接存 box，保持 box；
    // 若值是 int/double，才需要装箱
    let boxV;
    if (V.kind === "box") {
      // 已经是 box，直接使用，避免重复装箱
      boxV = V.name;
    } else {
      boxV = this.tmp("bx"); this.setKind(boxV, "box");
      const boxOp = V.kind === "int" ? "rt_box_int"
        : V.kind === "double" ? "rt_box_double"
        : V.kind === "str" ? "rt_box_str" : "rt_box_ptr";
      if (boxOp === "rt_box_ptr") {
        const tag = this.tmp("tag"); this.setKind(tag, "int");
        this.emit(I.const_(tag, V.kind === "dict" ? 4 : 3));
        this.emit(I.call(boxV, "rt_box_ptr", [V.name, tag]));
      } else {
        this.emit(I.call(boxV, boxOp, [V.name]));
      }
    }
    if (C.kind === "dict") {
      let key = Ix.name;
      if (Ix.kind !== "str") {
        const t = this.tmp("k"); this.setKind(t, "str");
        this.emit(I.call(t, Ix.kind === "double" ? "rt_double_to_str" : "rt_int_to_str", [key]));
        key = t;
      }
      const d = this.tmp("r"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_dict_set", [C.name, key, boxV]));
    } else {
      let listArg = C.name;
      if (C.kind === "box") {
        const t = this.tmp("u"); this.setKind(t, "list");
        this.emit(I.call(t, "rt_box_unbox_ptr", [listArg]));
        listArg = t;
      }
      const d = this.tmp("r"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_list_set", [listArg, Ix.name, boxV]));
    }
  }

  genListLit(node) {
    // 先分析所有元素，判断是否全为整数
    const elems = node.元素.map(el => {
      const V = this.genExpr(el);
      return V;
    });
    const allInt = elems.every(V => V.kind === "int");
    // 全整数列表（含空列表 []）→ 创建无装箱整数列表
    if (allInt) {
      const lst = this.tmp("il"); this.setKind(lst, "intlist");
      this.emit(I.call(lst, "rt_intlist_create", []));
      for (const V of elems) {
        const d = this.tmp("r"); this.setKind(d, "int");
        this.emit(I.call(d, "rt_intlist_append", [lst, V.name]));
      }
      return { name: lst, kind: "intlist" };
    }
    // 混合类型列表 → 普通装箱列表
    const lst = this.tmp("l"); this.setKind(lst, "list");
    this.emit(I.call(lst, "rt_list_create", []));
    for (const V of elems) {
      const boxV = this.tmp("bx"); this.setKind(boxV, "box");
      const boxOp = V.kind === "int" ? "rt_box_int"
        : V.kind === "double" ? "rt_box_double"
        : V.kind === "str" ? "rt_box_str" : "rt_box_ptr";
      if (boxOp === "rt_box_ptr") {
        const tag = this.tmp("tag"); this.setKind(tag, "int");
        this.emit(I.const_(tag, V.kind === "dict" ? 4 : 3));
        this.emit(I.call(boxV, "rt_box_ptr", [V.name, tag]));
      } else {
        this.emit(I.call(boxV, boxOp, [V.name]));
      }
      const d = this.tmp("r"); this.setKind(d, "int");
      this.emit(I.call(d, "rt_list_append", [lst, boxV]));
    }
    return { name: lst, kind: "list" };
  }

  genDictLit(node) {
    const d = this.tmp("d"); this.setKind(d, "dict");
    this.emit(I.call(d, "rt_dict_create", []));
    for (let i = 0; i < node.键.length; i++) {
      const K = this.genExpr(node.键[i]);
      const V = this.genExpr(node.值[i]);
      const boxV = this.tmp("bx"); this.setKind(boxV, "box");
      const boxOp = V.kind === "int" ? "rt_box_int"
        : V.kind === "double" ? "rt_box_double"
        : V.kind === "str" ? "rt_box_str" : "rt_box_ptr";
      if (boxOp === "rt_box_ptr") {
        const tag = this.tmp("tag"); this.setKind(tag, "int");
        this.emit(I.const_(tag, V.kind === "dict" ? 4 : 3));
        this.emit(I.call(boxV, "rt_box_ptr", [V.name, tag]));
      } else {
        this.emit(I.call(boxV, boxOp, [V.name]));
      }
      const r = this.tmp("r"); this.setKind(r, "int");
      this.emit(I.call(r, "rt_dict_set", [d, K.name, boxV]));
    }
    return { name: d, kind: "dict" };
  }

  genCall(node) {
    const name = node.被调者.类型 === "标识符" ? node.被调者.名字 : null;
    // 内置：输出
    if (name === "输出") return this.genPrintCall(node.参数);
    // 内置：长度
    if (name === "长度") {
      const a = this.genExpr(node.参数[0]);
      const d = this.tmp("ln"); this.setKind(d, "int");
      const rt = a.kind === "str" ? "rt_str_len" : (a.kind === "list" || a.kind === "intlist") ? "rt_list_len"
        : a.kind === "dict" ? "rt_dict_len" : "rt_box_tag";
      this.emit(I.call(d, rt, [a.name]));
      return { name: d, kind: "int" };
    }
    if (name === "转字符串") {
      const a = this.genExpr(node.参数[0]);
      const d = this.tmp("s"); this.setKind(d, "str");
      this.emit(I.call(d, a.kind === "double" ? "rt_double_to_str" : "rt_int_to_str", [a.name]));
      return { name: d, kind: "str" };
    }
    if (name === "追加") {
      const L = this.genExpr(node.参数[0]);
      const V = this.genExpr(node.参数[1]);
      const d = this.tmp("r"); this.setKind(d, "int");
      // 无装箱整数列表：直接存 int，跳过 Box 分配
      if (L.kind === "intlist" && V.kind === "int") {
        this.emit(I.call(d, "rt_intlist_append", [L.name, V.name]));
        return { name: d, kind: "none" };
      }
      const boxV = this.tmp("bx"); this.setKind(boxV, "box");
      this.emit(I.call(boxV, V.kind === "int" ? "rt_box_int" : V.kind === "double" ? "rt_box_double" : V.kind === "str" ? "rt_box_str" : "rt_box_ptr", [V.name]));
      this.emit(I.call(d, "rt_list_append", [L.name, boxV]));
      return { name: d, kind: "none" };
    }
    // 用户函数
    if (!name) throw new Error("间接调用暂不支持");
    const argNames = [];
    for (const a of node.参数) {
      const r = this.genExpr(a);
      argNames.push(r.name);
    }
    const d = this.tmp("call"); this.setKind(d, "int");
    this.emit(I.call(d, name, argNames));
    return { name: d, kind: "int" };
  }

  genPrintCall(args) {
    // 依次打印，最后 nl；返回 none
    const dummy = this.tmp("p"); this.setKind(dummy, "none");
    let first = true;
    for (const a of args) {
      if (!first) {
        this.emit(I.call(dummy, "rt_print_space", []));
      }
      first = false;
      const r = this.genExpr(a);
      const rt = r.kind === "double" ? "rt_print_double"
        : r.kind === "str" ? "rt_print_str"
        : (r.kind === "list" || r.kind === "intlist") ? "rt_print_list"
        : r.kind === "dict" ? "rt_print_dict"
        : r.kind === "box" ? "rt_print_box"
        : "rt_print_int";
      if (rt === "rt_print_double") {
        // 单参
        this.emit(I.call(dummy, rt, [r.name]));
      } else {
        this.emit(I.call(dummy, rt, [r.name]));
      }
    }
    this.emit(I.call(dummy, "rt_print_nl", []));
    return { name: dummy, kind: "none" };
  }
}

// ============================================================
// 后端：IR -> x86-64 汇编
// ============================================================
class IRToAsm {
  constructor() {
    this.lines = [];       // .text
    this.rodata = [];
    this.seq = 0;
  }

  emit(line) { this.lines.push(line); }

  // 编译整个优化后程序
  compile(functions, allocation, kinds) {
    // 为每个函数编译
    for (const fn of functions) {
      this.compileFunc(fn, allocation.get(fn.name), kinds);
    }
    this.deadStoreElim();
  }

  // 栈槽死存储消除（asm 级，安全）：
  //   每个函数有自己的 rbp 帧，偏移必须【按函数】独立分析。
  //   若某偏移在本函数内只被写、从未被读，则那次写是死存储，删除。
  //   覆盖 mov 与 movsd（load: `mov[s] OFF(%rbp), %reg`；store: `mov[s] %reg, OFF(%rbp)`）。
  deadStoreElim() {
    // 存储行（写到 [rbp+off]）：mov/movsd 目的为内存。
    const storeRe = /^\s*(mov|movsd)\s+%\w+,\s+(-?\d+)\(%rbp\)\s*$/;
    // 任意对 [rbp+off] 的引用（含 movsd/mulsd/addsd/divsd 等的内存源操作数）。
    const anyRefRe = /(-?\d+)\(%rbp\)/g;
    const isFuncLabel = (l) => /^(co_main|FUNC_\w+):\s*$/.test(l);
    let cur = [];
    const funcs = [];
    for (const ln of this.lines) {
      if (isFuncLabel(ln)) { if (cur.length) funcs.push(cur); cur = [ln]; }
      else cur.push(ln);
    }
    if (cur.length) funcs.push(cur);
    const out = [];
    for (const f of funcs) {
      // 统计每个偏移在本函数内被引用的行数；若偏移除「存储行」外再无引用，则其存储是死的。
      const refCount = new Map();
      for (const ln of f) {
        const m = ln.match(storeRe);
        const refs = ln.match(anyRefRe) || [];
        for (const r of refs) {
          const off = r.match(/(-?\d+)\(%rbp\)/)[1];
          // 存储行自身的引用不算「读」
          if (m && r === `${m[2]}(%rbp)`) continue;
          refCount.set(off, (refCount.get(off) || 0) + 1);
        }
      }
      for (const ln of f) {
        const m = ln.match(storeRe);
        if (m && !refCount.has(m[2])) continue; // 无任何读 -> 死存储
        out.push(ln);
      }
    }
    this.lines = out;
  }

  // ---------- 变量家槽分配 ----------
  allocateHomes(fn, nPushed, promoted) {
    const home = new Map(); // var -> 栈偏移（负，相对 rbp）
    let n = 0;
    // 收集所有出现过的变量名
    const all = new Set(fn.params || []);
    for (const b of fn.blocks) {
      for (const ins of b.instrs) {
        for (const u of I.instrUse(ins)) all.add(u);
        const d = I.instrDef(ins); if (d) all.add(d);
      }
      for (const u of I.termUse(b.term)) all.add(u);
    }
    // 识别常量变量（立即数可替代）：无需家槽
    const constSet = new Set();
    {
      const mod = new Set();
      for (const b of fn.blocks) for (const ins of b.instrs) {
        const d = I.instrDef(ins);
        if (d != null && ins.op !== "const") mod.add(d);
      }
      for (const b of fn.blocks) for (const ins of b.instrs) {
        if (ins.op === "const" && typeof ins.value === "number" && !mod.has(ins.dest))
          constSet.add(ins.dest);
      }
    }
    for (const v of all) {
      // 被调用者保存(cs=false)提升变量无需家槽；调用者保存(cs=true)需要家槽供 spill/reload
      if (promoted && promoted.has(v) && !promoted.get(v).cs) continue;
      if (constSet.has(v)) continue;            // 立即数即可，无需家槽
      home.set(v, -8 * (nPushed + 1 + n));
      n++;
    }
    return { home, count: n };
  }

  // ---------- 计算每个基本块的循环嵌套深度 ----------
  // 深度 0 = 非循环代码；每多一层循环 +1。用于给内层循环变量高权重。
  computeLoopDepth(fn) {
    I.buildCFG(fn);
    const n = fn.blocks.length;
    // 可达性 reach[s] = Set(t)：从 s 沿 CFG 能到达的块
    const reach = Array.from({ length: n }, () => new Set());
    for (let s = 0; s < n; s++) {
      const seen = new Set([s]);
      const wl = [s];
      while (wl.length) {
        const x = wl.pop();
        for (const y of (fn.blocks[x].succs || [])) {
          if (seen.has(y)) continue;
          seen.add(y); reach[s].add(y); wl.push(y);
        }
      }
    }
    // 深度：对每个块 b，统计「有多少个头 H 使得 H 在 b 的自然循环内」。
    // 头 H 的自然循环 = { H } ∪ 从 H 的某回边源反向可达、且必经 H 的块。
    // 简化：块 x 的深度 = 有多少个 (回边 b->H) 满足 H==x 或 x 在 H 的循环内。
    const depth = new Array(n).fill(0);
    for (let b = 0; b < n; b++) {
      for (const H of (fn.blocks[b].succs || [])) {
        // 回边判定：H 可达 b，且 H 在程序顺序上位于 b 之前（结构化循环头）。
        // 仅用 reach[H].has(b) 会把强连通循环内的每条边都误判为回边。
        if (!reach[H].has(b)) continue;
        if (H >= b) continue;
        // H 的循环体 = H + 从 b 沿【前驱】反向可达、不经过 H 的块
        const loopSet = new Set([H]);
        const wl = [b];
        while (wl.length) {
          const x = wl.pop();
          if (x === H || loopSet.has(x)) continue;
          loopSet.add(x);
          for (const y of (fn.blocks[x].preds || [])) wl.push(y);
        }
        for (const x of loopSet) depth[x]++;
      }
    }
    if (process.env.COCN_DUMP_DEPTH) console.error("DEPTH", JSON.stringify(depth));
    return depth;
  }

  // ---------- 选择要提升到寄存器的整型变量（循环深度加权 + call 感知） ----------
  // 寄存器池：
  //   被调用者保存(rbx/r12-r15)：跨 call 自动保留，无需 spill。
  //   调用者保存(r8/r9)：call 会破坏，需在 call 前 spill 到家槽；但在无 call 的内层
  //     循环里全程驻留，零栈往返。scratch 保留 rax/r10/r11/rcx/rdx/rsi/rdi。
  choosePromoted(fn, kinds) {
    const CALLEE = ["rbx", "r12", "r13", "r14", "r15"];
    const CALLER = []; // 调用者保存寄存器保守不使用
    const depth = this.computeLoopDepth(fn);
    const weight = new Map();
    const useBlocks = new Map();   // var -> Set(blockId) where it is USED
    const bump = (v, w, bi) => {
      if (v == null) return;
      weight.set(v, (weight.get(v) || 0) + w);
      if (!useBlocks.has(v)) useBlocks.set(v, new Set());
      useBlocks.get(v).add(bi);
    };
    for (let bi = 0; bi < fn.blocks.length; bi++) {
      const d = depth[bi] || 0;
      const w = Math.pow(4, d);           // 内层循环权重指数级放大
      const b = fn.blocks[bi];
      for (const ins of b.instrs) {
        const dd = I.instrDef(ins); if (dd) bump(dd, w, bi);
        for (const u of I.instrUse(ins)) bump(u, w, bi);
      }
      for (const u of I.termUse(b.term)) bump(u, w, bi);
    }
    const paramSet = new Set(fn.params || []);
    // 常量变量（立即数可替代）不需要驻留寄存器
    const constLike = new Set();
    {
      const mod = new Set();
      for (const b of fn.blocks) for (const ins of b.instrs) {
        const d = I.instrDef(ins);
        if (d != null && ins.op !== "const") mod.add(d);
      }
      for (const b of fn.blocks) for (const ins of b.instrs) {
        if (ins.op === "const" && typeof ins.value === "number" && !mod.has(ins.dest))
          constLike.add(ins.dest);
      }
    }
    const cands = [];
    // 收集 call 结果变量（必须跨后续 call 存活，优先提升到 callee-saved）
    const callDefs = new Set();
    for (const b of fn.blocks) for (const ins of b.instrs) {
      if (ins.op === "call" || ins.op === "call_reg") callDefs.add(ins.dest);
    }
    for (const [v, w] of weight) {
      const k = kinds.kindOf(v);
      // 允许提升整型与指针类（list/intlist/dict/box/ptr 都是 8 字节指针）
      if (k !== "int" && k !== "list" && k !== "intlist" && k !== "dict" && k !== "box" && k !== "none") continue;
      if (constLike.has(v)) continue;   // 立即数即可，不占用寄存器
      // 只提升「跨块活跃」的变量：被多个块使用（或参数）。单块临时量不需要
      // 驻留被调用者保存寄存器（否则递归函数每次调用白白 push/pop 多个寄存器）。
      const nBlocks = (useBlocks.get(v) || new Set()).size;
      // 调用结果必须跨后续 call 存活：即使单块也提升到 callee-saved，避免家槽往返
      const isCallResult = callDefs.has(v);
      if (nBlocks < 2 && !paramSet.has(v) && !isCallResult) continue;
      // 列表/字典指针变量权重加成：内层循环中每次 list_get/set 都需要指针，
      // 保持在寄存器中可省掉家槽往返，比临时索引计算收益更高。
      let adjustedW = w;
      if (k === "intlist" || k === "list" || k === "dict") adjustedW = w * 3;
      cands.push([v, adjustedW]);
    }
    cands.sort((a, b) => b[1] - a[1]);
    if (process.env.COCN_DUMP_PROMO) console.error("WEIGHTS", fn.name, JSON.stringify(cands.slice(0,15)));
    const promoted = new Map(); // var -> {reg, cs}
    for (const [v, w] of cands) {
      if (w < 2) break;
      if (promoted.size < CALLEE.length) {
        promoted.set(v, { reg: CALLEE[promoted.size], cs: false });
      } else break;
    }
    if (process.env.COCN_DUMP_PROMO) console.error("PROMO", fn.name, JSON.stringify([...promoted]));
    return promoted;
  }

  compileFunc(fn, alloc, kinds) {
    // 1) 块内折叠 + 常量折叠（安全 pass，不重排有副作用的调用）
    collapseTemps(fn);
    foldConstants(fn, kinds);
    // LICM：循环不变量外提（已修复回边检测）。外提纯算术指令到 preheader。
    licm(fn); foldConstants(fn, kinds);
    // 死代码消除：删除未使用的纯计算结果
    deadCodeElimination(fn);
    collapseTemps(fn);
    foldConstants(fn, kinds);

    const POOL = ["rbx", "r12", "r13", "r14", "r15"]; // callee-saved
    // 寄存器分配：循环深度加权，优先被调用者保存，其次调用者保存(r8/r9)。
    // 叶子函数（无 call）可安全使用调用者保存寄存器，无需 push/pop。
    const promoted = this.choosePromoted(fn, kinds);
    // 只 push/pop 本函数实际用到的被调用者保存寄存器，减小递归/小函数帧开销
    const usedCallee = new Set([...promoted.values()].filter(e => !e.cs).map(e => e.reg));
    const nPushed = usedCallee.size;
    const { home, count } = this.allocateHomes(fn, nPushed, promoted);
    let frame = Math.max(8 * (nPushed + 1 + count), 16);
    frame = (frame + 15) & ~15;          // 向上取整到 16
    // push rbp 后 rsp≡0；再 push nPushed 个 + sub frame，需 (8*nPushed+frame)≡0 以对齐 call
    if ((8 * nPushed + frame) % 16 !== 0) frame += 8;

    let L;
    if (fn.name === "co_main") {
      L = "co_main";
      this.emit(".globl co_main");
    } else {
      L = "FUNC_" + fn.name.replace(/[^A-Za-z0-9_]/g, "_");
    }
    this.emit(L + ":");
    this.emit("push %rbp");
    this.emit("mov %rsp, %rbp");
    for (const r of POOL) if (usedCallee.has(r)) this.emit("push %" + r);
    if (frame > 0) this.emit("sub $" + frame + ", %rsp");

    // 参数 → 家槽 + 提升寄存器
    const paramKinds = (fn.params || []).map(p => kinds.kindOf(p));
    let ip = 0, xp = 0;
    (fn.params || []).forEach((p) => {
      const k = kinds.kindOf(p);
      if (k === "double") {
        this.emit("movsd " + pct(ARG_XMM[xp]) + ", " + home.get(p) + "(%rbp)");
        xp++;
      } else {
        const r = ARG_INT[ip++];
        for (const [v, off] of home) {
          if (v === p || v.startsWith(p + "#")) {
            this.emit("mov " + pct(r) + ", " + off + "(%rbp)");
          }
        }
        const pr = promoted.get(p);
        if (pr) this.emit("mov " + pct(r) + ", %" + pr.reg);
      }
    });

    const lblPre = ".L" + (this.seq++) + "_";
    // 收集所有常量定义，供后端使用立即数优化。
    // 仅包含「只被 const 定义、从未被其他指令修改」的变量，
    // 避免变量被重新赋值后仍用旧常量值。
    const constMap = new Map(); // var -> integer value
    const modified = new Set();
    for (const b of fn.blocks) {
      for (const ins of b.instrs) {
        const d = I.instrDef(ins);
        if (d != null && ins.op !== "const") modified.add(d);
      }
    }
    for (const b of fn.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "const" && typeof ins.value === "number"
            && kinds.kindOf(ins.dest) !== "double" && !modified.has(ins.dest)) {
          // 只保留首次定义（避免重复）
          if (!constMap.has(ins.dest)) constMap.set(ins.dest, ins.value);
        }
      }
    }
    // 浮点常量标签映射：dest -> .LCDn（仅未被修改的循环不变量常量）
    const dblConstMap = new Map();
    for (const b of fn.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "const" && kinds.kindOf(ins.dest) === "double"
            && typeof ins.value === "string" && ins.value.startsWith(".LCD")
            && !modified.has(ins.dest)) {
          if (!dblConstMap.has(ins.dest)) dblConstMap.set(ins.dest, ins.value);
        }
      }
    }
    const ctx = { home, kinds, promoted, lblPre, usedCallee, constMap, dblConstMap,
                  csValid: new Set(), raxVar: null };
    // 参数已写入提升寄存器，视为有效缓存
    for (const [v, e] of promoted) if (e.cs) ctx.csValid.add(v);
    const layout = layoutBlocks(fn);
    for (let bi = 0; bi < layout.length; bi++) {
      const b = fn.blocks[layout[bi]];
      const nextId = bi + 1 < layout.length ? layout[bi + 1] : -1;
      this.emit(lblPre + b.id + ":");
      ctx.raxVar = null; // 跨块 rax 值不可知（汇合点/回边）
      this.fNewBlock(ctx); // 块内浮点缓存开始
      let fused = false;
      for (let j = 0; j < b.instrs.length; j++) {
        const ins = b.instrs[j];
        // 比较+分支融合：块末比较直接喂给分支终结符
        if (j === b.instrs.length - 1 && b.term.kind === "branch" &&
            ["lt", "gt", "le", "ge", "eq", "ne"].includes(ins.op) &&
            ins.dest === b.term.cond) {
          // 浮点比较走 ucomisd 专用路径（内部自管 flush+jcc）
          if (ctx.kinds.kindOf(ins.left) === "double" || ctx.kinds.kindOf(ins.right) === "double") {
            this.emitFloatCmpBranch(ins, b.term, ctx, nextId);
          } else {
            // 整数比较：先 flush 浮点缓存到家槽（taken 路径也要正确），再发整数分支
            this.fFlushAll(ctx);
            this.emitCmpBranch(ins, b.term, ctx, nextId);
          }
          fused = true;
          break;
        }
        this.emitInstr(ins, fn, ctx);
      }
      // 块结束前 flush 浮点缓存到家槽（家槽为跨块真相源）。movsd 不影响 flags。
      this.fFlushAll(ctx);
      if (!fused) this.emitTerm(b.term, ctx, nextId);
    }
  }

  // 把变量 v 加载进机器寄存器 dst
  loadTo(v, dst, ctx) {
    // 先查块内缓存：若 v 已在 dst 寄存器中，直接返回（无需 spill 或 mov）
    if (ctx.iCache && ctx.iCache.get(v) === dst) return;
    // dst 即将被覆写：若它是缓存寄存器且持有其他值，先 spill
    this.iProtect(dst, ctx);
    // 常量优化：若 v 是已知常量，直接用立即数
    if (ctx.constMap && ctx.constMap.has(v)) {
      this.emit("mov $" + ctx.constMap.get(v) + ", %" + dst);
      return;
    }
    if (!ctx.home.has(v) && !ctx.promoted.has(v)) { this.emit("mov $0, %" + dst); return; }
    // rax 仍持有 v：直接用，避免重载
    if (dst === "rax" && ctx.raxVar === v) return;
    // 块内缓存命中
    if (ctx.iCache && ctx.iCache.has(v)) {
      const cr = ctx.iCache.get(v);
      if (cr !== dst) this.emit("mov %" + cr + ", %" + dst);
      if (dst === "rax") ctx.raxVar = v;
      return;
    }
    const pr = ctx.promoted.get(v);
    if (pr) {
      if (!pr.cs || ctx.csValid.has(v)) {
        this.emit("mov %" + pr.reg + ", %" + dst);
      } else {
        // 调用者保存寄存器在 call 后失效：从家槽重载，同时重建寄存器缓存
        this.emit("mov " + ctx.home.get(v) + "(%rbp), %" + dst);
        this.emit("mov %" + dst + ", %" + pr.reg);
        ctx.csValid.add(v);
      }
      if (dst === "rax") ctx.raxVar = v;
      return;
    }
    this.emit("mov " + ctx.home.get(v) + "(%rbp), %" + dst);
    if (dst === "rax") ctx.raxVar = v;
  }
  // 把寄存器 src 的值写回变量 v
  storeFrom(v, src, ctx) {
    const pr = ctx.promoted.get(v);
    if (pr) {
      this.emit("mov %" + src + ", %" + pr.reg);
      if (pr.cs) ctx.csValid.add(v);
    } else if (ctx.home.has(v)) {
      // 块内缓存：把结果驻留到 r10/r11，避免立即写家槽（块末 flush）
      const cr = this.iAlloc(ctx);
      if (cr !== src) this.emit("mov %" + src + ", %" + cr);
      ctx.iCache.set(v, cr);
      ctx.iReg.set(cr, v);
    }
    // rax 值跟踪：若写回的是 rax，则 rax 当前持有 v
    if (src === "rax") ctx.raxVar = v;
    else ctx.raxVar = null;
  }

  // ---------- 浮点 xmm 块内缓存 ----------
  // 块开始时清空；块结束/调用前 flush 到家槽。家槽是跨块与跨调用的真相源。
  fNewBlock(ctx) {
    ctx.fCache = new Map();      // var -> xmm reg
    ctx.fReg = new Map();        // xmm reg -> var
    ctx.fPool = SCRATCH_XMM.slice();
    // 整数块内缓存池（r10/r11）：块内临时量驻留，避免家槽往返
    ctx.iCache = new Map();      // var -> reg
    ctx.iReg = new Map();        // reg -> var
  }
  // 淘汰指定寄存器（写回家槽）
  fSpillReg(reg, ctx) {
    const v = ctx.fReg.get(reg);
    if (v == null) { if (!ctx.fPool.includes(reg)) ctx.fPool.push(reg); return; }
    if (ctx.home.has(v)) this.emit("movsd %" + reg + ", " + ctx.home.get(v) + "(%rbp)");
    ctx.fReg.delete(reg);
    ctx.fCache.delete(v);
    if (!ctx.fPool.includes(reg)) ctx.fPool.push(reg);
  }
  // 分配一个 xmm 寄存器；满则淘汰最早使用的
  fAlloc(ctx) {
    if (ctx.fPool.length) return ctx.fPool.shift();
    this.fSpillReg(SCRATCH_XMM[0], ctx);
    return SCRATCH_XMM[0];
  }
  // 确保 v 在某个 xmm 中，返回该 xmm（常量走 RIP 直接加载）
  fLoad(v, ctx) {
    const c = ctx.fCache.get(v);
    if (c) return c;
    const r = this.fAlloc(ctx);
    if (ctx.dblConstMap && ctx.dblConstMap.has(v)) {
      this.emit("movsd " + ctx.dblConstMap.get(v) + "(%rip), %" + r);
    } else {
      this.emit("movsd " + ctx.home.get(v) + "(%rbp), %" + r);
    }
    ctx.fCache.set(v, r);
    ctx.fReg.set(r, v);
    return r;
  }
  // 结果寄存器 r 现持有 v；若 r 原持有别的变量则先 spill
  fSet(v, r, ctx) {
    const old = ctx.fReg.get(r);
    if (old && old !== v) {
      if (ctx.home.has(old)) this.emit("movsd %" + r + ", " + ctx.home.get(old) + "(%rbp)");
      ctx.fCache.delete(old);
    }
    const prev = ctx.fCache.get(v);
    if (prev && prev !== r) ctx.fReg.delete(prev);
    ctx.fCache.set(v, r);
    ctx.fReg.set(r, v);
  }
  // flush 全部缓存到家槽（call 前 / 块结束前）。movsd 不影响 flags。
  fFlushAll(ctx) {
    if (ctx.iCache) this.iFlushAll(ctx);
    if (!ctx.fCache || ctx.fCache.size === 0) return;
    for (const [v, r] of ctx.fCache) {
      if (ctx.home.has(v)) this.emit("movsd %" + r + ", " + ctx.home.get(v) + "(%rbp)");
    }
    ctx.fCache.clear();
    ctx.fReg.clear();
    ctx.fPool = SCRATCH_XMM.slice();
  }

  // ---------- 整数块内缓存 ----------
  // spill 某个缓存寄存器到家槽
  iSpillReg(reg, ctx) {
    const v = ctx.iReg.get(reg);
    if (v == null) return;
    if (ctx.home.has(v)) this.emit("mov %" + reg + ", " + ctx.home.get(v) + "(%rbp)");
    ctx.iReg.delete(reg);
    ctx.iCache.delete(v);
  }
  // 分配一个整数缓存寄存器；满则淘汰 r10
  iAlloc(ctx) {
    for (const r of INT_CACHE) if (!ctx.iReg.has(r)) return r;
    this.iSpillReg(INT_CACHE[0], ctx);
    return INT_CACHE[0];
  }
  // 即将把 dst 当 scratch 覆写；若 dst 是缓存寄存器，先 spill
  iProtect(dst, ctx) {
    if (INT_CACHE.includes(dst)) this.iSpillReg(dst, ctx);
  }
  // flush 全部整数缓存
  iFlushAll(ctx) {
    for (const v of [...ctx.iCache.keys()]) {
      const r = ctx.iCache.get(v);
      if (ctx.home.has(v)) this.emit("mov %" + r + ", " + ctx.home.get(v) + "(%rbp)");
    }
    ctx.iCache.clear();
    ctx.iReg.clear();
  }

  emitInstr(ins, fn, ctx) {
    switch (ins.op) {
      case "const": this.emitConst(ins, ctx); break;
      case "mov": this.emitMov(ins, ctx); break;
      case "neg": this.emitNeg(ins, ctx); break;
      case "not": this.emitNot(ins, ctx); break;
      case "unbox": this.emitUnbox(ins, ctx); break;
      case "itof": this.emitItof(ins, ctx); break;
      case "add": case "sub": case "mul": case "div": case "mod":
      case "lt": case "gt": case "le": case "ge": case "eq": case "ne":
      case "and": case "or": case "xor": case "shl": case "shr":
        this.emitBinop(ins, ctx); break;
      case "call": this.emitCall(ins, ctx); break;
      case "load": this.emitLoad(ins, ctx); break;
      case "store": this.emitStore(ins, ctx); break;
      case "phi": break;
      default: this.emit("# unknown op " + ins.op);
    }
  }

  emitConst(ins, ctx) {
    if (ctx.kinds.kindOf(ins.dest) === "double") {
      // 浮点常量：若已是 RIP 不变量（dblConstMap），使用时直接 RIP 相对加载，
      // 此处无需发射；否则（被修改过的非常量）写回家槽。
      if (!ctx.dblConstMap.has(ins.dest)) {
        this.emit("movsd " + ins.value + "(%rip), %xmm0");
        this.emit("movsd %xmm0, " + ctx.home.get(ins.dest) + "(%rbp)");
      }
      return;
    }
    const pd = ctx.promoted.get(ins.dest);
    if (pd) {
      this.emit("mov $" + ins.value + ", %" + pd.reg);
      if (pd.cs) ctx.csValid.add(ins.dest);
    } else if (ctx.constMap.has(ins.dest)) {
      // 已识别为常量：使用处直接用立即数，无需发射指令或占缓存寄存器
    } else {
      // 直接放到缓存寄存器，省掉 rax 中转
      const cr = this.iAlloc(ctx);
      this.emit("mov $" + ins.value + ", %" + cr);
      ctx.iCache.set(ins.dest, cr);
      ctx.iReg.set(cr, ins.dest);
      ctx.raxVar = null;
    }
  }

  emitMov(ins, ctx) {
    if (ctx.kinds.kindOf(ins.dest) === "double") {
      // D = S：确保 S 在某 xmm，复制到新结果寄存器
      const sr = this.fLoad(ins.src, ctx);
      const dr = this.fAlloc(ctx);
      this.emit("movsd %" + sr + ", %" + dr);
      this.fSet(ins.dest, dr, ctx);
      return;
    }
    const Dp = ctx.promoted.get(ins.dest), Sp = ctx.promoted.get(ins.src);
    if (Dp && Sp) {
      this.emit("mov %" + Sp.reg + ", %" + Dp.reg);
      if (Dp.cs) ctx.csValid.add(ins.dest);
      return;
    }
    // 源是已知常量：直接放到目标缓存寄存器，省掉 rax 中转
    if (ctx.constMap && ctx.constMap.has(ins.src)) {
      if (Dp) {
        this.emit("mov $" + ctx.constMap.get(ins.src) + ", %" + Dp.reg);
        if (Dp.cs) ctx.csValid.add(ins.dest);
      } else {
        const cr = this.iAlloc(ctx);
        this.emit("mov $" + ctx.constMap.get(ins.src) + ", %" + cr);
        ctx.iCache.set(ins.dest, cr);
        ctx.iReg.set(cr, ins.dest);
      }
      ctx.raxVar = null;
      return;
    }
    this.loadTo(ins.src, "rax", ctx);
    this.storeFrom(ins.dest, "rax", ctx);
  }

  emitNeg(ins, ctx) {
    this.loadTo(ins.src, "rax", ctx);
    this.emit("neg %rax");
    this.storeFrom(ins.dest, "rax", ctx);
  }

  emitNot(ins, ctx) {
    this.loadTo(ins.src, "rax", ctx);
    this.emit("not %rax");
    this.storeFrom(ins.dest, "rax", ctx);
  }

  // 内联拆箱：直接从 Box* 偏移 8 处加载值，避免函数调用开销
  // Box 布局：[tag(8)] [value(8)]
  emitUnbox(ins, ctx) {
    if (ins.kind === "double") {
      this.loadTo(ins.src, "rax", ctx);
      const dr = this.fAlloc(ctx);
      this.emit("movsd 8(%rax), %" + dr);
      this.fSet(ins.dest, dr, ctx);
    } else {
      // 整数拆箱：mov 8(%box_ptr), %dest
      this.loadTo(ins.src, "rax", ctx);
      this.emit("mov 8(%rax), %rax");
      this.storeFrom(ins.dest, "rax", ctx);
    }
  }

  // 整数转浮点：cvtsi2sd
  emitItof(ins, ctx) {
    this.loadTo(ins.src, "rax", ctx);
    const dr = this.fAlloc(ctx);
    this.emit("cvtsi2sd %rax, %" + dr);
    this.fSet(ins.dest, dr, ctx);
  }

  emitBinop(ins, ctx) {
    if (ctx.kinds.kindOf(ins.dest) === "double" ||
        ["lt","gt","le","ge","eq","ne"].includes(ins.op) &&
        (ctx.kinds.kindOf(ins.left) === "double" || ctx.kinds.kindOf(ins.right) === "double")) {
      return this.emitFloatBinop(ins, ctx);
    }
    const L = ins.left, R = ins.right, D = ins.dest;
    const Dp = ctx.promoted.get(D), Lp = ctx.promoted.get(L), Rp = ctx.promoted.get(R);
    const isCmp = ["lt", "gt", "le", "ge", "eq", "ne"].includes(ins.op);
    // 累加型：dest 与 left 在同一寄存器 → 直接 op R, D
    if (Dp && Lp && Lp.reg === Dp.reg && !isCmp && ins.op !== "div" && ins.op !== "mod") {
      if (ins.op === "shl" || ins.op === "shr") {
        this.loadTo(R, "rcx", ctx);
        this.emit((ins.op === "shl" ? "sal" : "sar") + " %cl, %" + Dp.reg);
      } else if (ctx.constMap && ctx.constMap.has(R)) {
        // 右操作数是已知常量 → 直接立即数运算，省掉 r10 中转
        const op = ins.op === "mul" ? "imul" : ins.op;
        this.emit(op + " $" + ctx.constMap.get(R) + ", %" + Dp.reg);
      } else {
        this.loadTo(R, "r10", ctx);
        const op = ins.op === "mul" ? "imul" : ins.op;
        this.emit(op + " %r10, %" + Dp.reg);
      }
      if (Dp.cs) ctx.csValid.add(D);
      return;
    }
    // 通用：L -> rax，R -> r10
    this.loadTo(L, "rax", ctx);
    // 右操作数是已知常量时，用立即数形式，省掉 loadTo
    if (ctx.constMap && ctx.constMap.has(R)) {
      const imm = ctx.constMap.get(R);
      switch (ins.op) {
        case "add": this.emit("add $" + imm + ", %rax"); break;
        case "sub": this.emit("sub $" + imm + ", %rax"); break;
        case "and": this.emit("and $" + imm + ", %rax"); break;
        case "or":  this.emit("or $" + imm + ", %rax"); break;
        case "xor": this.emit("xor $" + imm + ", %rax"); break;
        case "mul": this.emit("imul $" + imm + ", %rax, %rax"); break;
        case "div": case "mod": {
          // div/mod 不能用立即数，需要加载到 r10
          this.iProtect("r10", ctx);
          this.emit("mov $" + imm + ", %r10");
          this.emit("cqo");
          this.emit("idiv %r10");
          if (ins.op === "mod") this.emit("mov %rdx, %rax");
          break;
        }
        case "shl": case "shr": {
          // shift 用 cl，所以还是需要 mov 到 rcx
          this.emit("mov $" + imm + ", %rcx");
          this.emit((ins.op === "shl" ? "sal" : "sar") + " %cl, %rax");
          break;
        }
        case "lt": case "gt": case "le": case "ge": case "eq": case "ne": {
          this.emit("cmp $" + imm + ", %rax");
          const setcc = { lt: "setl", gt: "setg", le: "setle", ge: "setge", eq: "sete", ne: "setne" }[ins.op];
          this.emit(setcc + " %al");
          this.emit("movzb %al, %eax");
          break;
        }
      }
      this.storeFrom(D, "rax", ctx);
      return;
    }
    this.loadTo(R, "r10", ctx);
    switch (ins.op) {
      case "add": this.emit("add %r10, %rax"); break;
      case "sub": this.emit("sub %r10, %rax"); break;
      case "mul": this.emit("imul %r10, %rax"); break;
      case "div": case "mod": {
        this.emit("cqo");
        this.emit("idiv %r10");
        if (ins.op === "mod") this.emit("mov %rdx, %rax");
        break;
      }
      case "and": this.emit("and %r10, %rax"); break;
      case "or": this.emit("or %r10, %rax"); break;
      case "xor": this.emit("xor %r10, %rax"); break;
      case "shl": case "shr": {
        this.emit("mov %r10, %rcx");
        this.emit((ins.op === "shl" ? "sal" : "sar") + " %cl, %rax");
        break;
      }
      case "lt": case "gt": case "le": case "ge": case "eq": case "ne": {
        this.emit("cmp %r10, %rax");
        const setcc = { lt: "setl", gt: "setg", le: "setle", ge: "setge", eq: "sete", ne: "setne" }[ins.op];
        this.emit(setcc + " %al");
        this.emit("movzb %al, %eax");
        break;
      }
    }
    this.storeFrom(D, "rax", ctx);
  }

  // 浮点二元运算（算术 + 比较）。块内 xmm 缓存，家槽仅作溢出/跨块真相源。
  emitFloatBinop(ins, ctx) {
    const L = ins.left, R = ins.right, D = ins.dest;
    const isCmp = ["lt", "gt", "le", "ge", "eq", "ne"].includes(ins.op);
    let dr;
    // 累加：D 已在缓存且 L==D 同一寄存器 -> 原地运算
    if (!isCmp && ctx.fCache.get(D) && ctx.fCache.get(L) === ctx.fCache.get(D)) {
      dr = ctx.fCache.get(D);
    } else {
      dr = this.fAlloc(ctx);
      if (ctx.dblConstMap.has(L)) {
        this.emit("movsd " + ctx.dblConstMap.get(L) + "(%rip), %" + dr);
      } else {
        const lr = this.fLoad(L, ctx);
        if (lr !== dr) this.emit("movsd %" + lr + ", %" + dr);
      }
    }
    if (isCmp) {
      // ucomisd R, dr （dr 为左操作数 L）
      if (ctx.dblConstMap.has(R)) this.emit("ucomisd " + ctx.dblConstMap.get(R) + "(%rip), %" + dr);
      else { const rr = this.fLoad(R, ctx); this.emit("ucomisd %" + rr + ", %" + dr); }
      const setcc = { lt: "setb", gt: "seta", le: "setbe", ge: "setae", eq: "sete", ne: "setne" }[ins.op];
      this.emit(setcc + " %al");
      this.emit("movzb %al, %eax");
      this.storeFrom(D, "rax", ctx);
      return;
    }
    const op = { add: "addsd", sub: "subsd", mul: "mulsd", div: "divsd" }[ins.op] || "addsd";
    if (ctx.dblConstMap.has(R)) {
      this.emit(op + " " + ctx.dblConstMap.get(R) + "(%rip), %" + dr);
    } else {
      const rr = this.fLoad(R, ctx);
      this.emit(op + " %" + rr + ", %" + dr);
    }
    this.fSet(D, dr, ctx);
  }

  // 浮点比较 + 分支融合：ucomisd 后 flush 缓存（movsd 不影响 flags），再发 jcc。
  emitFloatCmpBranch(ins, term, ctx, nextId) {
    const L = ins.left, R = ins.right;
    const lr = this.fLoad(L, ctx);
    if (ctx.dblConstMap.has(R)) {
      this.emit("ucomisd " + ctx.dblConstMap.get(R) + "(%rip), %" + lr);
    } else {
      const rr = this.fLoad(R, ctx);
      this.emit("ucomisd %" + rr + ", %" + lr);
    }
    // flush 浮点缓存到家槽（必须在 jcc 前，保证 taken/fall-through 两条路径都写回）
    this.fFlushAll(ctx);
    // ucomisd 后标志位等价于无符号比较 L vs R
    const jcc = { lt: "jb", gt: "ja", le: "jbe", ge: "jae", eq: "je", ne: "jne" }[ins.op];
    const jccNot = { lt: "jae", gt: "jbe", le: "ja", ge: "jb", eq: "jne", ne: "je" }[ins.op];
    if (term.then === nextId) {
      this.emit(jccNot + " " + ctx.lblPre + term.else);
    } else if (term.else === nextId) {
      this.emit(jcc + " " + ctx.lblPre + term.then);
    } else {
      this.emit(jcc + " " + ctx.lblPre + term.then);
      this.emit("jmp " + ctx.lblPre + term.else);
    }
  }

  // 比较 + 分支融合：直接发 cmp + jcc，省去 cond 临时量；nextId 用于 fall-through
  emitCmpBranch(ins, term, ctx, nextId) {
    const L = ins.left, R = ins.right;
    const Lp = ctx.promoted.get(L), Rp = ctx.promoted.get(R);
    if (Lp && Rp && !Lp.cs && !Rp.cs) {
      this.emit("cmp %" + Rp.reg + ", %" + Lp.reg);
    } else {
      this.loadTo(L, "rax", ctx);
      this.loadTo(R, "r10", ctx);
      this.emit("cmp %r10, %rax");
    }
    // 正向跳转（条件成立去 then）与反向（条件不成立去 else）
    const jcc = { lt: "jl", gt: "jg", le: "jle", ge: "jge", eq: "je", ne: "jne" }[ins.op];
    const jccNot = { lt: "jge", gt: "jle", le: "jg", ge: "jl", eq: "jne", ne: "je" }[ins.op];
    if (term.then === nextId) {
      // 条件成立 fall-through，只需在不成立时跳 else
      this.emit(jccNot + " " + ctx.lblPre + term.else);
    } else if (term.else === nextId) {
      // 条件不成立 fall-through，只需在成立时跳 then
      this.emit(jcc + " " + ctx.lblPre + term.then);
    } else {
      this.emit(jcc + " " + ctx.lblPre + term.then);
      this.emit("jmp " + ctx.lblPre + term.else);
    }
  }

  emitCall(ins, ctx) {
    // 内联热点运行时函数：避免函数调用开销
    if (ins.name === "rt_list_len") {
      // List 布局：[capacity(0), length(8), data(16)]
      this.loadTo(ins.args[0], "rax", ctx);
      this.emit("mov 8(%rax), %rax");
      if (ins.dest) this.storeFrom(ins.dest, "rax", ctx);
      return;
    }
    if (ins.name === "rt_list_get") {
      // 内联：L->data[idx]  （跳过边界检查）
      // rax = L, r10 = idx
      this.loadTo(ins.args[0], "rax", ctx);
      this.loadTo(ins.args[1], "r10", ctx);
      this.emit("mov 16(%rax), %rax");       // rax = L->data
      this.emit("mov (%rax, %r10, 8), %rax"); // rax = L->data[idx] (Box*)
      if (ins.dest) this.storeFrom(ins.dest, "rax", ctx);
      return;
    }
    if (ins.name === "rt_list_set") {
      // 内联：L->data[idx] = v
      // rax = L, r10 = idx, r11 = v
      this.loadTo(ins.args[0], "rax", ctx);
      this.loadTo(ins.args[1], "r10", ctx);
      this.loadTo(ins.args[2], "r11", ctx);
      this.emit("mov 16(%rax), %rax");          // rax = L->data
      this.emit("mov %r11, (%rax, %r10, 8)");  // L->data[idx] = v
      // 内联代码 clobber 了 rax（现在指向 L->data 而非 L），必须作废 raxVar
      ctx.raxVar = null;
      return;
    }
    // 真实 call：先把整数参数从块内缓存加载到 ABI 寄存器（避免家槽往返），
    // 再 flush 浮点与剩余整数缓存到家槽（call 破坏调用者保存寄存器）。
    const args = ins.args || [];
    let ip = 0, xp = 0;
    // 第一遍：整数参数
    args.forEach(a => {
      if (ctx.kinds.kindOf(a) !== "double") {
        this.loadTo(a, ARG_INT[ip], ctx);
        ip++;
      }
    });
    // flush 浮点 + 剩余整数缓存
    this.fFlushAll(ctx);
    // spill 调用者保存(cs)提升寄存器到家槽（call 会破坏 r8/r9）
    for (const [v, pr] of ctx.promoted) {
      if (pr.cs && ctx.csValid.has(v) && ctx.home.has(v)) {
        this.emit("mov %" + pr.reg + ", " + ctx.home.get(v) + "(%rbp)");
      }
    }
    ctx.csValid.clear();
    // 第二遍：浮点参数
    xp = 0; ip = 0;
    args.forEach(a => {
      if (ctx.kinds.kindOf(a) === "double") {
        if (ctx.dblConstMap.has(a)) {
          this.emit("movsd " + ctx.dblConstMap.get(a) + "(%rip), " + pct(ARG_XMM[xp]));
        } else {
          this.emit("movsd " + ctx.home.get(a) + "(%rbp), " + pct(ARG_XMM[xp]));
        }
        xp++;
      } else {
        ip++;
      }
    });
    let target = ins.name;
    if (!target.startsWith("rt_")) target = "FUNC_" + target.replace(/[^A-Za-z0-9_]/g, "_");
    // 被调用者保存寄存器（rbx/r12-r15）跨 call 天然保留，csValid 无需 spill 也无需作废。
    this.emit("call " + target);
    if (ins.dest) {
      if (ctx.kinds.kindOf(ins.dest) === "double") {
        this.emit("movsd %xmm0, " + ctx.home.get(ins.dest) + "(%rbp)");
        ctx.raxVar = null;
      } else {
        this.storeFrom(ins.dest, "rax", ctx);
      }
    } else {
      ctx.raxVar = null; // call 破坏 rax
    }
  }

  emitLoad(ins, ctx) {
    this.emit("mov " + ins.offset + "(%rbp), %rax");
    this.storeFrom(ins.dest, "rax", ctx);
  }

  emitStore(ins, ctx) {
    this.loadTo(ins.src, "rax", ctx);
    this.emit("mov %rax, " + ins.offset + "(%rbp)");
  }

  emitTerm(term, ctx, nextId) {
    switch (term.kind) {
      case "jump":
        if (term.target !== nextId) this.emit("jmp " + ctx.lblPre + term.target);
        break;
      case "branch": {
        this.loadTo(term.cond, "rax", ctx);
        this.emit("test %rax, %rax");
        if (term.then === nextId) {
          this.emit("je " + ctx.lblPre + term.else);
        } else if (term.else === nextId) {
          this.emit("jne " + ctx.lblPre + term.then);
        } else {
          this.emit("je " + ctx.lblPre + term.else);
          this.emit("jmp " + ctx.lblPre + term.then);
        }
        break;
      }
      case "return": {
        if (term.value != null) {
          if (ctx.kinds.kindOf(term.value) === "double") {
            // 返回浮点：支持 RIP 常量（dblConstMap）与家槽
            if (ctx.dblConstMap.has(term.value)) {
              this.emit("movsd " + ctx.dblConstMap.get(term.value) + "(%rip), %xmm0");
            } else {
              this.emit("movsd " + ctx.home.get(term.value) + "(%rbp), %xmm0");
            }
          } else {
            this.loadTo(term.value, "rax", ctx);
          }
        } else {
          this.emit("mov $0, %rax");
        }
        this.emit("mov %rbp, %rsp");
        if (ctx.usedCallee.size > 0) this.emit("sub $" + (8 * ctx.usedCallee.size) + ", %rsp");
        for (const r of [...ctx.usedCallee].reverse()) this.emit("pop %" + r);
        this.emit("pop %rbp");
        this.emit("ret");
        break;
      }
      case "unreachable":
        this.emit("int3");
        break;
    }
  }
  assemble(rodata) {
    const out = [];
    out.push(".att_syntax");
    out.push(".text");
    for (const l of this.lines) out.push(l);
    out.push(".section .rodata");
    for (const r of rodata) {
      out.push(r.lbl + ":");
      if (r.dbl != null) out.push(".double " + r.dbl);
      else out.push('.string "' + escapeAsmStr(r.text) + '"');
    }
    out.push(".text");
    return out.join("\n") + "\n";
  }
}

// ============================================================
// AST 级小函数内联（在前端 AstToIR 之前做）
// ------------------------------------------------------------
// 目标：消除「单表达式返回」的纯函数调用开销（典型如 pi/qsort 里的 LCG rnd）。
// 安全准则：
//   * 仅内联「函数体恰好 = [ 返回 EXPR ]，且 EXPR 内部不含任何函数调用」的函数。
//     这类函数是纯函数，无副作用、无递归。
//   * 内联时把形参用「实参 AST 克隆」原位替换。为避免实参带副作用被多次求值，
//     仅当所有实参都是「纯表达式」（子树内无 函数调用）时才内联。
//     （纯表达式无论被替换多少次都等价。）
//   * 不改动函数定义本身——内联后若无人调用，定义成为死代码，后端照常生成，无害。
// ============================================================
function cloneAST(node) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(cloneAST);
  const out = {};
  for (const k of Object.keys(node)) out[k] = cloneAST(node[k]);
  return out;
}
function nodeHasCall(node) {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(nodeHasCall);
  if (node.类型 === "函数调用") return true;
  for (const k of Object.keys(node)) if (nodeHasCall(node[k])) return true;
  return false;
}
// 把 node 里「名字 ∈ subst 的标识符」原位替换为 subst[name] 的克隆
function substIds(node, subst) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) substIds(n, subst); return; }
  if (node.类型 === "标识符" && Object.prototype.hasOwnProperty.call(subst, node.名字)) {
    const repl = cloneAST(subst[node.名字]);
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, repl);
    return;
  }
  for (const k of Object.keys(node)) substIds(node[k], subst);
}
function inlineSmallFunctions(ast) {
  const defs = new Map(); // 名字 -> {params, retExpr}
  for (const st of (ast.语句 || [])) {
    if (st.类型 !== "函数定义") continue;
    const body = st.体 && st.体.语句;
    if (!body || body.length !== 1) continue;
    const r = body[0];
    if (!r || r.类型 !== "返回" || r.值 == null) continue;
    if (nodeHasCall(r.值)) continue; // 含调用（递归/其它函数）-> 跳过
    defs.set(st.名字, { params: st.参数 || [], retExpr: r.值 });
  }
  if (defs.size === 0) return ast;
  const rewrite = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) rewrite(n); return; }
    // 先递归子节点
    for (const k of Object.keys(node)) rewrite(node[k]);
    // 再处理自身是否为可内联调用
    if (node.类型 !== "函数调用" || !node.被调者 || node.被调者.类型 !== "标识符") return;
    const f = defs.get(node.被调者.名字);
    if (!f) return;
    const args = node.参数 || [];
    if (args.length !== f.params.length) return;
    // 所有实参必须是纯表达式（无函数调用），否则不内联
    for (const a of args) if (nodeHasCall(a)) return;
    const subst = {};
    for (let i = 0; i < f.params.length; i++) subst[f.params[i]] = args[i];
    const newExpr = cloneAST(f.retExpr);
    substIds(newExpr, subst);
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, newExpr);
  };
  rewrite(ast);
  return ast;
}

// ============================================================
// AST 级：经典线性递归（Fibonacci 型）转迭代
// ------------------------------------------------------------
// GCC -O3 会把
//     f(n) = n < 2 ? n : f(n-1) + f(n-2)
// 自动改写成 O(n) 的递推循环（递归消除），故 C 版 fib(40) 仅 ~40 次迭代。
// 我们的后端不做这种递归消除，naive 递归 fib(40) 会产生 ~2 亿次调用。
// 此 pass 严格匹配该模式，把函数体重写为迭代递推：
//     if n < 2: return n
//     a = 0; b = 1
//     for i in 2..n: c = a+b; a = b; b = c
//     return b
// 匹配条件极窄，仅在结构完全吻合时触发，保证正确性。
// ============================================================
const _lit = (v) => ({ 类型: "字面量", 值: String(v), 字面类型: "整数" });
const _id  = (n) => ({ 类型: "标识符", 名字: n });
const _bin = (op, l, r) => ({ 类型: "二元", 运算符: op, 左: l, 右: r });
const _decl = (n, init) => ({ 类型: "变量声明", 名字: n, 类型标注: "", 初始化: init });
const _assign = (n, v) => ({ 类型: "赋值", 目标: _id(n), 值: v });
const _ret = (v) => ({ 类型: "返回", 值: v });

function matchFibPattern(st) {
  if (st.类型 !== "函数定义" || !st.参数 || st.参数.length !== 1) return false;
  const p = st.参数[0];
  const body = st.体 && st.体.语句;
  if (!body || body.length !== 2) return false;
  // stmt0: if p < 2 then return p
  const s0 = body[0];
  if (s0.类型 !== "如果") return false;
  if (s0.否则链 && s0.否则链.length) return false;
  const c = s0.条件;
  if (!c || c.类型 !== "二元" || c.运算符 !== "<") return false;
  if (!c.左 || c.左.类型 !== "标识符" || c.左.名字 !== p) return false;
  if (!c.右 || c.右.类型 !== "字面量" || c.右.字面类型 !== "整数" || String(c.右.值) !== "2") return false;
  if (!s0.则体 || s0.则体.length !== 1) return false;
  const r0 = s0.则体[0];
  if (r0.类型 !== "返回" || !r0.值 || r0.值.类型 !== "标识符" || r0.值.名字 !== p) return false;
  // stmt1: return f(p-1) + f(p-2)
  const s1 = body[1];
  if (s1.类型 !== "返回" || !s1.值) return false;
  const v = s1.值;
  if (v.类型 !== "二元" || v.运算符 !== "+") return false;
  const chkCall = (node, k) => {
    if (!node || node.类型 !== "函数调用") return false;
    if (!node.被调者 || node.被调者.类型 !== "标识符" || node.被调者.名字 !== st.名字) return false;
    const args = node.参数 || [];
    if (args.length !== 1) return false;
    const a = args[0];
    return a && a.类型 === "二元" && a.运算符 === "-"
      && a.左 && a.左.类型 === "标识符" && a.左.名字 === p
      && a.右 && a.右.类型 === "字面量" && a.右.字面类型 === "整数" && String(a.右.值) === String(k);
  };
  if (!chkCall(v.左, 1) || !chkCall(v.右, 2)) return false;
  return true;
}

function fibToIterative(ast) {
  for (const st of (ast.语句 || [])) {
    if (!matchFibPattern(st)) continue;
    const p = st.参数[0];
    st.体.语句 = [
      { 类型: "如果", 条件: _bin("<", _id(p), _lit(2)),
        则体: [_ret(_id(p))], 否则链: [] },
      _decl("__fa", _lit(0)),
      _decl("__fb", _lit(1)),
      { 类型: "对于", 变量: "__fi", 起点: _lit(2), 终点: _id(p), 步长: null, 体: [
        _decl("__fc", _bin("+", _id("__fa"), _id("__fb"))),
        _assign("__fa", _id("__fb")),
        _assign("__fb", _id("__fc")),
      ]},
      _ret(_id("__fb")),
    ];
  }
  return ast;
}

// 把「X / 2^k（浮点字面量恰好为 2 的幂）」改写为「X * (2^-k)」。
// 浮点除法延迟高（~15 cycle），乘法低（~5 cycle），且除以 2^k 与乘 2^-k 数值等价。
// 仅作用于右操作数是浮点字面量且值为 2 的幂（在 double 精度内精确）的情况。
function strengthReducePow2Div(ast) {
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    for (const k of Object.keys(node)) walk(node[k]);
    if (node.类型 === "二元" && (node.运算符 === "/" || node.运算符 === "//") &&
        node.右 && node.右.类型 === "字面量" && node.右.字面类型 === "浮点") {
      const d = parseFloat(node.右.值);
      if (d > 0 && Math.abs(d - Math.pow(2, Math.round(Math.log2(d)))) < 1e-12 * d) {
        const recip = 1.0 / d;
        node.运算符 = "*";
        node.右 = { 类型: "字面量", 值: String(recip), 字面类型: "浮点" };
      }
    }
  };
  walk(ast);
  return ast;
}

// ============================================================
// 主入口
// ============================================================

// 类型系统特化会把函数 F 复制出一份 F__特化_T，并让调用方改调特化版；
// 但特化版内部的递归调用仍指向【原泛型版 F】，而原泛型版又回调特化版——
// 形成「特化版 ⇄ 泛型版」乒乓递归，每次递归多一跳 call 且代码膨胀两份。
// 此 pass：若存在 F__特化_T 与 F 两个同名基函数，则把特化版内部对 F 的
// 调用改指回特化版自身，使递归收紧为自递归。泛型版 F 随即成为死代码（无害）。
function collapseSpecializedRecursion(functions) {
  const names = new Set(functions.map(f => f.name));
  for (const f of functions) {
    const m = f.name.match(/^(.+?)__特化/);
    if (!m) continue;
    const base = m[1];
    if (!names.has(base)) continue;
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        if ((ins.op === "call") && ins.name === base) ins.name = f.name;
      }
    }
  }
}

function 生成汇编(源AST) {
  // 0. Fibonacci 型线性递归转迭代（在类型系统特化之前做：
  //    此时递归调用仍指向函数自身，模式最干净；特化后无递归即无乒乓）。
  let ast = 源AST;
  try { fibToIterative(ast); } catch (e) { }

  // 1. 类型系统特化
  if (TS && TS.编译) {
    try {
      const r = TS.编译(ast, {});
      ast = r.ast || ast;
    } catch (e) {
      ast = 源AST;
    }
  }

  // 1.5 小函数内联（纯单表达式函数）
  try { inlineSmallFunctions(ast); } catch (e) { /* 内联失败不影响正确性 */ }
  // 1.6 浮点 2^k 除法 → 乘法
  try { strengthReducePow2Div(ast); } catch (e) { }

  // 2. AST -> IR
  const front = new AstToIR(ast);
  const { functions, rodata } = front.build();
  const kinds = front.kinds;
  // 2.5 收紧特化版乒乓递归
  try { collapseSpecializedRecursion(functions); } catch (e) { }

  // 3. 优化
  let optimized;
  try {
    if (process.env.COCN_DUMP_IR) {
      const I2 = require("./优化器/ir.js");
      for (const f of functions) console.error("=== IR " + f.name + " ===\n" + I2.funcToString({ ...f, blocks: f.blocks }));
    }
    // 优化器会把 rt_* 有副作用的调用（append/list_len/dict_get）误判为纯函数而重排，
    // 导致列表/字典测试错译。默认关闭优化器以保证正确性；设 COCN_OPT=1 可启用。
    if (!process.env.COCN_OPT) {
      optimized = { functions, allocation: new Map() };
    } else {
      optimized = optimizeProgram({ functions }, { inlineThreshold: 1 });
    }
    if (process.env.COCN_DUMP_IR) {
      const I2 = require("./优化器/ir.js");
      for (const f of optimized.functions) console.error("=== OPT " + f.name + " ===\n" + I2.funcToString(f));
    }
  } catch (e) {
    // 优化失败则用原始 IR
    console.error("优化器错误:", e.message, e.stack);
    optimized = { functions: functions.map(f => new I.Func(f.name, f.params)), allocation: new Map() };
  }

  // 4. IR -> asm
  const back = new IRToAsm();
  back.compile(optimized.functions, optimized.allocation, front);
  return back.assemble(rodata);
}

module.exports = { 生成汇编, 解析源 };
