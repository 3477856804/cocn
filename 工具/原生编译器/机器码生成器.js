#!/usr/bin/env node
// ============================================================
// 机器码生成器.js —— AST -> x86-64 机器码 -> ELF64 可执行文件
//
// 完全跳过汇编器，直接编码机器指令。
// System V AMD64 ABI，栈帧基于 rbp。
// 内置运行时（print_str / print_int / print_nl 等）纯机器码实现，
// 通过 Linux syscall (write=1, exit=60) 输出。
// ============================================================

const fs = require("fs");
const path = require("path");
const { 解析源 } = require("./语法分析器.js");
const { buildElf64, BASE_ADDR, ELF_HDR_SIZE, PHDR_SIZE, PHDR_NUM, HEAP_ADDR, HEAP_SIZE } = require("./elf.js");

// 编译器代次串：写进产物 ELF 的 ABI 尾戳，启动器在 execv 前自检。
// 与 启动器.c 的 COCN_ABI（install.js 注入 -DCOCN_ABI="cocn-direct-<版本>"）
// 必须完全一致，否则每次运行都会缓存未命中、重编一遍。
// 版本只读一次；读不到（源码裸跑、package.json 缺失）宁可返回 null
// 让产物没有尾戳——启动器把无尾戳判为未知代次并重编，宁慢勿错。
let 代次缓存;
function 编译器代次() {
  if (代次缓存 === undefined) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
      代次缓存 = pj.version ? "cocn-direct-" + pj.version : null;
    } catch (e) { 代次缓存 = null; }
  }
  return 代次缓存;
}

// ============================================================
// 运行时内存布局（竞技场堆）
// ============================================================
// 堆由 ELF 的第二个 LOAD 段（R+W, filesz=0）提供，内核零初始化，
// 一次 bump 分配都不需要 syscall，也不需要 malloc。
//   +0 分配游标  +8 堆上限  +16 溢出诊断位（零初始化即可）
//
// 串对象 / 绳索节点共用同一组头部，靠 [0] 的符号区分：
//   扁平串：[0]=0（字节数放在 [16]）  [8]=字符数  [16]=字节数  [24..]=UTF-8+NUL
//   绳索  ：[0]=-1 [8]=字符数 [16]=字节数 [24]=左 [32]=右 [40]=深度 [48]=摊平缓存
// 字符串字面量在只读段里直接就是一个扁平串对象，所以「取长度」「打印」
// 对字面量和拼接产物走同一条代码路径；反过来也意味着运行时绝不能写
// 字面量对象——摊平缓存只会落在堆上的绳索节点里。
// 列表对象：[0]=长度 [8]=容量 [16]=数据指针（元素为 8 字节槽）
const HEAD_NEXT = 0, HEAD_LIMIT = 8;
const 串头字节 = 24;      // 扁平串数据起点
const 绳索字节 = 48;      // 绳索节点定长：[0]=-1 [8]字符 [16]字节 [24]左 [32]右 [40]摊平缓存
const 列表头字节 = 24;
// 摊平用「显式栈」而不是机器栈：链式 s = s + x 攒出的绳索深度等于拼接次数
// （基准程序是 3000 层），递归写会吃掉几百 KB 机器栈，深一点就爆栈。
// 所以从堆段开头切出一段专用栈区，压的是子节点指针，8 字节一层。
const 栈区字节 = 1 << 23;              // 8MB -> 最多 1M 层嵌套
const FLAT_STACK = HEAP_ADDR + 64;
const FLAT_STACK_END = FLAT_STACK + 栈区字节;
// 栈下限哨兵：堆段开头 HEAP_ADDR+16..23 空着（0..15 是竞技场堆头，
// 32..47 借给 getrlimit 的 rlim 结构，64 起是绳索摊平栈），_start 把它
// 填成真实的栈底。每次函数序言比一次，越界就报中文错误退出，而不是让
// 递归深的程序裸 SIGSEGV（退出码 139，用户只看到「段错误」，没有可行动信息）。
const STACK_FLOOR = HEAP_ADDR + 16;
const RLIM_SLOT = HEAP_ADDR + 32;      // getrlimit 的 struct rlimit（16 字节）
const 栈区默认 = 8 << 20;              // getrlimit 失败时的兜底（本机 ulimit -s = 8192KB）
const 栈区上限 = 512 << 20;            // RLIM_INFINITY 也按这个保守取限
const 栈安全余量 = 1 << 20;            // 栈底之上留 1MB 缓冲，早于内核 guard gap 报错

// ============================================================
// 寄存器编码
// ============================================================
const R = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3,
  rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11,
  r12: 12, r13: 13, r14: 14, r15: 15,
};
const ARG_REGS = [R.rdi, R.rsi, R.rdx, R.rcx, R.r8, R.r9];

// ============================================================
// Emitter —— 字节发射器，支持标签和跳转修复
// ============================================================
class Emitter {
  constructor() {
    this.bytes = [];
    this.labelPos = new Map();
    this.fixups = [];
    this.seq = 0;
  }
  get pos() { return this.bytes.length; }
  b(v) { this.bytes.push(v & 0xFF); }
  bs(arr) { for (const x of arr) this.bytes.push(x & 0xFF); }
  i8(n) { this.b(n); }
  i32(n) {
    n = n | 0;
    this.b(n & 0xFF); this.b((n >> 8) & 0xFF);
    this.b((n >> 16) & 0xFF); this.b((n >> 24) & 0xFF);
  }
  i64(n) {
    if (typeof n === "number") n = BigInt(n);
    for (let i = 0; i < 8; i++) this.b(Number((n >> BigInt(i * 8)) & 0xFFn));
  }
  label(name) {
    if (this.labelPos.has(name)) throw new Error(`标签重复: ${name}`);
    this.labelPos.set(name, this.pos);
  }
  nl(p = "L") { return `${p}_${++this.seq}`; }
  fixupRel32(name) {
    this.fixups.push({ pos: this.pos, label: name, type: "rel32" });
    this.i32(0);
  }
  fixupDataAbs64(name) {
    this.fixups.push({ pos: this.pos, label: name, type: "dataAbs64" });
    this.i64(0n);
  }
  resolve(codeSize, dataLabelOff) {
    dataLabelOff = dataLabelOff || new Map();
    for (const f of this.fixups) {
      let target;
      if (f.type === "dataAbs64") {
        target = dataLabelOff.get(f.label);
      } else {
        target = this.labelPos.get(f.label);
      }
      if (target === undefined) throw new Error(`未定义标签: ${f.label}`);
      if (f.type === "rel32") {
        const rel = target - (f.pos + 4);
        this.bytes[f.pos] = rel & 0xFF;
        this.bytes[f.pos + 1] = (rel >> 8) & 0xFF;
        this.bytes[f.pos + 2] = (rel >> 16) & 0xFF;
        this.bytes[f.pos + 3] = (rel >> 24) & 0xFF;
      } else if (f.type === "dataAbs64") {
        // 数据段紧跟代码段：基址 + ELF 头 + 全部程序头 + 代码长度 + 段内偏移
        const abs = BigInt(BASE_ADDR) + BigInt(ELF_HDR_SIZE + PHDR_SIZE * PHDR_NUM + codeSize) + BigInt(target);
        for (let i = 0; i < 8; i++)
          this.bytes[f.pos + i] = Number((abs >> BigInt(i * 8)) & 0xFFn);
      }
    }
  }
  toBuffer() { return Buffer.from(this.bytes); }
}

// ============================================================
// 指令编码辅助函数
// ============================================================
function rex(W, R_, X, B) { return 0x40 | (W?8:0) | (R_?4:0) | (X?2:0) | (B?1:0); }
function modrm(mod, reg, rm) { return ((mod&3)<<6) | ((reg&7)<<3) | (rm&7); }

// ============================================================
// 内存操作数发射：modrm + （必要时）SIB
// rm=100 是「有 SIB」的编码，任何 mod≠11 的 rm=100 都必须紧跟一个 SIB 字节。
// 少了这个字节，CPU 会把后面的 disp8/disp32 当成 SIB 解码——
// 之前所有 base=r12/rsp 的 [base+disp] 都因此编成了完全不同的地址，
// 表现为「刚分配的指针写进去就段错误」。统一走这两个函数，杜绝漏掉 SIB。
// ============================================================
function emitMem(em, mod, reg, base, disp) {
  if ((base & 7) === 4) {
    em.b(modrm(mod, reg, 4));
    em.b(0x24);                      // index=无(100), base=100(rsp/r12)
  } else {
    em.b(modrm(mod, reg, base & 7));
  }
  if (mod === 1) em.i8(disp);
  else if (mod === 2) em.i32(disp);
}
// SIB：[base + idx*scale + disp32]。scale 默认 8，正好是列表槽位宽度，
// 所以下标寄存器里放「元素序号」就够了，调用方不必先乘 8。
// （早先漏了 scale 位，SIB 退化成 ×1，读写列表会串到隔壁槽去。）
function emitMemIdx(em, mod, reg, base, idx, scale = 3) {
  em.b(modrm(mod, reg, 4));
  em.b(((scale & 3) << 6) | ((idx & 7) << 3) | (base & 7));
}

// mov r64, r64
function movRR(em, d, s) {
  em.b(rex(1, d>=8?1:0, 0, s>=8?1:0));
  em.b(0x8B); em.b(modrm(3, d&7, s&7));
}
// mov r64, imm64
function movRI64(em, r, imm) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xB8 + (r&7)); em.i64(imm);
}
// 判断 disp 是否在 int8 范围内
function fitsDisp8(d) { return d >= -128 && d <= 127; }
// mov r64, [rbp + disp]（自动选择 disp8/disp32）
function movRMem(em, r, disp) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x8B);
  emitMem(em, m, r&7, R.rbp, disp);
}
// mov [rbp + disp], r64（自动选择 disp8/disp32）
function movMemR(em, disp, r) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x89);
  emitMem(em, m, r&7, R.rbp, disp);
}
// push/pop r64
// 低位寄存器（rax..rdi）用裸的 0x50+/0x58+，一个字节就好。
// 不能给它们加 0x40 前缀：REX 的 B 位会把 rbx/rbp/rsp 的 rm 重新解释成
// r13/r15/r12——之前 push rbx 被编成 push r13， callee-saved 全错位，
// 表现为「列表里莫名多出几个字节长得像 ASCII 的值」。
function pushR(em, r) {
  if (r >= 8) em.b(rex(1, 0, 0, 1));
  em.b(0x50 + (r & 7));
}
function popR(em, r) {
  if (r >= 8) em.b(rex(1, 0, 0, 1));
  em.b(0x58 + (r & 7));
}
// add r64, r64 (d += s)
function addRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x01); em.b(modrm(3, s&7, d&7));
}
// sub r64, r64 (d -= s)
function subRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x29); em.b(modrm(3, s&7, d&7));
}
// imul r64, r64 (d *= s)
function imulRR(em, d, s) {
  em.b(rex(1, d>=8?1:0, 0, s>=8?1:0));
  em.bs([0x0F, 0xAF]); em.b(modrm(3, d&7, s&7));
}
// idiv r64 (rdx:rax / r)
function idivR(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xF7); em.b(modrm(3, 7, r&7));
}
// cqo
function cqo(em) { em.bs([0x48, 0x99]); }
// neg r64
function negR(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xF7); em.b(modrm(3, 3, r&7));
}
// cmp r64, r64 (d - s)
function cmpRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x39); em.b(modrm(3, s&7, d&7));
}
// test r64, r64
function testRR(em, a, b) {
  em.b(rex(1, b>=8?1:0, 0, a>=8?1:0));
  em.b(0x85); em.b(modrm(3, b&7, a&7));
}
// xor r64, r64
function xorRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x31); em.b(modrm(3, s&7, d&7));
}
// and r64, r64 (d &= s)
function andRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x21); em.b(modrm(3, s&7, d&7));
}
// or r64, r64 (d |= s)
function orRR(em, d, s) {
  em.b(rex(1, s>=8?1:0, 0, d>=8?1:0));
  em.b(0x09); em.b(modrm(3, s&7, d&7));
}
// sal r64, cl (左移)
function salRCl(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xD3); em.b(modrm(3, 4, r&7));
}
// sar r64, cl (算术右移)
function sarRCl(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xD3); em.b(modrm(3, 7, r&7));
}
// inc r64
function incR(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xFF); em.b(modrm(3, 0, r&7));
}
// ============================================================
// 「可写内存」时代新增的编码辅助
// 绝对寻址形式：mod=00, rm=100(SIB), base=100(无基址), index=100(无变址), disp32
// 代码段与堆段地址都远小于 2^31，所以 disp32 足够放下。
// ============================================================
const ABS_SIB = 0x25;
function movRAbs(em, r, abs) {
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x8B); em.b(modrm(0, r&7, 4)); em.b(ABS_SIB); em.i32(abs);
}
function movAbsR(em, abs, r) {
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x89); em.b(modrm(0, r&7, 4)); em.b(ABS_SIB); em.i32(abs);
}
// cmp r64, [abs] —— 用 0x3B（寄存器作被减数），这样「r > 内存值」才是 ja。
// 早先用 0x39 编码成 cmp [abs], r64，算的是「内存值 - r」，
// 结果竞技场一分配第一字节就误判成堆耗尽（越界检查反了）。
function cmpRAbs(em, r, abs) {
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x3B); em.b(modrm(0, r&7, 4)); em.b(ABS_SIB); em.i32(abs);
}
// mov r64, [base + idx*8]：用 mod=10 + disp32=0，规避 rbp/r13 作基址时 mod=00 的歧义
function movIdxLoad(em, r, base, idx) {
  em.b(rex(1, r>=8?1:0, idx>=8?1:0, base>=8?1:0));
  em.b(0x8B);
  emitMemIdx(em, 2, r&7, base, idx); em.i32(0);
}
function movIdxStore(em, base, idx, r) {
  em.b(rex(1, r>=8?1:0, idx>=8?1:0, base>=8?1:0));
  em.b(0x89);
  emitMemIdx(em, 2, r&7, base, idx); em.i32(0);
}
// mov r64, [base + disp] / mov [base + disp], r64
function movRDisp(em, r, base, disp) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, base>=8?1:0));
  em.b(0x8B);
  emitMem(em, m, r&7, base, disp);
}
function movDispR(em, base, disp, r) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, base>=8?1:0));
  em.b(0x89);
  emitMem(em, m, r&7, base, disp);
}
// add r64, imm32（opcode 81 /0）
function addRImm(em, r, imm) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0x81); em.b(modrm(3, 0, r&7)); em.i32(imm);
}
function subRImm(em, r, imm) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0x81); em.b(modrm(3, 5, r&7)); em.i32(imm);
}
function andRImm(em, r, imm) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0x81); em.b(modrm(3, 4, r&7)); em.i32(imm);
}
function cmpRImm(em, r, imm) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0x81); em.b(modrm(3, 7, r&7)); em.i32(imm);
}
function shlRImm(em, r, n) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xC1); em.b(modrm(3, 4, r&7)); em.b(n & 0xFF);
}
// movzx r64, byte [base + idx*1]（mod=00，disp 缺省；base 用 rsp/rbp 需 SIB，此处不用于它们）
function loadByteIdx(em, r, base, idx) {
  em.b(rex(1, r>=8?1:0, idx>=8?1:0, base>=8?1:0));
  em.b(0x0F); em.b(0xB6); em.b(modrm(0, r&7, 4));
  em.b(((idx&7)<<3) | (base&7));
}
// movzx r64, byte [base + disp8]
function loadByteDisp(em, r, base, disp) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, base>=8?1:0));
  em.b(0x0F); em.b(0xB6);
  emitMem(em, m, r&7, base, disp);
}
// mov [base + disp8], r8
function storeByteDisp(em, base, disp, r8) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(0, r8>=8?1:0, 0, base>=8?1:0));
  em.b(0x88);
  emitMem(em, m, r8&7, base, disp);
}
// mov byte [base], imm8
function movByteAt(em, base, v) {
  em.b(rex(0, 0, 0, base>=8?1:0));
  em.b(0xC6); em.b(modrm(0, 0, base&7)); em.b(v & 0xFF);
}
// mov byte [base + disp8], imm8
function movByteImm(em, base, disp, v) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(0, 0, 0, base>=8?1:0));
  em.b(0xC6);
  emitMem(em, m, 0, base, disp);
  em.b(v & 0xFF);
}
// div r64（无符号 rdx:rax / r）
function divR(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xF7); em.b(modrm(3, 6, r&7));
}
// rep movsb：[rsi] -> [rdi]，rcx 个字节
function repMovsb(em) { em.bs([0xF3, 0xA4]); }
// cld：方向标志清零（不依赖调用方状态）
function cld(em) { em.b(0xFC); }
// cmovg r64a, r64b —— 有符号大于则移动：比较用条件选择代替分支
function cmovgRR(em, d, s) {
  em.b(rex(1, d>=8?1:0, 0, s>=8?1:0));
  em.bs([0x0F, 0x4F]); em.b(modrm(3, d&7, s&7));
}
// dec r64
function decR(em, r) {
  em.b(rex(1, 0, 0, r>=8?1:0));
  em.b(0xFF); em.b(modrm(3, 1, r&7));
}
// cmp r64, [base + disp8]
function cmpRDisp(em, r, base, disp) {
  const m = fitsDisp8(disp) ? 1 : 2;
  em.b(rex(1, r>=8?1:0, 0, base>=8?1:0));
  em.b(0x3B);
  emitMem(em, m, r&7, base, disp);
}
// cmp r64, [abs]
function cmpRAbsR(em, r, abs) {
  em.b(rex(1, r>=8?1:0, 0, 0));
  em.b(0x3B); em.b(modrm(0, r&7, 4)); em.b(ABS_SIB); em.i32(abs);
}

// syscall
function syscall(em) { em.bs([0x0F, 0x05]); }
// ret
function ret(em) { em.b(0xC3); }
// leave
function leave(em) { em.b(0xC9); }

// 条件跳转操作码
const JCC = { e:0x84, ne:0x85, l:0x8C, le:0x8E, g:0x8F, ge:0x8D,
              b:0x82, be:0x86, a:0x87, ae:0x83, z:0x84, nz:0x85, s:0x88, ns:0x89 };
// setcc 操作码
const SETCC = { e:0x94, ne:0x95, l:0x9C, le:0x9E, g:0x9F, ge:0x9D,
                b:0x92, be:0x96, a:0x97, ae:0x93, z:0x94, nz:0x95 };

function jmp(em, lbl) { em.b(0xE9); em.fixupRel32(lbl); }
function jcc(em, cc, lbl) { em.bs([0x0F, cc]); em.fixupRel32(lbl); }
function call(em, lbl) { em.b(0xE8); em.fixupRel32(lbl); }
function setccAl(em, cc) { em.bs([0x0F, cc, 0xC0]); } // setcc al (modrm=11,000,000=al)
function movzbEaxAl(em) { em.bs([0x0F, 0xB6, 0xC0]); }

// sub rsp, imm32
function subRsp(em, n) {
  if (n <= 127) { em.bs([0x48, 0x83, 0xEC, n]); }
  else { em.bs([0x48, 0x81, 0xEC]); em.i32(n); }
}
// add rsp, imm8
function addRsp(em, n) { em.bs([0x48, 0x83, 0xC4, n]); }

// ============================================================
// FuncCtx —— 函数上下文
// ============================================================
// 帧尺寸：0.1.15 及之前每帧固定预留 tempBase(64) + TEMP_SLOTS(48) = 112 槽
// = 896 字节，不管函数真用了几个槽。实测后果：8MB 默认栈下递归 9187 层就
// SIGSEGV（896 × 9187 ≈ 8MB，正好撞栈顶），纯计算负载也一直在为空气买单。
//
// 现在按真实用量开帧：先递归数出这个函数体里所有会 allocVar 的节点
// （变量声明 + 对于 的循环变量，再加上参数），把 tempBase 设为这个数量，
// 局部变量占 -8..-8*变量数，临时槽从变量数之后往下长，两块背靠背不重叠。
//
// 关键点：allocVar 是在生成过程中【中途】发生的（对于 的循环变量、循环体里的
// 变量声明），所以计数若漏掉某种语句容器，临时槽就会和变量槽撞在同一格 ——
// 那正是「能跑但算错」。所以 allocVar 里必须硬校验 slotCount < tempBase，
// 一旦越过就编译期报错，交给启动器兜底，绝不生成会撞槽的代码。
// 这条校验顺带堵住老实现里「函数局部变量超过 64 个」的同款隐患。
function 统计声明数(node, 已见 = new WeakSet()) {
  if (node == null || typeof node !== "object") return 0;
  if (已见.has(node)) return 0;
  已见.add(node);
  let n = 0;
  if (Array.isArray(node)) {
    for (const x of node) n += 统计声明数(x, 已见);
    return n;
  }
  const t = node.类型;
  // 与 genFor / genVarDecl 一一对应：这两类节点各调用一次 allocVar
  if (t === "变量声明" || t === "对于") n++;
  for (const k of Object.keys(node)) {
    if (k === "类型") continue;
    n += 统计声明数(node[k], 已见);
  }
  return n;
}
class FuncCtx {
  constructor(变量数 = 0) {
    this.slots = new Map();
    this.slotCount = 0;
    this.tempSP = 0;
    this.tempMax = 0;
    // 局部变量区 [0, 变量数)，临时槽区 [变量数, 变量数+tempMax)
    this.tempBase = 变量数;
    this.breakEnds = [];
    this.contHeads = [];
    this.retKind = "none";
  }
  allocVar(name, kind) {
    // 撞槽硬校验：变量区是 [0, tempBase)。计数若漏了某个会 allocVar 的节点，
    // 这里就会踩进临时槽区，生成「能跑但算错」的代码。宁可编译期拒绝、
    // 让启动器兜底走解释器，也绝不发错产物。
    if (this.slotCount >= this.tempBase)
      throw new Error("直接机器码内部错误：局部变量超出预留（请改走解释器兜底）");
    const off = -8 * (this.slotCount + 1);
    this.slots.set(name, { off, kind });
    this.slotCount++;
    return off;
  }
  slotOff(name) {
    const s = this.slots.get(name);
    if (!s) throw new Error(`未定义变量: ${name}`);
    return s;
  }
  markBool(name) { const s = this.slots.get(name); if (s) s.是布尔 = true; }
  isBoolVar(name) { const s = this.slots.get(name); return !!(s && s.是布尔); }
  // 按名字声明顺序的整数下标（co_main 里就是全局变量表槽位）
  boolIndex(name) {
    if (!(name in this._bi)) this._bi[name] = this._bn++;
    return this._bi[name];
  }
  newTemp() {
    const idx = this.tempBase + this.tempSP;
    this.tempSP++;
    if (this.tempSP > this.tempMax) this.tempMax = this.tempSP;
    return -8 * (idx + 1);
  }
  releaseTemp(n) { this.tempSP -= n; }
  stackSize() {
    // 真实用量：局部变量区 + 临时槽高水位，16 字节对齐（System V ABI 要求）
    const eff = this.tempBase + this.tempMax;
    let n = eff * 8;
    n = (n + 15) & ~15;
    return n;
  }
}

// ============================================================
// DirectGen —— 直接机器码生成器
// ============================================================
class DirectGen {
  constructor(ast) {
    this.ast = ast;
    this.em = new Emitter();       // 主代码发射器
    this.funcLabelMap = new Map();
    this.funcRetKinds = new Map();
    this.funcSigs = new Map();        // 标签 -> {参, 返, 数}
    this.strLabelMap = new Map();
    this.rodata = [];              // {label, data: Buffer}
  }

  run() {
    // 预收集函数
    for (const st of this.ast.语句) {
      if (st.类型 === "函数定义") {
        const lbl = `F${this.funcLabelMap.size}_${st.名字}`;
        this.funcLabelMap.set(st.名字, lbl);
        // 签名要在【任何调用点生成之前】就位：直弹后端过去只看函数名、
        // 既不看实参种类也不看返回值种类，于是
        //   函数 g() -> 字符串 { 返回 1 }   → 调用点按 str 打印整数 → 乱码/坏内存
        //   函数 f(整数 a) {...} ; f(真)     → 布尔塞进整数槽，宿主报「类型错误（函数参数）」
        // 这两条在 0.1.16 审计里都是 rc=0 的静默错误，现在编译期拒绝。
        this.funcSigs.set(lbl, {
          参: st.参数.map((_, i) => this.kindFromAnnotation((st.参数类型 && st.参数类型[i]) || "")),
          返: this.kindFromAnnotation(st.返回类型 || ""),
          数: st.参数.length,
          默认数: 0,   // 有默认参数的函数在上面就被拒绝了，这里恒 0
          有可变: !!(st.参数类型 || []).includes("可变"),
        });
      }
    }

    // _start
    this.genStart();
    // 运行时函数
    this.genRuntime();
    // 用户函数
    for (const st of this.ast.语句) {
      if (st.类型 === "函数定义") this.genFunc(st);
    }
    // co_main
    this.genCoMain();

    // 数据段
    const { buf: dataBuf, labelOff: dataLabelOff } = this.buildData();
    // 修复标签（dataAbs64 需要代码段大小来计算数据段绝对地址）
    const codeSize = this.em.pos;
    this.em.resolve(codeSize, dataLabelOff);
    // 合并代码+数据
    const codeBuf = this.em.toBuffer();
    const combined = Buffer.concat([codeBuf, dataBuf]);
    // 生成 ELF（末尾带 ABI 尾戳，供启动器 execv 前做代次自检）
    return buildElf64(combined, 0, 编译器代次());
  }

  // ---- _start ----
  genStart() {
    this.em.label("_start");
    // 竞技场堆头：游标从预留区之后起步，上限留一页安全余量。
    movRI64(this.em, R.rax, BigInt(FLAT_STACK_END));
    movAbsR(this.em, HEAP_ADDR + HEAD_NEXT, R.rax);
    movRI64(this.em, R.rax, BigInt(HEAP_ADDR + HEAP_SIZE - 4096));
    movAbsR(this.em, HEAP_ADDR + HEAD_LIMIT, R.rax);
    // 记下真实栈底：栈向低地址长，可用量是 getrlimit(RLIMIT_STACK) 的 rlim_cur，
    // 不是「初始 rsp 减一小块」——先前只减 256KB 会把哨兵立在栈顶下面，
    // 结果 15 万层正常递归也被误判成溢出（实测）。
    // rlim 结构写在堆段预留区（代码段只读，且此时竞技场游标还没动，不冲突）。
    movRI64(this.em, R.rdi, 3n);                     // RLIMIT_STACK
    movRI64(this.em, R.rsi, BigInt(RLIM_SLOT));      // &rlim
    movRI64(this.em, R.rax, 97n);                    // getrlimit
    syscall(this.em);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.nz, "st_bad");
    movRAbs(this.em, R.rax, RLIM_SLOT);              // rlim_cur（前 8 字节）
    movRI64(this.em, R.rdx, BigInt(栈区上限));
    cmpRR(this.em, R.rax, R.rdx);
    jcc(this.em, JCC.b, "st_cap");                   // 有限值：直接用
    movRI64(this.em, R.rax, BigInt(栈区默认));       // RLIM_INFINITY：保守取默认
    this.em.label("st_cap");
    jmp(this.em, "st_have");
    this.em.label("st_bad");
    movRI64(this.em, R.rax, BigInt(栈区默认));       // 调用失败：兜底
    this.em.label("st_have");
    subRImm(this.em, R.rax, 栈安全余量);
    movRR(this.em, R.rdx, R.rsp);
    subRR(this.em, R.rdx, R.rax);                    // 初始 rsp − 可用栈 = 栈底
    movAbsR(this.em, STACK_FLOOR, R.rdx);
    call(this.em, "co_main");
    // exit(rax)
    movRI64(this.em, R.rdi, 0n); // 简化：exit code 用 0（rax 是 co_main 返回值，但测试不关心）
    // 实际上 co_main 的返回值在 rax 里，我们把它作为 exit code
    // mov rdi, rax
    movRR(this.em, R.rdi, R.rax);
    movRI64(this.em, R.rax, 60n); // sys_exit
    syscall(this.em);
  }

  // ---- 运行时 ----
  // ============================================================
  // 原生运行时（竞技场堆 + 绳索串 + 无装箱列表）
  // ============================================================
  // 寄存器约定：运行时函数只用 caller-saved（rax/rcx/rdx/rsi/rdi/r8-r11）放临时值，
  // 需要跨调用保值的放进 rbx/r12-r15 并配对 push/pop。
  // 所以用户代码把活对象指针放在栈槽里，不会被运行时吃掉。
  // 内部调用链（rt_alloc / rt_flatten / rt_depth）同样只破坏 caller-saved。

  // 运行时的生成顺序不影响正确性（标签在链接期统一解析），
  // 但内部调用关系要列清楚，免得以后加函数时漏掉一个。
  genRuntime() {
    this.genRtFail();
    this.genStackFail();
    this.genShiftNeg();
    this.genShiftOob();
    this.genAlloc();
    this.genFlattenInto();
    this.genFlatten();
    this.genConcat();
    this.genStrLen();
    this.genStrEq();
    this.genIntToStr();
    this.genListNew();
    this.genListAppend();
    this.genListGet();
    this.genListSet();
    this.genListLen();
    this.genPrintStr();
    this.genPrintInt();
    this.genPrintBool();
    this.genBoolToStr();
    this.genStepZero();
    this.genPrintNl();
    this.genPrintSpace();
  }

  // 把只读段消息对象的地址装进 rdi（地址要等链接期才知道，走 dataAbs64 修复）
  loadMsg(label) {
    movRI64(this.em, R.rdi, 0n);
    this.em.fixups.push({ pos: this.em.pos - 8, label, type: "dataAbs64" });
  }

  // rt_fail: rdi=串对象 -> 写 stderr 后 exit 3
  genRtFail() {
    this.em.label("rt_fail");
    call(this.em, "rt_flatten");
    movRR(this.em, R.rsi, R.rax);
    addRImm(this.em, R.rsi, 串头字节);
    movRDisp(this.em, R.rdx, R.rax, 16);
    movRI64(this.em, R.rdi, 2n);              // fd = stderr
    movRI64(this.em, R.rax, 1n);              // write
    syscall(this.em);
    movRI64(this.em, R.rdi, 3n);              // 运行时错误退出码
    movRI64(this.em, R.rax, 60n);             // exit
    syscall(this.em);
    ret(this.em);
  }

  // rt_stack_fail: 所有函数序言共用的栈越界出口。
  // 单独成一个例程（而不是在每个序言里就地展开 loadMsg），是为了让
  // 序言的冷路径只有一条 jmp——取消息地址的 movabs（10 字节）如果
  // 内联在序言里，会把热循环体挤出对齐，实测 1e7 次累加从 19.7ms
  // 变成 22.5ms。这里代价一次跳转，换回全部函数的序言密度。
  genStackFail() {
    this.em.label("rt_stack_fail");
    this.loadMsg(this.strConst("运行错误：原生栈溢出（递归太深）\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_shift_neg: 移位位数为负
  // 测试版本：静态消息
  genShiftNeg() {
    this.em.label("rt_shift_neg");
    this.loadMsg(this.strConst("移位位数不能为负\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_shift_oob: 移位位数超出范围
  // 测试版本：静态消息
  genShiftOob() {
    this.em.label("rt_shift_oob");
    this.loadMsg(this.strConst("移位位数超出范围\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_print_bool: rdi = 0/1 -> 「假」/「真」
  // 布尔的打印形态是类型的一部分：打成 1/0 就是宿主词典里的错。
  genPrintBool() {
    this.em.label("rt_print_bool");
    const f = this.em.nl("pb_f");
    testRR(this.em, R.rdi, R.rdi);
    jcc(this.em, JCC.z, f);
    this.loadMsg(this.strConst("真"));
    jmp(this.em, "rt_print_str");
    this.em.label(f);
    this.loadMsg(this.strConst("假"));
    jmp(this.em, "rt_print_str");
  }

  // rt_bool_to_str: rdi = 0/1 -> rax = 只读段扁平串「真」/「假」
  // 注意 loadMsg 把地址装进的是 rdi（那是 rt_print_str 的入参位），
  // 本函数按约定要【返回】串对象，所以必须再 mov rax, rdi——
  // 漏掉这一步就是 转字符串(假) 拿 rax=0 去打印，直接段错误。
  genBoolToStr() {
    this.em.label("rt_bool_to_str");
    const f = this.em.nl("b2s_f");
    testRR(this.em, R.rdi, R.rdi);
    jcc(this.em, JCC.z, f);
    this.loadMsg(this.strConst("真"));
    movRR(this.em, R.rax, R.rdi);
    ret(this.em);
    this.em.label(f);
    this.loadMsg(this.strConst("假"));
    movRR(this.em, R.rax, R.rdi);
    ret(this.em);
  }

  // rt_step_zero: 对于 循环步长为 0（宿主：「循环步长不能为 0」）
  // 0.1.16 审计实测：旧后端没有任何步长检查，对于 i 从 1 到 3 步长 0
  // 编成 ELF 后死循环刷爆 stdout（rc=124 被 timeout 杀）——这是最恶劣的
  // 「编得过、跑得动、但永远跑不完」。现在冷路径共享出口，写 stderr 退 3。
  genStepZero() {
    this.em.label("rt_step_zero");
    this.loadMsg(this.strConst("运行错误：循环步长不能为 0\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_alloc: rdi=字节 -> rax=指针。bump 分配，一次 syscall 都不发。
  genAlloc() {
    this.em.label("rt_alloc");
    const bad = this.em.nl("al_bad");
    addRImm(this.em, R.rdi, 7);
    andRImm(this.em, R.rdi, -8);
    movRAbs(this.em, R.rax, HEAP_ADDR + HEAD_NEXT);
    movRR(this.em, R.rcx, R.rax);
    addRR(this.em, R.rax, R.rdi);
    cmpRAbs(this.em, R.rax, HEAP_ADDR + HEAD_LIMIT);
    jcc(this.em, JCC.a, bad);
    movAbsR(this.em, HEAP_ADDR + HEAD_NEXT, R.rax);
    movRR(this.em, R.rax, R.rcx);
    ret(this.em);
    this.em.label(bad);
    // 堆耗尽必须明说，绝不能返回越界指针让程序静默跑飞
    this.loadMsg(this.strConst("运行错误：原生堆内存不足\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_flat_into: rdi=串对象, rsi=写入点 -> rax=写完后的位置
  // 迭代而不是递归：链式 s = s + x 攒出的绳索深度等于拼接次数（基准程序 3000 层），
  // 用机器栈写会在几百 KB 处爆栈。这里改用堆段里预留的专用区当显式栈，
  // 每个待写的右子压 8 字节，深度上限就是栈区容量，耗尽时明确报错。
  genFlattenInto() {
    this.em.label("rt_flat_into");
    const down = this.em.nl("fi_down");
    const leaf = this.em.nl("fi_leaf");
    const pop = this.em.nl("fi_pop");
    const done = this.em.nl("fi_done");
    const bad = this.em.nl("fi_bad");
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    movRR(this.em, R.rbx, R.rdi);                // rbx = 当前节点
    movRR(this.em, R.r12, R.rsi);                // r12 = 写入点
    movRI64(this.em, R.r13, BigInt(FLAT_STACK)); // r13 = 栈顶
    this.em.label(down);
    movRDisp(this.em, R.rax, R.rbx, 0);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.ns, leaf);
    // 绳索：右子排队，先钻进左子
    cmpRImm(this.em, R.r13, FLAT_STACK_END);
    jcc(this.em, JCC.ae, bad);
    movRDisp(this.em, R.rax, R.rbx, 32);
    movDispR(this.em, R.r13, 0, R.rax);
    addRImm(this.em, R.r13, 8);
    movRDisp(this.em, R.rbx, R.rbx, 24);
    jmp(this.em, down);
    this.em.label(leaf);
    // 扁平叶：rep movsb 是 rsi -> rdi；写只读段的字面量是绝对禁止的，
    // 方向反了就会立刻段错误，这里源=数据区、目的=写入点。
    movRR(this.em, R.rdi, R.r12);
    movRDisp(this.em, R.rcx, R.rbx, 16);         // 字节数
    addRR(this.em, R.r12, R.rcx);                // 写入点前移（也是返回值）
    movRR(this.em, R.rsi, R.rbx);
    addRImm(this.em, R.rsi, 串头字节);
    cld(this.em);
    repMovsb(this.em);
    this.em.label(pop);
    cmpRImm(this.em, R.r13, FLAT_STACK);
    jcc(this.em, JCC.be, done);
    // 弹一层是 8 字节，不是一字节：这里曾经误用 decR，
    // 栈指针变成非 8 对齐后读出半截指针，紧接着就是空指针解引用。
    subRImm(this.em, R.r13, 8);
    movRDisp(this.em, R.rbx, R.r13, 0);
    jmp(this.em, down);
    this.em.label(done);
    movRR(this.em, R.rax, R.r12);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
    this.em.label(bad);
    this.loadMsg(this.strConst("运行错误：嵌套层级过深（绳索摊平栈耗尽）\n"));
    jmp(this.em, "rt_fail");
  }

  // rt_flatten: rdi=串对象 -> rax=扁平串对象
  // 扁平返回自身；绳索摊平一次，结果缓存在节点 [40]，此后同一节点 O(1)。
  // 缓存只写进堆上的绳索节点，绝不写只读段里的字面量对象。
  genFlatten() {
    this.em.label("rt_flatten");
    const self = this.em.nl("fl_self");
    const cached = this.em.nl("fl_cached");
    movRDisp(this.em, R.rax, R.rdi, 0);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.ns, self);
    movRDisp(this.em, R.rax, R.rdi, 40);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.nz, cached);
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    movRR(this.em, R.rbx, R.rdi);
    movRDisp(this.em, R.r12, R.rbx, 16);         // 字节数
    movRR(this.em, R.rdi, R.r12);
    addRImm(this.em, R.rdi, 串头字节 + 1);
    call(this.em, "rt_alloc");
    movRR(this.em, R.r13, R.rax);
    xorRR(this.em, R.rdx, R.rdx);
    movDispR(this.em, R.r13, 0, R.rdx);          // [0]=0 扁平
    movRDisp(this.em, R.rdx, R.rbx, 8);
    movDispR(this.em, R.r13, 8, R.rdx);          // 字符数
    movRR(this.em, R.rdx, R.r12);
    movDispR(this.em, R.r13, 16, R.rdx);         // 字节数
    // 尾字节 NUL：rt_alloc 向上对齐到 8，所以 [串头+长度] 一定在分配范围内
    movRR(this.em, R.rax, R.r13);
    addRImm(this.em, R.rax, 串头字节);
    addRR(this.em, R.rax, R.r12);
    movByteImm(this.em, R.rax, 0, 0);
    movRR(this.em, R.rdi, R.rbx);
    movRR(this.em, R.rsi, R.r13);
    addRImm(this.em, R.rsi, 串头字节);
    call(this.em, "rt_flat_into");
    movRR(this.em, R.rdx, R.r13);
    movDispR(this.em, R.rbx, 40, R.rdx);         // 缓存摊平结果
    movRR(this.em, R.rax, R.r13);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
    this.em.label(cached);
    ret(this.em);
    this.em.label(self);
    movRR(this.em, R.rax, R.rdi);
    ret(this.em);
  }

  // rt_concat: rdi=a, rsi=b -> rax=绳索节点
  // 彻底的 O(1) 惰性拼接：不复制任何字节，只造一个 48 字节的节点。
  // 字节数与字符数当场相加，所以「拼接后取长度」不用摊平；
  // 只有真要打印/逐字节比较时才付一次摊平的钱，而每个节点摊平后就缓存。
  // （早先这里靠深度阈值提前摊平，链式拼接退化回 O(n^2)：3000 次拼接
  //   要复制几 MB 字节。摊平成迭代实现之后，深度不再是必须钉住的量。）
  genConcat() {
    this.em.label("rt_concat");
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    pushR(this.em, R.r14);
    movRR(this.em, R.rbx, R.rdi);                // 左对象
    movRR(this.em, R.r12, R.rsi);                // 右对象
    // 长度先行：rdi/rsi 会被后面的调用占掉，所以这里就把两个长度加好
    movRDisp(this.em, R.r13, R.rbx, 16);
    movRDisp(this.em, R.rax, R.r12, 16);
    addRR(this.em, R.r13, R.rax);                // r13 = 字节数（[16]）
    movRDisp(this.em, R.r14, R.rbx, 8);
    movRDisp(this.em, R.rax, R.r12, 8);
    addRR(this.em, R.r14, R.rax);                // r14 = 字符数（[8]）
    movRI64(this.em, R.rdi, BigInt(绳索字节));
    call(this.em, "rt_alloc");                   // rax = 新节点
    movRI64(this.em, R.rdx, -1n);
    movDispR(this.em, R.rax, 0, R.rdx);          // [0]=-1 绳索
    movDispR(this.em, R.rax, 8, R.r14);          // 字符数
    movDispR(this.em, R.rax, 16, R.r13);         // 字节数
    movDispR(this.em, R.rax, 24, R.rbx);         // 左
    movDispR(this.em, R.rax, 32, R.r12);         // 右
    xorRR(this.em, R.rdx, R.rdx);
    movDispR(this.em, R.rax, 40, R.rdx);         // 摊平缓存清空
    popR(this.em, R.r14);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
  }

  // rt_str_len: rdi=串对象 -> rax=字符数（中文按字计数）
  genStrLen() {
    this.em.label("rt_str_len");
    movRDisp(this.em, R.rax, R.rdi, 8);
    ret(this.em);
  }

  // rt_str_eq: rdi=a, rsi=b -> rax=1/0
  genStrEq() {
    this.em.label("rt_str_eq");
    const ne = this.em.nl("eq_ne");
    const loop = this.em.nl("eq_lp");
    const yes = this.em.nl("eq_yes");
    const end = this.em.nl("eq_end");
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    movRR(this.em, R.rbx, R.rdi);
    movRR(this.em, R.r12, R.rsi);
    // 先比长度，不等直接返回
    movRDisp(this.em, R.r13, R.rbx, 16);
    movRDisp(this.em, R.rdx, R.r12, 16);
    cmpRR(this.em, R.r13, R.rdx);
    jcc(this.em, JCC.ne, ne);
    // 两边摊平后逐字节比
    movRR(this.em, R.rdi, R.rbx);
    call(this.em, "rt_flatten");
    movRR(this.em, R.r13, R.rax);
    movRR(this.em, R.rdi, R.r12);
    call(this.em, "rt_flatten");
    movRR(this.em, R.r12, R.rax);
    movRR(this.em, R.rcx, R.r13);
    movRDisp(this.em, R.rcx, R.r13, 16);
    testRR(this.em, R.rcx, R.rcx);
    jcc(this.em, JCC.z, yes);
    movRR(this.em, R.rsi, R.r13);
    addRImm(this.em, R.rsi, 串头字节);
    movRR(this.em, R.rdi, R.r12);
    addRImm(this.em, R.rdi, 串头字节);
    this.em.label(loop);
    loadByteDisp(this.em, R.rax, R.rsi, 0);
    loadByteDisp(this.em, R.rdx, R.rdi, 0);
    cmpRR(this.em, R.rax, R.rdx);
    jcc(this.em, JCC.ne, ne);
    incR(this.em, R.rsi);
    incR(this.em, R.rdi);
    decR(this.em, R.rcx);
    jcc(this.em, JCC.nz, loop);
    this.em.label(yes);
    movRI64(this.em, R.rax, 1n);
    jmp(this.em, end);
    this.em.label(ne);
    xorRR(this.em, R.rax, R.rax);
    this.em.label(end);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
  }

  // rt_int_to_str: rdi=整数 -> rax=扁平串对象
  // 数字倒着填进对象尾部的暂存区，再整体搬到数据区，省掉第二次分配。
  // （暂存区在数据区之后，正向 rep movsb 不会自我覆盖。）
  genIntToStr() {
    this.em.label("rt_int_to_str");
    const pos = this.em.nl("it_pos");
    const loop = this.em.nl("it_lp");
    const done = this.em.nl("it_dn");
    const neg = this.em.nl("it_neg");
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    pushR(this.em, R.r14);
    xorRR(this.em, R.r14, R.r14);             // 1 表示负数
    testRR(this.em, R.rdi, R.rdi);
    jcc(this.em, JCC.ns, pos);
    movRI64(this.em, R.r14, 1n);
    negR(this.em, R.rdi);
    this.em.label(pos);
    movRR(this.em, R.rbx, R.rdi);             // 绝对值
    movRI64(this.em, R.rdi, BigInt(串头字节 + 20 + 1));
    call(this.em, "rt_alloc");
    movRR(this.em, R.r12, R.rax);             // 对象
    movRR(this.em, R.r13, R.r12);
    addRImm(this.em, R.r13, 串头字节 + 20);    // 暂存区末尾，向前写
    testRR(this.em, R.rbx, R.rbx);
    jcc(this.em, JCC.nz, loop);
    decR(this.em, R.r13);
    movByteImm(this.em, R.r13, 0, 0x30);      // 值为 0 -> "0"
    jmp(this.em, done);
    this.em.label(loop);
    testRR(this.em, R.rbx, R.rbx);
    jcc(this.em, JCC.z, done);
    movRR(this.em, R.rax, R.rbx);
    xorRR(this.em, R.rdx, R.rdx);             // 已取绝对值，无符号除法
    movRI64(this.em, R.r10, 10n);
    divR(this.em, R.r10);                     // rax=商 rdx=余
    movRR(this.em, R.rbx, R.rax);
    addRImm(this.em, R.rdx, 48);              // 余数 -> 数字字符
    decR(this.em, R.r13);
    storeByteDisp(this.em, R.r13, 0, R.rdx);
    jmp(this.em, loop);
    this.em.label(done);
    testRR(this.em, R.r14, R.r14);
    jcc(this.em, JCC.z, neg);
    decR(this.em, R.r13);
    movByteImm(this.em, R.r13, 0, 0x2D);      // '-'
    this.em.label(neg);
    // n = 暂存区末尾 - 游标
    movRR(this.em, R.rax, R.r12);
    addRImm(this.em, R.rax, 串头字节 + 20);
    subRR(this.em, R.rax, R.r13);
    movRR(this.em, R.r14, R.rax);             // 保存位数
    xorRR(this.em, R.rdx, R.rdx);
    movDispR(this.em, R.r12, 0, R.rdx);       // [0]=0 扁平
    movDispR(this.em, R.r12, 8, R.r14);       // 字符数（数字全 ASCII）
    movDispR(this.em, R.r12, 16, R.r14);      // 字节数
    movRR(this.em, R.rdi, R.r12);
    addRImm(this.em, R.rdi, 串头字节);        // 目的 = 数据区首
    movRR(this.em, R.rsi, R.r13);             // 源 = 数字起点
    movRR(this.em, R.rcx, R.r14);
    cld(this.em);
    repMovsb(this.em);
    movRR(this.em, R.rax, R.r12);
    popR(this.em, R.r14);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
  }

  // ---- 列表对象：[0]=长度 [8]=容量 [16]=数据指针（每元素 8 字节）----
  // rt_list_new: rdi=预留容量 -> rax=表
  genListNew() {
    this.em.label("rt_list_new");
    const cap = this.em.nl("ln_cap");
    testRR(this.em, R.rdi, R.rdi);
    jcc(this.em, JCC.g, cap);
    movRI64(this.em, R.rdi, 8n);
    this.em.label(cap);
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    movRR(this.em, R.rbx, R.rdi);             // 容量
    movRI64(this.em, R.rdi, BigInt(列表头字节));
    call(this.em, "rt_alloc");
    movRR(this.em, R.r12, R.rax);             // 表头
    movRR(this.em, R.rdi, R.rbx);
    shlRImm(this.em, R.rdi, 3);               // 容量 * 8
    call(this.em, "rt_alloc");
    movDispR(this.em, R.r12, 16, R.rax);      // 数据区
    xorRR(this.em, R.rdx, R.rdx);
    movDispR(this.em, R.r12, 0, R.rdx);       // 长度 = 0
    movDispR(this.em, R.r12, 8, R.rbx);       // 容量
    movRR(this.em, R.rax, R.r12);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    ret(this.em);
  }

  // rt_list_append: rdi=表, rsi=值 -> rax=表（扩容后表头地址不变，可安全写回）
  genListAppend() {
    this.em.label("rt_list_append");
    const fit = this.em.nl("la_fit");
    movRDisp(this.em, R.rax, R.rdi, 0);
    cmpRDisp(this.em, R.rax, R.rdi, 8);
    jcc(this.em, JCC.l, fit);
    // 容量不足：翻倍并整体搬迁。值先藏进 r13，避免被 rep movsb 的寄存器打乱。
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);
    pushR(this.em, R.r14);
    movRR(this.em, R.rbx, R.rdi);
    movRR(this.em, R.r13, R.rsi);
    movRDisp(this.em, R.r12, R.rbx, 8);
    shlRImm(this.em, R.r12, 1);               // 新容量 = 旧 * 2
    movRR(this.em, R.rdi, R.r12);
    shlRImm(this.em, R.rdi, 3);
    call(this.em, "rt_alloc");
    movRR(this.em, R.r14, R.rax);             // 新数据区
    movRDisp(this.em, R.rsi, R.rbx, 16);      // 旧数据区
    movRR(this.em, R.rdi, R.r14);
    movRDisp(this.em, R.rcx, R.rbx, 0);
    shlRImm(this.em, R.rcx, 3);               // 长度 * 8 字节
    cld(this.em);
    repMovsb(this.em);
    movDispR(this.em, R.rbx, 16, R.r14);
    movDispR(this.em, R.rbx, 8, R.r12);
    movRR(this.em, R.rdi, R.rbx);
    movRR(this.em, R.rsi, R.r13);
    popR(this.em, R.r14);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    this.em.label(fit);
    // 注意：rdi 必须是表对象。扩容分支里 rdi 被 rt_alloc 改写过了，
    // 所以两条路都要在这里把「表」重新装回 rdi，否则元素会写进错误的列表。
    movRR(this.em, R.rcx, R.rdi);              // rcx = 表
    movRDisp(this.em, R.rax, R.rdi, 0);        // 长度
    movRDisp(this.em, R.rdx, R.rdi, 16);       // 数据基址
    movIdxStore(this.em, R.rdx, R.rax, R.rsi); // data[len] = 值
    incR(this.em, R.rax);
    movDispR(this.em, R.rcx, 0, R.rax);
    movRR(this.em, R.rax, R.rcx);
    ret(this.em);
  }

  // rt_list_get: rdi=表, rsi=下标 -> rax=元素。越界直接报中文错误。
  genListGet() {
    this.em.label("rt_list_get");
    const ok = this.em.nl("lg_ok");
    const load = this.em.nl("lg_load");
    movRR(this.em, R.rax, R.rsi);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.ns, ok);
    movRDisp(this.em, R.rcx, R.rdi, 0);       // 负下标 = 长度 + 下标
    addRR(this.em, R.rax, R.rcx);
    this.em.label(ok);
    movRDisp(this.em, R.rcx, R.rdi, 0);
    cmpRR(this.em, R.rax, R.rcx);
    jcc(this.em, JCC.b, load);
    this.loadMsg(this.strConst("运行错误：列表下标越界\n"));
    jmp(this.em, "rt_fail");
    this.em.label(load);
    movRDisp(this.em, R.rdx, R.rdi, 16);
    movIdxLoad(this.em, R.rax, R.rdx, R.rax);
    ret(this.em);
  }

  // rt_list_set: rdi=表, rsi=下标, rdx=值
  genListSet() {
    this.em.label("rt_list_set");
    const ok = this.em.nl("ls_ok");
    const store = this.em.nl("ls_store");
    movRR(this.em, R.rax, R.rsi);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.ns, ok);
    movRDisp(this.em, R.rcx, R.rdi, 0);
    addRR(this.em, R.rax, R.rcx);
    this.em.label(ok);
    movRDisp(this.em, R.rcx, R.rdi, 0);
    cmpRR(this.em, R.rax, R.rcx);
    jcc(this.em, JCC.b, store);
    this.loadMsg(this.strConst("运行错误：列表下标越界\n"));
    jmp(this.em, "rt_fail");
    this.em.label(store);
    // 值在 rdx（契约：rdi=表 rsi=下标 rdx=值）。取数据基址必须用别的寄存器，
    // 之前直接 mov rdx,[rdi+16] 把待写入的值覆盖成数据指针，
    // 结果 data[idx] = 下标，列表内容被静默写坏。
    movRR(this.em, R.rcx, R.rdx);              // rcx = 值
    movRDisp(this.em, R.rdx, R.rdi, 16);       // 数据基址
    movIdxStore(this.em, R.rdx, R.rax, R.rcx);
    ret(this.em);
  }

  // rt_list_len: rdi=表 -> rax=长度
  genListLen() {
    this.em.label("rt_list_len");
    movRDisp(this.em, R.rax, R.rdi, 0);
    ret(this.em);
  }

  // rt_print_str: rdi = 串对象（字面量或绳索都走这条路）
  // 先摊平（字面量本身就是扁平串，摊平是空操作；绳索摊平一次后缓存），
  // 再按 [16] 的字节数定长写出——不再 strlen 扫描，所以头部 24 字节
  // 的对象前缀不会被当成数据打出去。
  genPrintStr() {
    this.em.label("rt_print_str");
    pushR(this.em, R.rbx);
    movRR(this.em, R.rbx, R.rdi);
    call(this.em, "rt_flatten");
    movRDisp(this.em, R.rdx, R.rax, 16);        // 字节数
    movRR(this.em, R.rsi, R.rax);
    addRImm(this.em, R.rsi, 串头字节);          // 数据起点
    movRI64(this.em, R.rdi, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);
    popR(this.em, R.rbx);
    ret(this.em);
  }

  // rt_print_int: rdi = int64
  genPrintInt() {
    this.em.label("rt_print_int");
    pushR(this.em, R.rbp);
    movRR(this.em, R.rbp, R.rsp);
    pushR(this.em, R.rbx);
    pushR(this.em, R.r12);
    pushR(this.em, R.r13);

    movRR(this.em, R.rbx, R.rdi);        // rbx = value
    subRsp(this.em, 32);                  // 32 字节缓冲区

    // 处理 0
    testRR(this.em, R.rbx, R.rbx);
    const nonzero = this.em.nl("pi_nz");
    const done0 = this.em.nl("pi_d0");
    jcc(this.em, JCC.ne, nonzero);
    // 输出 "0"
    this.em.bs([0xC6, 0x44, 0x24, 0, 0x30]); // mov byte [rsp], '0'
    movRI64(this.em, R.rdi, 1n);
    movRR(this.em, R.rsi, R.rsp);
    movRI64(this.em, R.rdx, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);
    jmp(this.em, done0);

    this.em.label(nonzero);
    // 处理负数
    testRR(this.em, R.rbx, R.rbx);
    const positive = this.em.nl("pi_pos");
    jcc(this.em, JCC.ns, positive);
    negR(this.em, R.rbx);                 // 绝对值
    // 输出 '-'
    this.em.bs([0xC6, 0x44, 0x24, 0, 0x2D]);
    movRI64(this.em, R.rdi, 1n);
    movRR(this.em, R.rsi, R.rsp);
    movRI64(this.em, R.rdx, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);
    this.em.label(positive);

    // 转换：从 rsp+31 往前填
    xorRR(this.em, R.r13, R.r13);         // r13 = 位数 = 0
    const convLoop = this.em.nl("pi_cl");
    const convDone = this.em.nl("pi_cd");
    this.em.label(convLoop);
    testRR(this.em, R.rbx, R.rbx);
    jcc(this.em, JCC.z, convDone);

    // 必须用无符号除法：INT64_MIN 取负还是 0x8000000000000000，
    // 它的无符号位型正好就是 2^63（真正的绝对值）。用 idiv 会把
    // 它当负数继续除，余数为负，加 '0' 后写出一串垃圾字符。
    movRR(this.em, R.rax, R.rbx);
    xorRR(this.em, R.rdx, R.rdx);
    movRI64(this.em, R.r10, 10n);
    divR(this.em, R.r10);                // rax=quot, rdx=rem（无符号）
    movRR(this.em, R.rbx, R.rax);         // rbx = quot

    // dl += '0'
    movRI64(this.em, R.rax, 48n);
    addRR(this.em, R.rdx, R.rax);         // rdx = rem + '0'

    // 存到 [rsp + 31 - r13]
    movRR(this.em, R.rax, R.rsp);
    movRI64(this.em, R.rcx, 31n);
    addRR(this.em, R.rax, R.rcx);
    subRR(this.em, R.rax, R.r13);
    // mov [rax], dl
    this.em.bs([0x88, 0x10]);
    incR(this.em, R.r13);
    jmp(this.em, convLoop);
    this.em.label(convDone);

    // 输出: 起始 = rsp + 32 - r13, 长度 = r13
    // （数字存在 [rsp+31-i], i=0..r13-1，最高位在 i=r13-1 -> [rsp+32-r13]）
    movRR(this.em, R.rsi, R.rsp);
    movRI64(this.em, R.rcx, 32n);
    addRR(this.em, R.rsi, R.rcx);
    subRR(this.em, R.rsi, R.r13);
    movRR(this.em, R.rdx, R.r13);
    movRI64(this.em, R.rdi, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);

    this.em.label(done0);
    this.finishPrintInt();
  }

  finishPrintInt() {
    addRsp(this.em, 32);
    popR(this.em, R.r13);
    popR(this.em, R.r12);
    popR(this.em, R.rbx);
    popR(this.em, R.rbp);
    ret(this.em);
  }

  genPrintNl() {
    this.em.label("rt_print_nl");
    pushR(this.em, R.rax);
    pushR(this.em, R.rdi);
    pushR(this.em, R.rsi);
    pushR(this.em, R.rdx);
    pushR(this.em, R.rcx);
    subRsp(this.em, 16);
    this.em.bs([0xC6, 0x04, 0x24, 0x0A]); // mov byte [rsp], '\n'
    movRI64(this.em, R.rdi, 1n);
    movRR(this.em, R.rsi, R.rsp);
    movRI64(this.em, R.rdx, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);
    addRsp(this.em, 16);
    popR(this.em, R.rcx);
    popR(this.em, R.rdx);
    popR(this.em, R.rsi);
    popR(this.em, R.rdi);
    popR(this.em, R.rax);
    ret(this.em);
  }

  genPrintSpace() {
    this.em.label("rt_print_space");
    pushR(this.em, R.rax);
    pushR(this.em, R.rdi);
    pushR(this.em, R.rsi);
    pushR(this.em, R.rdx);
    pushR(this.em, R.rcx);
    subRsp(this.em, 16);
    this.em.bs([0xC6, 0x04, 0x24, 0x20]); // mov byte [rsp], ' '
    movRI64(this.em, R.rdi, 1n);
    movRR(this.em, R.rsi, R.rsp);
    movRI64(this.em, R.rdx, 1n);
    movRI64(this.em, R.rax, 1n);
    syscall(this.em);
    addRsp(this.em, 16);
    popR(this.em, R.rcx);
    popR(this.em, R.rdx);
    popR(this.em, R.rsi);
    popR(this.em, R.rdi);
    popR(this.em, R.rax);
    ret(this.em);
  }

  // ---- 数据段 ----
  strConst(s) {
    if (this.strLabelMap.has(s)) return this.strLabelMap.get(s);
    const lbl = `DSTR_${this.strLabelMap.size}`;
    this.strLabelMap.set(s, lbl);
    const body = Buffer.from(s, "utf8");
    const buf = Buffer.alloc(串头字节 + body.length + 1);
    buf.writeBigInt64LE(0n, 0);                             // [0]=0 -> 扁平
    buf.writeBigInt64LE(BigInt(Array.from(s).length), 8);   // 字符数：中文一字一符
    buf.writeBigInt64LE(BigInt(body.length), 16);           // 字节数
    body.copy(buf, 串头字节);
    buf[串头字节 + body.length] = 0;
    this.rodata.push({ label: lbl, data: buf });
    return lbl;
  }
  buildData() {
    const labelOff = new Map();
    let offset = 0;
    for (const d of this.rodata) {
      labelOff.set(d.label, offset);
      offset += d.data.length;
    }
    const aligned = (offset + 7) & ~7;
    const buf = Buffer.alloc(aligned);
    let pos = 0;
    for (const d of this.rodata) {
      d.data.copy(buf, pos);
      pos += d.data.length;
    }
    return { buf, labelOff };
  }

  // ---- 类型 ----
  kindFromAnnotation(a) {
    if (a === "整数") return "int";
    // 布尔是一等类型，不是整数别名：宿主 类型(真)="布尔"、打印「真/假」，
    // 且 整数 x = 真 报「类型错误（变量声明）：期望 整数，得到 布尔」。
    // 0.1.16 审计实测旧后端把 布尔 当 int：输出 真 静默打成 1（值错，红线），
    // 布尔 开关 = 1 又毫无守卫（该拒未拒）。现在引入独立 "bool" 种类：
    // 打印走 rt_print_bool；布尔与整数在声明/赋值/算术处混用一律编译期拒绝，
    // 由启动器兜底走解释器（解释器的布尔语义已逐字对齐宿主）。
    if (a === "布尔") return "bool";
    // 浮点标注一律拒绝编译，走解释器兜底。以前返回 "double" 会一路漏到
    // rt_print_int / rt_int_to_str，那两条只认整数：浮点变量声明后
    // 要么被 cvttsd2si 截成整数，要么在打印处吐出垃圾字节 —— 静默算错。
    // 字面量那条（genLiteral）已经拦住了，声明这条路必须同样拦住。
    if (a === "浮点")
      throw new Error("直接机器码暂不支持浮点（改走解释器兜底，结果正确只是慢）");
    if (a === "字符串") return "str";
    if (a === "列表") return "list";
    if (a === "字典") return "dict";
    return "none";
  }

  // ---- 函数生成（两段式：先收集主体，再插入栈帧） ----
  genFunc(st) {
    const lbl = this.funcLabelMap.get(st.名字);
    // 参数先占槽，再是体内的声明；tempBase 必须覆盖两者之和，
    // 否则临时槽会和变量槽撞格（见 FuncCtx 上方注释）。
    const ctx = new FuncCtx(st.参数.length + 统计声明数(st.体));
    ctx.retKind = this.kindFromAnnotation(st.返回类型);

    // 在独立的子 emitter 中生成函数主体
    const savedEm = this.em;
    this.em = new Emitter();
    // 复制标签位置（运行时函数的标签在主 emitter 中）
    // 但 call 指令需要能解析到主 emitter 的标签
    // 问题：子 emitter 的 fixup 需要在主 emitter 中解析
    
    // 更简单的方案：不用子 emitter，直接在主 emitter 上生成
    // 栈帧问题用"先占位后回填"解决
    
    this.em = savedEm; // 恢复
    // 在主 emitter 上打函数标签
    this.em.label(lbl);

    // 序言开始：push rbp; mov rbp, rsp
    pushR(this.em, R.rbp);
    movRR(this.em, R.rbp, R.rsp);
    // 占位：sub rsp, N —— 我们在后面回填
    // 占位 4 字节（sub rsp, imm32 是 7 字节：48 81 EC + 4字节）
    const subRspPos = this.em.pos;
    this.em.bs([0x48, 0x81, 0xEC, 0, 0, 0, 0]); // 占位 7 字节

    // 栈溢出探测：递归太深时给一句中文错误，而不是裸 SIGSEGV(139)。
    // 必须在「参数入槽」之前、且实参寄存器一个都不能碰：这里只用 rax
    // （此刻是 caller-saved 空槽）。失败分支里 loadMsg 会写 rdi，
    // 但那条路直接 jmp rt_fail 退出、永不返回，所以不影响快路径的实参。
    // 探测点在 sub rsp 之后，比的是「本帧最低处」，不会晚一页才发觉。
    const 栈OK = this.em.nl("sg_ok");
    movRR(this.em, R.rax, R.rsp);
    cmpRAbs(this.em, R.rax, STACK_FLOOR);       // rax > [floor] ?
    jcc(this.em, JCC.a, 栈OK);
    // 冷路径：全程序共享一个出口（见 genRuntime 里的 rt_stack_fail），
    // 不在每个序言里就地展开取消息地址——实测内联的 movabs 插在
    // 序言与循环体之间会拖慢热循环（1e7 累加 19.7ms → 22.5ms）。
    jmp(this.em, "rt_stack_fail");
    this.em.label(栈OK);

    // 参数存栈槽
    let ireg = 0;
    // 默认参数：直弹后端过去完全忽略 st.参数默认，少传实参时那个槽是
    // 【未初始化栈内存】——实测 f(1) 打出 536870945、rc=0。宿主更干脆：
    // 它连这个语法都不接受（「期望 ')'，得到 '='」），只有自举解释器支持。
    // 所以这里编译期拒绝、交回解释器兜底（结果与 eval/vm 一致）。
    if ((st.参数默认 || []).some((d) => d != null))
      throw new Error(`直接机器码暂不支持默认参数（${st.名字}），改走解释器兜底`);
    const paramKinds = st.参数.map((_, i) => {
      const 宣 = (st.参数类型 && st.参数类型[i]) || "";
      // 可变参数在直弹后端没有打包语义：宿主把它做成列表，
      // 这里只能拒绝，绝不能按普通整数槽收下来静默少收参数。
      if (宣 === "可变")
        throw new Error(`直接机器码暂不支持可变参数（${st.名字} 的第 ${i + 1} 个形参），改走解释器兜底`);
      return this.kindFromAnnotation(宣);
    });
    st.参数.forEach((pname, i) => {
      const k = paramKinds[i];
      const off = ctx.allocVar(pname, k);
      if (k !== "double") {
        movMemR(this.em, off, ARG_REGS[ireg]);
        ireg++;
      }
    });

    // 生成函数体前先把【声明】种类登记一次：自递归调用点在自己体内出现时
    // 还测不到实际返回值，先按声明处理（斐(n-1) 这类整数递归不受影响）。
    this.funcRetKinds.set(lbl, ctx.retKind === "none" ? "int" : ctx.retKind);
    ctx.返回种类 = [];

    // 生成函数体
    for (const s of st.体.语句) this.genStmt(s, ctx);

    // 隐式返回
    movRI64(this.em, R.rax, 0n);
    leave(this.em);
    ret(this.em);

    // 回填 sub rsp, N
    const N = ctx.stackSize();
    this.em.bytes[subRspPos + 3] = N & 0xFF;
    this.em.bytes[subRspPos + 4] = (N >> 8) & 0xFF;
    this.em.bytes[subRspPos + 5] = (N >> 16) & 0xFF;
    this.em.bytes[subRspPos + 6] = (N >> 24) & 0xFF;

    // 体内实测种类：没有标注时调用点要用它，否则字符串/列表返回值会被
    // 当整数处理（打堆地址）。多种类直接拒绝——宁可不编。
    const 实测 = ctx.返回种类.length === 0 ? null : ctx.返回种类[0];
    for (const k of ctx.返回种类) {
      if (k !== 实测)
        throw new Error(`直接机器码要求函数 ${st.名字} 各条 返回 的种类一致（实测有 ${实测} 与 ${k}），改走解释器兜底`);
    }
    if (实测 !== null) this.funcRetKinds.set(lbl, 实测);
  }

  // ---- co_main ----
  genCoMain() {
    const topStmts = this.ast.语句.filter(s => s.类型 !== "函数定义");
    const ctx = new FuncCtx(统计声明数(topStmts));
    ctx.retKind = "none";
    this.em.label("co_main");

    pushR(this.em, R.rbp);
    movRR(this.em, R.rbp, R.rsp);
    const subRspPos = this.em.pos;
    this.em.bs([0x48, 0x81, 0xEC, 0, 0, 0, 0]); // 占位

    for (const st of topStmts) this.genStmt(st, ctx);

    // co_main 返回 0
    movRI64(this.em, R.rax, 0n);
    leave(this.em);
    ret(this.em);

    // 回填
    const N = ctx.stackSize();
    this.em.bytes[subRspPos + 3] = N & 0xFF;
    this.em.bytes[subRspPos + 4] = (N >> 8) & 0xFF;
    this.em.bytes[subRspPos + 5] = (N >> 16) & 0xFF;
    this.em.bytes[subRspPos + 6] = (N >> 24) & 0xFF;
  }

  // ---- 语句 ----
  genStmt(st, ctx) {
    if (st == null) return;
    switch (st.类型) {
      case "变量声明": this.genVarDecl(st, ctx); break;
      case "赋值": this.genAssign(st, ctx); break;
      case "返回": this.genReturn(st, ctx); break;
      case "如果": this.genIf(st, ctx); break;
      case "当": this.genWhile(st, ctx); break;
      case "对于": this.genFor(st, ctx); break;
      case "跳出": jmp(this.em, ctx.breakEnds[ctx.breakEnds.length - 1]); break;
      case "继续": jmp(this.em, ctx.contHeads[ctx.contHeads.length - 1]); break;
      case "函数调用": this.genCall(st, ctx); break;
      default:
        if (["二元","一元","字面量","标识符","下标","列表字面量","字典字面量"].includes(st.类型))
          this.genExpr(st, ctx);
    }
  }

  genVarDecl(st, ctx) {
    let kind = this.kindFromAnnotation(st.类型标注);
    if (st.初始化 != null) {
      const k = this.genExpr(st.初始化, ctx);
      if (kind === "none") kind = k;
      const off = ctx.allocVar(st.名字, kind);
      this.storeToSlot(off, k, kind);
    } else {
      if (kind === "none") kind = "int";
      const off = ctx.allocVar(st.名字, kind);
      movRI64(this.em, R.rax, 0n);
      movMemR(this.em, off, R.rax);
    }
  }

  storeToSlot(off, fromK, toK) {
    // 布尔与整数是两个类型（宿主实测：整数 x = 真 → 「类型错误（变量声明）：
    // 期望 整数，得到 布尔」；布尔 b = 1 同样被拒）。底层同为 0/1 不代表可以
    // 静默互转——那正是 0.1.16 审计里「编得过但守卫缺失」的一类。编译期拒绝，
    // 启动器兜底走解释器，由解释器给出逐字对齐宿主的报错。
    if (toK === "bool" && fromK === "int")
      throw new Error("直接机器码拒绝 整数→布尔 隐式转换（宿主本就报类型错误，改走解释器兜底给出准确报错）");
    if (toK === "int" && fromK === "bool")
      throw new Error("直接机器码拒绝 布尔→整数 隐式转换（宿主本就报类型错误，改走解释器兜底给出准确报错）");
    // 其余跨种类一律拒绝：声明的类型就是槽位的解释方式，错种类塞进去
    // 不会报错，只会在读的时候按错的方式解释。0.1.16 审计实测两条都是 rc=0：
    //   布尔 x = "甲"  -> 字符串指针进 bool 槽，打印恒为「真」
    //   整数 x = "甲"  -> 同上，按整数拆位打印出堆地址
    // 宿主对这两种都给「类型错误（变量声明）：期望 X，得到 Y」。
    const 种类名 = { int: "整数", bool: "布尔", str: "字符串", list: "列表", dict: "字典" };
    if (fromK !== toK && 种类名[toK] && 种类名[fromK])
      throw new Error(`直接机器码拒绝 ${种类名[fromK]}→${种类名[toK]} 赋值（宿主报「类型错误（变量声明/赋值）：期望 ${种类名[toK]}，得到 ${种类名[fromK]}」，改走解释器兜底）`);
    if (fromK === toK) {
      movMemR(this.em, off, R.rax);
      return;
    }
    if (fromK === "int" && toK === "double") {
      // cvtsi2sd xmm0, rax
      this.em.bs([0xF2, 0x0F, 0x2A, 0xC0]);
      // movsd [rbp+off], xmm0
      this.em.bs([0xF2, 0x0F, 0x11]); this.em.b(modrm(1, 0, R.rbp&7)); this.em.i8(off);
    } else if (fromK === "double" && toK === "int") {
      // cvttsd2si rax, xmm0
      this.em.bs([0xF2, 0x0F, 0x2C, 0xC0]);
      movMemR(this.em, off, R.rax);
    } else {
      movMemR(this.em, off, R.rax);
    }
  }

  genAssign(st, ctx) {
    if (st.目标.类型 === "标识符") {
      const { off, kind } = ctx.slotOff(st.目标.名字);
      const k = this.genExpr(st.值, ctx);
      this.storeToSlot(off, k, kind);
      return;
    }
    // 表[下标] = 值 —— 越界由 rt_list_set 报中文错误，不在生成器里复制一份边界逻辑
    if (st.目标.类型 === "下标") {
      const { 容器, 索引 } = st.目标;
      if (容器.类型 !== "标识符") throw new Error("原生赋值目标暂只支持 变量[下标]");
      const { off, kind } = ctx.slotOff(容器.名字);
      if (kind !== "list") throw new Error("只有列表支持下标赋值");
      const k = this.genExpr(索引, ctx);
      if (k === "double") throw new Error("列表下标必须是整数");
      const 下标槽 = ctx.newTemp();
      movMemR(this.em, 下标槽, R.rax);
      const vk = this.genExpr(st.值, ctx);
      if (vk === "double") throw new Error("列表元素暂不支持浮点");
      if (vk === "str" || vk === "bool" || vk === "list" || vk === "dict")
        throw new Error(`直接机器码列表只存裸整数（无类型标签）：${vk === "str" ? "字符串" : vk === "bool" ? "布尔" : "容器"} 写入后会被当成整数读出并打印堆地址，改走解释器兜底`);
      const 值槽 = ctx.newTemp();
      movMemR(this.em, 值槽, R.rax);
      movRMem(this.em, R.rdi, off);
      movRMem(this.em, R.rsi, 下标槽);
      movRMem(this.em, R.rdx, 值槽);
      call(this.em, "rt_list_set");
      ctx.releaseTemp(2);
      return;
    }
    throw new Error(`不支持的赋值目标: ${st.目标.类型}`);
  }

  genReturn(st, ctx) {
    if (st.值 != null) {
      const k = this.genExpr(st.值, ctx);
      if (ctx.返回种类) ctx.返回种类.push(k);
      // 声明了返回类型，体内就必须给出同一种类（宿主的 类型错误（返回语句））。
      // 直弹过去完全不检查：实测 函数 g() -> 字符串 { 返回 1 } 编过并 rc=0，
      // 调用点按字符串处理一个整数 → 打堆地址/读坏内存。
      if (ctx.retKind !== "none" && ctx.retKind !== k) {
        if ((ctx.retKind === "int" && k === "bool") || (ctx.retKind === "bool" && k === "int"))
          throw new Error(`直接机器码拒绝 函数返回 布尔/整数 互转（宿主报「类型错误（返回语句）：期望 ${ctx.retKind}，得到 ${k === "bool" ? "布尔" : "整数"}」，改走解释器兜底）`);
        throw new Error(`直接机器码拒绝 返回种类 ${k} 与声明的返回类型不符（宿主报「类型错误（返回语句）」，改走解释器兜底）`);
      }
      if (ctx.retKind === "double" && k !== "double") {
        if (k === "int") this.em.bs([0xF2, 0x0F, 0x2A, 0xC0]);
      } else if (ctx.retKind !== "double" && k === "double") {
        this.em.bs([0xF2, 0x0F, 0x2C, 0xC0]);
      }
    } else {
      movRI64(this.em, R.rax, 0n);
    }
    leave(this.em);
    ret(this.em);
  }

  genIf(st, ctx) {
    const elseL = this.em.nl("if_else");
    const endL = this.em.nl("if_end");
    const k = this.genExpr(st.条件, ctx);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.z, elseL);
    for (const s of st.则体) this.genStmt(s, ctx);
    jmp(this.em, endL);
    this.em.label(elseL);
    for (const br of st.否则链) {
      if (br.条件 != null) {
        const nextL = this.em.nl("elif");
        this.genExpr(br.条件, ctx);
        testRR(this.em, R.rax, R.rax);
        jcc(this.em, JCC.z, nextL);
        for (const s of br.体) this.genStmt(s, ctx);
        jmp(this.em, endL);
        this.em.label(nextL);
      } else {
        for (const s of br.体) this.genStmt(s, ctx);
      }
    }
    this.em.label(endL);
  }

  genWhile(st, ctx) {
    const head = this.em.nl("wh_hd");
    const end = this.em.nl("wh_ed");
    ctx.breakEnds.push(end);
    ctx.contHeads.push(head);
    this.em.label(head);
    this.genExpr(st.条件, ctx);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.z, end);
    for (const s of st.体) this.genStmt(s, ctx);
    jmp(this.em, head);
    this.em.label(end);
    ctx.breakEnds.pop();
    ctx.contHeads.pop();
  }

  genFor(st, ctx) {
    if (st.是否遍历 === 1) throw new Error("for-each 不支持直接模式");
    const head = this.em.nl("for_hd");
    const cont = this.em.nl("for_ct");
    const end = this.em.nl("for_ed");
    const neg = this.em.nl("for_ng");
    const body = this.em.nl("for_bd");

    // 宿主对 对于 的三条边界都要求数字（「循环起点/终点/步长 需要数字参数，
    // 收到 X」）。直接后端是静态整数循环，边界是字符串/列表/字典时在编译期
    // 拒绝，绝不能像 0.1.16 审计实测那样把字符串指针当整数比较照常跑
    // （对于 i 从 1 到 "十" 循环 打出 1..43，值错 + 该拒未拒）。
    // 浮点同样早在生成器里就编译期拒绝；布尔宿主允许当数字用（真=1），
    // 这里同样按 0/1 走整数通道，与宿主一致。
    const 检边界 = (k, 谁) => {
      if (k === "str" || k === "list" || k === "dict")
        throw new Error(`循环${谁} 需要数字参数，收到 ${k === "str" ? "字符串" : k === "list" ? "列表" : "字典"}（直接机器码拒绝，改走解释器兜底给出与宿主一致的报错）`);
    };

    // 初始化
    const sK = this.genExpr(st.起点, ctx);
    检边界(sK, "起点");
    const vOff = ctx.allocVar(st.变量, "int");
    this.storeToSlot(vOff, sK, "int");
    // 终点槽
    const eK = this.genExpr(st.终点, ctx);
    检边界(eK, "终点");
    const eSlot = ctx.newTemp();
    movMemR(this.em, eSlot, R.rax);
    // 步长槽
    let stepSlot;
    if (st.步长 != null) {
      const pK = this.genExpr(st.步长, ctx);
      检边界(pK, "步长");
      stepSlot = ctx.newTemp();
      movMemR(this.em, stepSlot, R.rax);
    } else {
      stepSlot = ctx.newTemp();
      movRI64(this.em, R.rax, 1n);
      movMemR(this.em, stepSlot, R.rax);
    }

    ctx.breakEnds.push(end);
    ctx.contHeads.push(cont);

    // 步长为 0 必须报错退出，而不是进死循环。宿主在 循环步长不能为 0 处
    // 直接终止；这里在循环头做一次比较，冷路径共享出口，不拖慢热路径。
    // 字面量 0 步长在编译期就拒绝，省掉运行时的两条指令。
    if (st.步长 != null && st.步长.类型 === "字面量" &&
        (st.步长.字面类型 === "整数" || st.步长.字面类型 === "布尔") &&
        BigInt(st.步长.值) === 0n)
      throw new Error("循环步长不能为 0（直接机器码编译期拒绝，与宿主报错同文案）");
    const stpok = this.em.nl("for_stok");
    movRMem(this.em, R.rax, stepSlot);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.nz, stpok);
    call(this.em, "rt_step_zero");   // 用 call 保持栈帧（rt_fail 会 exit，不返回）
    this.em.label(stpok);

    this.em.label(head);
    // 步长符号
    movRMem(this.em, R.rax, stepSlot);
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.s, neg);
    // 正步长: var <= end ?
    movRMem(this.em, R.rax, vOff);
    movRMem(this.em, R.r10, eSlot);
    cmpRR(this.em, R.rax, R.r10);
    jcc(this.em, JCC.g, end);
    jmp(this.em, body);
    // 负步长: var >= end ?
    this.em.label(neg);
    movRMem(this.em, R.rax, vOff);
    movRMem(this.em, R.r10, eSlot);
    cmpRR(this.em, R.rax, R.r10);
    jcc(this.em, JCC.l, end);

    this.em.label(body);
    for (const s of st.体) this.genStmt(s, ctx);

    this.em.label(cont);
    movRMem(this.em, R.rax, vOff);
    movRMem(this.em, R.r10, stepSlot);
    addRR(this.em, R.rax, R.r10);
    movMemR(this.em, vOff, R.rax);
    jmp(this.em, head);

    this.em.label(end);
    ctx.breakEnds.pop();
    ctx.contHeads.pop();
    ctx.releaseTemp(2);
  }

  // ---- 函数调用 ----
  genCall(st, ctx) {
    const name = st.被调者.类型 === "标识符" ? st.被调者.名字 : null;
    if (name === "输出") { this.genPrint(st.参数, ctx); return "none"; }
    if (name === "长度" && st.参数.length === 1) return this.genBuiltinLen(st.参数[0], ctx);
    if (name === "转字符串" && st.参数.length === 1) return this.genBuiltinStr(st.参数[0], ctx);
    if (name === "追加" && st.参数.length === 2) return this.genBuiltinAppend(st.参数, ctx);

    const lbl = this.funcLabelMap.get(name);
    if (!lbl) throw new Error(`未定义函数: ${name}`);
    const 签名 = this.funcSigs.get(lbl);
    // 实参个数：宿主在执行期报「参数个数不符」，直弹是静态调用，
    // 少传的参数槽会是【未初始化内存】——比报错更糟，编译期就拒。
    if (签名) {
      const 最少 = 签名.数 - 签名.默认数;
      const 最多 = 签名.有可变 ? Infinity : 签名.数;
      if (st.参数.length < 最少 || st.参数.length > 最多)
        throw new Error(`函数 ${name} 需要 ${最少}${签名.有可变 ? "+" : (签名.默认数 ? "~" + 签名.数 : "")} 个参数，收到 ${st.参数.length} 个（直弹静态分派，缺参槽是未初始化内存）`);
    }

    // 实参求值存槽
    const argSlots = [];
    let 参数序号 = 0;
    for (const a of st.参数) {
      const k = this.genExpr(a, ctx);
      const 落槽 = () => {
        const sl = ctx.newTemp();
        movMemR(this.em, sl, R.rax);
        argSlots.push({ kind: k, slot: sl });
      };
      if (签名) {
        const 期望 = 签名.参[参数序号];
        if (期望 === "可变") { 参数序号++; 落槽(); continue; }
        // 布尔/整数、字符串/整数 混传在宿主是运行期「类型错误（函数参数）」，
        // 直弹这边槽位种类是编译期定死的，静默塞进去就是「算得过但错」。
        if ((期望 === "int" && k === "bool") || (期望 === "bool" && k === "int"))
          throw new Error(`直接机器码拒绝 函数 ${name} 第 ${参数序号 + 1} 个参数 布尔/整数 互转（宿主报「类型错误（函数参数）」，改走解释器兜底）`);
        if (期望 === "str" && k !== "str" && k !== "none")
          throw new Error(`直接机器码拒绝 向字符串参数传 ${k}（宿主报「类型错误（函数参数）」，改走解释器兜底）`);
        if ((期望 === "list" || 期望 === "dict") && k !== 期望 && k !== "none")
          throw new Error(`直接机器码拒绝 向 ${期望} 参数传 ${k}（宿主报「类型错误（函数参数）」，改走解释器兜底）`);
      }
      落槽();
      参数序号++;
    }
    // 传参到寄存器
    let ireg = 0;
    for (const a of argSlots) {
      movRMem(this.em, ARG_REGS[ireg], a.slot);
      ireg++;
    }
    call(this.em, lbl);
    ctx.releaseTemp(argSlots.length);
    // 调用点的返回值种类：声明了就按声明（genReturn 已经保证体内 返回 与声明
    // 同种类，异种会编译期拒绝）；没声明就按【体内实测】的种类。
    // 以前这里一律 `|| "int"`，于是 函数 取首() { 返回 "甲" } 的字符串对象
    // 被当整数打印成堆地址 4197016、rc=0——0.1.16 审计实测。
    const 声明返回 = 签名 ? 签名.返 : "none";
    if (声明返回 !== "none" && 声明返回 !== "int" && 声明返回 !== "bool") return 声明返回;
    if (声明返回 === "str" || 声明返回 === "list" || 声明返回 === "dict") return 声明返回;
    return this.funcRetKinds.get(lbl) || "int";
  }

  // 长度(串|表) -> 字符数 / 元素个数（两者都是对象 [0 或 8] 里现成的数）
  // 列表取 [0]=长度，字符串取 [8]=字符数：按编译期已知的种类分派，
  // 不在运行时靠 magic 数嗅探，语义写错时是编译期报错而不是跑出怪数字。
  genBuiltinLen(arg, ctx) {
    const k = this.genExpr(arg, ctx);
    if (k === "str") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_str_len"); }
    else if (k === "list") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_list_len"); }
    else throw new Error(`长度() 不支持 ${k} 类型`);
    return "int";
  }

  // 转字符串(x) -> 串对象
  genBuiltinStr(arg, ctx) {
    const k = this.genExpr(arg, ctx);
    if (k === "str") return "str";
    if (k === "double") throw new Error("转字符串() 暂不支持浮点");
    // 同 输出：列表/字典 转字符串 需要递归格式化例程，没有之前一律拒绝，
    // 绝不能把堆地址转成数字串冒充结果。
    if (k === "list" || k === "dict")
      throw new Error("直接机器码暂不支持 转字符串(列表/字典)（改走解释器兜底）");
    // 转字符串(真) 宿主给「真」，走 rt_int_to_str 会给出「1」——静默值错
    if (k === "bool") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_bool_to_str"); return "str"; }
    movRR(this.em, R.rdi, R.rax);
    call(this.em, "rt_int_to_str");
    return "str";
  }

  // 追加(表, 值)：作为语句调用时忽略返回值，作为表达式求值时返回表对象
  // 表参数必须是标识符，扩容写回才有地方放（这里和解释器一致：表是引用）。
  genBuiltinAppend(args, ctx) {
    const 容器 = args[0];
    const k = this.genExpr(args[1], ctx);
    if (k === "double") throw new Error("列表元素暂不支持浮点");
    if (k === "str" || k === "bool" || k === "list" || k === "dict")
      throw new Error(`直接机器码列表只存裸整数（无类型标签）：${k === "str" ? "字符串" : k === "bool" ? "布尔" : "容器"} 元素会被当成整数读出并打印堆地址，改走解释器兜底`);
    const 值槽 = ctx.newTemp();
    movMemR(this.em, 值槽, R.rax);
    if (容器.类型 !== "标识符") throw new Error("追加() 的第一个参数需要是列表变量");
    const { off, kind } = ctx.slotOff(容器.名字);
    if (kind !== "list") throw new Error(`追加() 的第一个参数 ${容器.名字} 不是列表`);
    movRMem(this.em, R.rdi, off);
    movRMem(this.em, R.rsi, 值槽);
    call(this.em, "rt_list_append");
    movMemR(this.em, off, R.rax);
    ctx.releaseTemp(1);
    return "list";
  }

  genListLiteral(node, ctx) {
    movRI64(this.em, R.rdi, BigInt(Math.max(node.元素.length, 8)));
    call(this.em, "rt_list_new");
    const 槽 = ctx.newTemp();
    movMemR(this.em, 槽, R.rax);
    for (const e of node.元素) {
      const k = this.genExpr(e, ctx);
      if (k === "double") throw new Error("列表元素暂不支持浮点");
      if (k === "str" || k === "bool" || k === "list" || k === "dict")
        throw new Error(`直接机器码列表只存裸整数（无类型标签）：${k === "str" ? "字符串" : k === "bool" ? "布尔" : "容器"} 元素会被当成整数读出并打印堆地址，改走解释器兜底`);
      movRMem(this.em, R.rdi, 槽);
      movRR(this.em, R.rsi, R.rax);
      call(this.em, "rt_list_append");
      movMemR(this.em, 槽, R.rax);
    }
    movRMem(this.em, R.rax, 槽);
    ctx.releaseTemp(1);
    return "list";
  }

  // 表[下标] —— 读；写走 genAssign 的下标分支
  genIndex(node, ctx) {
    if (node.容器.类型 !== "标识符") throw new Error("原生下标暂只支持 变量[下标]");
    const { kind } = ctx.slotOff(node.容器.名字);
    if (kind !== "list") throw new Error("原生下标暂只支持列表");
    const kk = this.genExpr(node.索引, ctx);
    if (kk === "double") throw new Error("列表下标必须是整数");
    const 下标槽 = ctx.newTemp();
    movMemR(this.em, 下标槽, R.rax);
    const { off } = ctx.slotOff(node.容器.名字);
    movRMem(this.em, R.rdi, off);
    movRMem(this.em, R.rsi, 下标槽);
    call(this.em, "rt_list_get");
    ctx.releaseTemp(1);
    return "int";
  }

  genPrint(args, ctx) {

    let first = true;
    for (const a of args) {
      if (!first) call(this.em, "rt_print_space");
      first = false;
      const k = this.genExpr(a, ctx);
      // 列表/字典对象直接打印：以前落到 rt_print_int，把【堆地址】当数字打出来
      // （实测 输出 [1,2] 打 545259584、rc=0）。0.1.15 起就有，本轮审计才抓到，
      // 属于「编得过、跑得动、但结果是错的」。宿主要的是 "[1, 2]" 这种带结构的
      // 文本；直接后端没有递归格式化例程，宁可编译期拒绝走解释器兜底。
      if (k === "list" || k === "dict")
        throw new Error("直接机器码暂不支持打印 列表/字典 对象（旧行为是把堆地址当数字输出，改走解释器兜底拿 [1, 2]）");
      if (k === "str") {
        movRR(this.em, R.rdi, R.rax);
        call(this.em, "rt_print_str");
      } else if (k === "bool") {
        // 输出 真 必须打印「真/假」——走 rt_print_int 打成 1/0 就是静默值错
        movRR(this.em, R.rdi, R.rax);
        call(this.em, "rt_print_bool");
      } else {
        movRR(this.em, R.rdi, R.rax);
        call(this.em, "rt_print_int");
      }
    }
    call(this.em, "rt_print_nl");
  }

  // ---- 表达式 ----
  genExpr(node, ctx) {
    switch (node.类型) {
      case "字面量": return this.genLiteral(node, ctx);
      case "标识符": {
        const { off, kind } = ctx.slotOff(node.名字);
        movRMem(this.em, R.rax, off);
        return kind;
      }
      case "一元": return this.genUnary(node, ctx);
      case "二元": return this.genBinary(node, ctx);
      case "函数调用": return this.genCall(node, ctx);
      case "下标": return this.genIndex(node, ctx);
      case "列表字面量": return this.genListLiteral(node, ctx);
      default: throw new Error(`不支持表达式: ${node.类型}`);
    }
  }

  genLiteral(node, ctx) {
    if (node.字面类型 === "整数") {
      movRI64(this.em, R.rax, BigInt(node.值));
      return "int";
    }
    if (node.字面类型 === "布尔") {
      // 布尔值底层仍是 0/1（条件、算术复用整数位），但【种类】必须单独成
      // "bool"：否则 输出 真 走 rt_print_int 打成 1 —— 0.1.16 审计实测的
      // 静默值错。宿主语义：真 + 1 == 2（数字上相容）、真 == 1 为真、
      // "前" + 真 == "前真"、转字符串(真) == "真"、类型(真) == "布尔"。
      movRI64(this.em, R.rax, node.值 === "1" ? 1n : 0n);
      return "bool";
    }
    if (node.字面类型 === "字符串") {
      const lbl = this.strConst(node.值);
      // mov rax, imm64 (字符串绝对地址)
      movRI64(this.em, R.rax, 0n); // 占位
      // 把刚写入的 imm64 位置标记为 data fixup
      const fixupPos = this.em.pos - 8;
      this.em.fixups.push({ pos: fixupPos, label: lbl, type: "dataAbs64" });
      return "str";
    }
    // 浮点字面量：直接机器码后端【不支持】，必须编译期报错走解释器兜底。
    // 以前这里 fall-through 到 mov rax,0 —— 于是 2.5 编成 0、4.0/2.5 编成
    // 整数除 0/0 直接 SIGFPE。「能编译但算错」比「编译失败」严重得多，
    // 违反项目红线（语义正确性优先），所以宁可拒绝也不发错代码。
    if (node.字面类型 === "浮点")
      throw new Error("直接机器码暂不支持浮点（改走解释器兜底，结果正确只是慢）");
    movRI64(this.em, R.rax, 0n);
    return "none";
  }

  genUnary(node, ctx) {
    const k = this.genExpr(node.操作数, ctx);
    if (node.运算符 === "-") { negR(this.em, R.rax); return "int"; }
    if (node.运算符 === "+") return k;
    if (node.运算符 === "非") {
      testRR(this.em, R.rax, R.rax);
      setccAl(this.em, SETCC.z);
      movzbEaxAl(this.em);
      // 宿主：非 1 → 假，类型是布尔而不是整数（实测 类型(非 真) == "布尔"）
      return "bool";
    }
    if (node.运算符 === "~") {
      // ~x == -x - 1（补码恒等式；项目没有 NOT 指令助手）
      negR(this.em, R.rax);
      decR(this.em, R.rax);
      return "int";
    }
    return k;
  }

  genBinary(node, ctx) {
    const op = node.运算符;
    if (op === "且") return this.genLogicAnd(node, ctx);
    if (op === "或") return this.genLogicOr(node, ctx);

    // 左值存临时槽
    const L = this.genExpr(node.左, ctx);
    const slotL = ctx.newTemp();
    movMemR(this.em, slotL, R.rax);
    // 右值在 rax
    const Rk = this.genExpr(node.右, ctx);

    // 列表/字典参与运算：直接后端的列表是无类型标签的裸 int64 槽（元素句柄），
    // 字典同理。裸槽相加/比较都是指针垃圾——实测 函数 拼(a,b){返回 a+b}
    // 拼([1,2],[3]) 编过、跑出确定性垃圾 1090519256，随后 x[0] 报
    // 「不支持的类型索引」；宿主与自举层给 [1, 2, 3]。比较（==/< 等）同理是
    // 指针比较而非结构比较。按项目红线「宁可兜底也不发会把内存地址当结果的
    // 产物」——编译期拒绝，启动器自动回落解释器（结果正确只是慢）。
    if (L === "list" || Rk === "list" || L === "dict" || Rk === "dict") {
      const 种类名 = (k) => (k === "list" ? "列表" : k === "dict" ? "字典" : k);
      throw new Error(
        `直接机器码暂不支持列表/字典运算（${种类名(L)} ${op} ${种类名(Rk)}，改走解释器兜底，结果正确只是慢）`
      );
    }

    // 比较
    if (["<", ">", "<=", ">=", "==", "!="].includes(op)) {
      if (L === "str" || Rk === "str") return this.genStrCompare(op, slotL, L, Rk, ctx);
      return this.genCompare(op, slotL, ctx);
    }

    // 「+」只要有一边是串就走拼接（O(1) 绳索），另一边按动态语义先转字符串。
    // 两边都是整数才落到下面的数值加法——这条分支顺序就是「1+2」和"1"+2 的分水岭。
    if (op === "+" && (L === "str" || Rk === "str")) {
      // 布尔入串走 rt_bool_to_str（宿主实测 "值" + 真 == "值真"，不是 "值1"）
      if (Rk === "bool") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_bool_to_str"); }
      else if (Rk !== "str") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_int_to_str"); }
      const slotR = ctx.newTemp();
      movMemR(this.em, slotR, R.rax);            // 右对象入槽（r10 会被 rt_int_to_str 吃掉）
      movRMem(this.em, R.rdi, slotL);            // 左值
      if (L === "bool") call(this.em, "rt_bool_to_str");
      else if (L !== "str") call(this.em, "rt_int_to_str");
      else movRR(this.em, R.rax, R.rdi);
      movRR(this.em, R.rdi, R.rax);              // rdi = 左对象
      movRMem(this.em, R.rsi, slotR);            // rsi = 右对象
      call(this.em, "rt_concat");
      ctx.releaseTemp(2);
      return "str";
    }

    if (L === "str" || Rk === "str")
      throw new Error(`字符串不支持运算符 ${op}`);

    // 算术
    // 布尔参与算术，宿主产出整数而不是布尔（实测 类型(真 + 1)=="整数"、
    // 类型(真 << 1)=="整数"）。底层值同为 0/1，直接复用整数位，结果种类是 int。
    movRR(this.em, R.r10, R.rax);       // r10 = right
    movRMem(this.em, R.rax, slotL);    // rax = left
    if (op === "+") addRR(this.em, R.rax, R.r10);
    else if (op === "-") subRR(this.em, R.rax, R.r10);
    else if (op === "*") imulRR(this.em, R.rax, R.r10);
    else if (op === "//" || op === "%") {
      cqo(this.em);
      idivR(this.em, R.r10);
      if (op === "%") movRR(this.em, R.rax, R.rdx);
    }
    // 语言规范里 / 是「真除法」，整数相除也产出浮点（见 测试/核心测试.co:9）。
    // 直接后端只有整数标量，没有浮点运行时，绝不能悄悄退化成整除——
    // 7/2 给 3 是错的。编译期拒绝，让启动器兜底走解释器拿 3.5。
    else if (op === "/")
      throw new Error("直接机器码暂不支持真除法 /（产出浮点，改走解释器兜底，结果正确只是慢）；整除请写 //");
    else if (op === "&") andRR(this.em, R.rax, R.r10);
    else if (op === "|") orRR(this.em, R.rax, R.r10);
    else if (op === "^") xorRR(this.em, R.rax, R.r10);
    else if (op === "<<") {
      // 移位范围检查：x86 会把移位量按 6 位取模，不检查符号
      // 宿主语义：位数必须落在 0~63，否则运行时报错
      // 热路径只留 cmp + jcc，冷路径共享出口（避免 movabs 10 字节内联拖慢热循环）
      const shlok = this.em.nl("shl_ok");
      const shrng = this.em.nl("shl_rng");
      testRR(this.em, R.r10, R.r10);
      jcc(this.em, JCC.ns, shlok);
      call(this.em, "rt_shift_neg");  // 用 call 确保栈对齐
      this.em.label(shlok);
      cmpRImm(this.em, R.r10, 63);
      jcc(this.em, JCC.be, shrng);
      call(this.em, "rt_shift_oob");  // 用 call 确保栈对齐
      this.em.label(shrng);
      movRR(this.em, R.rcx, R.r10);
      salRCl(this.em, R.rax);
    }
    else if (op === ">>") {
      const srok = this.em.nl("sar_ok");
      const sarrng = this.em.nl("sar_rng");
      testRR(this.em, R.r10, R.r10);
      jcc(this.em, JCC.ns, srok);
      call(this.em, "rt_shift_neg");  // 用 call 确保栈对齐
      this.em.label(srok);
      cmpRImm(this.em, R.r10, 63);
      jcc(this.em, JCC.be, sarrng);
      call(this.em, "rt_shift_oob");  // 用 call 确保栈对齐
      this.em.label(sarrng);
      movRR(this.em, R.rcx, R.r10);
      sarRCl(this.em, R.rax);
    }
    else throw new Error(`运算符不支持: ${op}`);
    ctx.releaseTemp(1);
    return "int";
  }

  // 串参与的比较：目前只有 == / != 有定义（按 UTF-8 字节逐位比）。
  // 大小于需要字典序运行时，还没实现——宁可编译期拒绝，也不要悄悄比错。
  genStrCompare(op, slotL, Lk, Rk, ctx) {
    if (op !== "==" && op !== "!=")
      throw new Error(`字符串暂只支持 == / !=，收到 ${op}`);
    // 宿主里字符串和布尔永远不相等（实测 "真" == 真 → 假、"1" == 真 → 假），
    // 而把布尔转成 "真" 再比会得出 真 —— 值错。跨类型相等不在直接后端里猜，
    // 编译期拒绝、交给解释器兜底。
    if (Lk === "bool" || Rk === "bool")
      throw new Error("直接机器码暂不支持 字符串 与 布尔 比较（宿主恒为假，改走解释器兜底）");
    if (Rk !== "str") { movRR(this.em, R.rdi, R.rax); call(this.em, "rt_int_to_str"); }
    const slotR = ctx.newTemp();
    movMemR(this.em, slotR, R.rax);
    movRMem(this.em, R.rdi, slotL);
    if (Lk !== "str") call(this.em, "rt_int_to_str");
    movRR(this.em, R.rdi, R.rax);
    movRMem(this.em, R.rsi, slotR);
    call(this.em, "rt_str_eq");
    ctx.releaseTemp(2);
    if (op === "!=") {
      testRR(this.em, R.rax, R.rax);
      setccAl(this.em, SETCC.z);
      movzbEaxAl(this.em);
    }
    // rt_str_eq 出 0/1，但语义是布尔（宿主 类型("a"=="a") == "布尔"）
    return "bool";
  }

  genCompare(op, slotL, ctx) {
    // rax = right (右操作数刚求值完)
    movRR(this.em, R.r10, R.rax);
    movRMem(this.em, R.rax, slotL);  // rax = left
    cmpRR(this.em, R.rax, R.r10);
    let cc;
    switch (op) {
      case "<": cc = SETCC.l; break;
      case ">": cc = SETCC.g; break;
      case "<=": cc = SETCC.le; break;
      case ">=": cc = SETCC.ge; break;
      case "==": cc = SETCC.e; break;
      case "!=": cc = SETCC.ne; break;
    }
    setccAl(this.em, cc);
    movzbEaxAl(this.em);
    ctx.releaseTemp(1);
    // 宿主比较结果是布尔不是整数（实测 类型(1 > 0)=="布尔"、输出打「真」）。
    // 旧后端回 "int"，让 b = 5 > 3 后 输出 b 静默打成 1。
    return "bool";
  }

  genLogicAnd(node, ctx) {
    this.genExpr(node.左, ctx);
    const falseL = this.em.nl("and_f");
    const endL = this.em.nl("and_e");
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.z, falseL);
    this.genExpr(node.右, ctx);
    testRR(this.em, R.rax, R.rax);
    setccAl(this.em, SETCC.ne);
    movzbEaxAl(this.em);
    jmp(this.em, endL);
    this.em.label(falseL);
    xorRR(this.em, R.rax, R.rax);
    this.em.label(endL);
    // 宿主 类型(1 且 1) == "布尔"：逻辑运算的产物是布尔，不是整数
    return "bool";
  }

  genLogicOr(node, ctx) {
    this.genExpr(node.左, ctx);
    const trueL = this.em.nl("or_t");
    const endL = this.em.nl("or_e");
    testRR(this.em, R.rax, R.rax);
    jcc(this.em, JCC.nz, trueL);
    this.genExpr(node.右, ctx);
    testRR(this.em, R.rax, R.rax);
    setccAl(this.em, SETCC.ne);
    movzbEaxAl(this.em);
    jmp(this.em, endL);
    this.em.label(trueL);
    movRI64(this.em, R.rax, 1n);
    this.em.label(endL);
    return "bool";
  }
}

// ============================================================
// CLI
// ============================================================
function main() {
  // --检查 <文件.co>：只做能力自检，不产出 ELF
  if (process.argv[2] === "--检查") {
    const f = process.argv[3];
    if (!f) { console.error("用法：node 机器码生成器.js --检查 程序.co"); process.exit(2); }
    const r = 检查能力(f);
    if (r.可原生) {
      console.log("✅ 可走原生快路径（直接机器码，不经解释器）");
    } else {
      console.log("⚠ 需回退解释器通道（结果一致，速度慢一个量级）");
      console.log("  原因：" + r.原因);
      console.log("  建议：" + r.建议);
    }
    process.exit(r.可原生 ? 0 : 1);
  }
  const inFile = process.argv[2];
  const outFile = process.argv[3];
  if (!inFile || !outFile) {
    console.error("用法：node 机器码生成器.js 输入.co 输出");
    process.exit(1);
  }
  const src = fs.readFileSync(inFile, "utf8");
  let ast;
  try { ast = 解析源(src); }
  catch (e) { console.error("前端错误:", e.message); process.exit(2); }
  let elf;
  try {
    const gen = new DirectGen(ast);
    elf = gen.run();
  } catch (e) {
    console.error("机器码生成错误:", e.message);
    console.error(e.stack);
    process.exit(3);
  }
  fs.writeFileSync(outFile, elf);
  fs.chmodSync(outFile, 0o755);
  console.error(`已生成 ELF: ${outFile} (${elf.length} 字节)`);
}

// 只有在命令行直接运行时才走 CLI；被 require 时（bin/cocn.js 的 --编译）
// 只导出编译函数，否则模块加载阶段就会因为缺参数而 process.exit(1)。
module.exports = { 直接编译, 检查能力, DirectGen };

function 直接编译(输入路径, 输出路径) {
  const src = fs.readFileSync(输入路径, "utf8");
  const ast = 解析源(src);                    // 前端错误直接抛出，由调用方决定回退
  const elf = new DirectGen(ast).run();       // 生成错误同样抛出
  fs.writeFileSync(输出路径, elf);
  fs.chmodSync(输出路径, 0o755);
  return elf.length;
}

/* 能力自检：报告「这个程序能不能走原生快路径」，不能的话给出原因。
 *
 * 为什么需要：原生后端不支持的写法（浮点、字典、真除法……）会【静默回退】
 * 到解释器通道 —— 结果依然正确，但速度掉一个量级。用户只看得到「慢」，
 * 不知道慢在哪、怎么改。这里把「回退原因」显式说出来，并给出建议。
 *
 * 用法：node 工具/原生编译器/机器码生成器.js --检查 程序.co
 * 退出码：0=可走原生快路径；1=需回退解释器（stdout 仍打印报告）。
 */
function 检查能力(输入路径) {
  const 报告 = { 可原生: false, 原因: "", 建议: "" };
  let ast;
  try {
    ast = 解析源(fs.readFileSync(输入路径, "utf8"));
  } catch (e) {
    报告.原因 = "前端解析失败：" + e.message;
    // 原生前端在解析期就拒绝它不支持的写法（如匿名函数），抛出的也是
    // “语法错误”；但这类程序在解释器通道上完全合法，不能让用户以为是
    // 自己写错了语法、所有通道都跑不了。
    if (String(e.message).includes("暂不支持")) {
      报告.建议 = "这是原生前端暂不支持的写法，不是语法错误；解释器通道能直接跑"
        + "（结果一致，只是慢），改写成原生支持的写法即可走快路径。";
    } else {
      报告.建议 = "先修语法错误；语法不通过时任何通道都跑不了。";
    }
    return 报告;
  }
  try {
    new DirectGen(ast).run();
    报告.可原生 = true;
    return 报告;
  } catch (e) {
    const msg = String(e.message || e);
    报告.原因 = msg;
    if (msg.includes("真除法")) {
      报告.建议 = "「/」产出浮点，原生后端暂不支持；整数除法请写「//」（向下取整），"
        + "余数用「%」。";
    } else if (msg.includes("浮点")) {
      报告.建议 = "原生后端目前只支持整数运算。浮点表达式可改写成整数运算，"
        + "或把这段逻辑放进函数里用 cocn-math 之类的包（回退解释器结果一致，只是慢）。";
    } else if (msg.includes("字典")) {
      报告.建议 = "原生后端暂不支持字典（字典值需要类型标签，"
        + "本后端的槽位不带标签，强转会静默算错）。可用列表 + 平行下标代替。";
        } else if (msg.includes("默认参数") || msg.includes("可变参数")) {
      报告.建议 = "原生后端暂不支持默认参数/可变参数；可改写成显式传参。";
    } else if (msg.includes("元组")) {
      报告.建议 = "原生后端暂不支持元组；可用列表代替。";
    } else {
      报告.建议 = "这是原生后端的覆盖缺口，改写该处写法即可走快路径；"
        + "不改也能跑（回退解释器，结果一致）。";
    }
    return 报告;
  }
}

if (require.main === module) main();
