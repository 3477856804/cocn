// ============================================================
// elf.js —— ELF64 可执行文件生成器
//
// 布局：
//   [ELF 头 64 字节][程序头 112 字节][代码 + 数据段]
//   基地址 0x400000
//   LOAD1 R+X ：代码 + 只读数据（字符串常量）
//   LOAD2 R+W ：匿名堆（bss，filesz=0）——竞技场分配器的工作区
//
// 为什么要第二个段：直接机器码后端早期只有一个 R+X 段，没有任何可写内存，
//   所以列表/字符串只能算不动的常量，动态容器一概编不出来。堆段用
//   filesz=0 / memsz=N 的方式让内核直接给一片零初始化页，运行时一次
//   bump 分配都不需要 syscall（比 mmap-per-alloc 快，也比 malloc 快）。
// ============================================================

const BASE_ADDR = 0x400000;
const ELF_HDR_SIZE = 64;
const PHDR_SIZE = 56;
const PHDR_NUM = 2;
// 堆段放在离代码段很远的地址，避免内核把两个段对齐到同一页后互相重叠
const HEAP_ADDR = 0x20000000;
const HEAP_SIZE = 256 << 20; // 256MB 虚拟空间，零初始化、按需缺页，不占文件体积

/** ABI 尾戳定长：8 字节魔数 + 24 字节代次串（不足补 0，超出截断）。
 * 为什么放在文件末尾而不是 e_ident/e_flags：
 *   - e_ident[9..15] 只有 7 字节，放不下 "cocn-direct-0.1.16"；
 *   - e_flags 只有 4 字节，塞哈希就有碰撞空间，误判等于拒绝合法产物；
 *   - 尾戳在 PT_LOAD 的 p_filesz 之外，内核根本不会映射它，零风险，
 *     而且一眼能用 read(2) 从文件尾读回来。
 * 它不参与执行，只给启动器在 execv 之前做代次自检用（配合缓存指纹里
 * 的版本盐，双保险：即使有人手工投毒/挪动缓存文件，也会被这一步挡下）。 */
const ABI_STAMP_SIZE = 32;
const ABI_MAGIC = Buffer.from("COCNABI\x01", "binary");

function writeAbiStamp(buf, at, abi) {
  ABI_MAGIC.copy(buf, at, 0, 8);
  if (abi) Buffer.from(String(abi), "utf8").copy(buf, at + 8, 0, ABI_STAMP_SIZE - 8);
}

/** 造一段尾戳字节，供 buildElf64 与自检逻辑共用 */
function abiStamp(abi) {
  const t = Buffer.alloc(ABI_STAMP_SIZE);
  writeAbiStamp(t, 0, abi);
  return t;
}

/**
 * 生成完整的 ELF64 可执行文件 Buffer
 * @param {Buffer} codeData  紧跟程序头之后的二进制内容（代码 + 数据）
 * @param {number} entryOffset  入口点相对代码起始处的偏移（字节）
 * @param {string} abi  编译器代次串，写进文件末尾的 ABI 尾戳
 * @returns {Buffer} 完整 ELF 文件
 */
function buildElf64(codeData, entryOffset, abi) {
  const phoff = ELF_HDR_SIZE;
  const totalSize = ELF_HDR_SIZE + PHDR_SIZE * PHDR_NUM + codeData.length;
  const buf = Buffer.alloc(totalSize + ABI_STAMP_SIZE);

  // ---------- ELF 头 (64 字节) ----------
  // e_ident[16]
  buf[0] = 0x7F; buf[1] = 0x45; buf[2] = 0x4C; buf[3] = 0x46; // \177 E L F
  buf[4] = 0x02;   // EI_CLASS: ELFCLASS64
  buf[5] = 0x01;   // EI_DATA: 小端
  buf[6] = 0x01;   // EI_VERSION: EV_CURRENT
  buf[7] = 0x00;   // EI_OSABI: UNIX System V
  buf[8] = 0x00;   // EI_ABIVERSION
  // e_ident[9..15] 保持 0

  // e_type (2 bytes, offset 16): ET_EXEC = 2
  buf.writeUInt16LE(2, 16);
  // e_machine (2 bytes, offset 18): EM_X86_64 = 62
  buf.writeUInt16LE(62, 18);
  // e_version (4 bytes, offset 20): 1
  buf.writeUInt32LE(1, 20);
  // e_entry (8 bytes, offset 24): 入口虚拟地址
  buf.writeBigUInt64LE(BigInt(BASE_ADDR + phoff + PHDR_SIZE * PHDR_NUM + entryOffset), 24);
  // e_phoff (8 bytes, offset 32): 程序头表偏移
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  // e_shoff (8 bytes, offset 40): 节头表偏移 = 0
  buf.writeBigUInt64LE(BigInt(0), 40);
  // e_flags (4 bytes, offset 48): 0
  buf.writeUInt32LE(0, 48);
  // e_ehsize (2 bytes, offset 52): ELF 头大小 = 64
  buf.writeUInt16LE(ELF_HDR_SIZE, 52);
  // e_phentsize (2 bytes, offset 54): 程序头条目大小 = 56
  buf.writeUInt16LE(PHDR_SIZE, 54);
  // e_phnum (2 bytes, offset 56): 程序头数量
  buf.writeUInt16LE(PHDR_NUM, 56);
  // e_shentsize (2 bytes, offset 58): 0
  buf.writeUInt16LE(0, 58);
  // e_shnum (2 bytes, offset 60): 0
  buf.writeUInt16LE(0, 60);
  // e_shstrndx (2 bytes, offset 62): 0
  buf.writeUInt16LE(0, 62);

  // ---------- 程序头 1：代码 + 只读数据 ----------
  writePhdr(buf, phoff, 5 /* PF_R|PF_X */, BigInt(BASE_ADDR), BigInt(0),
    BigInt(totalSize), BigInt(totalSize));

  // ---------- 程序头 2：可写堆（bss，不占文件体积）----------
  // p_offset 只需满足 ≡ p_vaddr (mod 页大小)；HEAP_ADDR 页对齐，取 0 即可。
  writePhdr(buf, phoff + PHDR_SIZE, 6 /* PF_R|PF_W */, BigInt(HEAP_ADDR), BigInt(0),
    BigInt(0), BigInt(HEAP_SIZE));

  // ---------- 代码 + 数据段 ----------
  codeData.copy(buf, phoff + PHDR_SIZE * PHDR_NUM);

  // ---------- ABI 尾戳 ----------
  // 位于 p_filesz（=totalSize）之外，内核不映射；代次串为空时保持全零，
  // 启动器会把"全零尾戳"判为未知代次 → 一律重编，宁慢勿错。
  if (abi) abiStamp(abi).copy(buf, totalSize);

  return buf;
}

function writePhdr(buf, off, flags, vaddr, foff, filesz, memsz) {
  buf.writeUInt32LE(1, off + 0);          // p_type: PT_LOAD
  buf.writeUInt32LE(flags, off + 4);      // p_flags
  buf.writeBigUInt64LE(foff, off + 8);    // p_offset
  buf.writeBigUInt64LE(vaddr, off + 16);  // p_vaddr
  buf.writeBigUInt64LE(vaddr, off + 24);  // p_paddr
  buf.writeBigUInt64LE(filesz, off + 32); // p_filesz
  buf.writeBigUInt64LE(memsz, off + 40);  // p_memsz
  buf.writeBigUInt64LE(BigInt(0x1000), off + 48); // p_align
}

module.exports = { buildElf64, abiStamp, ABI_STAMP_SIZE, ABI_MAGIC, BASE_ADDR, ELF_HDR_SIZE, PHDR_SIZE, PHDR_NUM, HEAP_ADDR, HEAP_SIZE };
