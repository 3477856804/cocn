#!/usr/bin/env node
'use strict';
/**
 * coCN 平台子包发布脚本（对标 deno / bun / node 的通行做法）
 *
 * 为什么要有平台子包：
 *   语言类 npm 包（deno、bun、node）都不把二进制塞进主包，而是
 *   「主包 + 平台专属子包」：主包只有 JS 入口与源码，平台子包带
 *   os/cpu 约束并装在 optionalDependencies 里，npm 只会安装与当前
 *   平台匹配的那个。这样装完即用，不需要 postinstall 去下载二进制，
 *   也不受网络与构建环境限制。
 *
 *   本脚本负责：
 *     1) 生成各平台子包的目录（清单 + 引导二进制）
 *     2) 校验二进制架构与目标平台一致（防止把 x86 产物塞进 arm64 包）
 *     3) 打印发布命令（发布动作仍由人确认后执行）
 *
 * 用法：
 *   node 工具/发布/构建平台包.js --平台 linux-arm64 --源 <引导二进制路径>
 *   node 工具/发布/构建平台包.js --列出
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '工具', '发布', '平台包');

// 支持的平台子包：与 bin/入口.js 的 平台标识() 保持一致
const 平台表 = [
  { 名: 'linux-x64', os: ['linux'], cpu: ['x64'], 机器码: 62 },
  { 名: 'linux-arm64', os: ['linux', 'android'], cpu: ['arm64'], 机器码: 183 },
  { 名: 'darwin-x64', os: ['darwin'], cpu: ['x64'], 机器码: null },
  { 名: 'darwin-arm64', os: ['darwin'], cpu: ['arm64'], 机器码: null },
  { 名: 'win32-x64', os: ['win32'], cpu: ['x64'], 机器码: null },
];

function 读ELF机器码(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(20);
  fs.readSync(fd, b, 0, 20, 0);
  fs.closeSync(fd);
  if (!(b[0] === 0x7f && b.toString('ascii', 1, 4) === 'ELF')) return null;
  if (b[4] !== 2) return null; // 只认 ELF64
  return b.readUInt16LE(18);
}

function 读MachO机器码(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(8);
  fs.readSync(fd, b, 0, 8, 0);
  fs.closeSync(fd);
  const m = b.readUInt32LE(0);
  if (m === 0xfeedfacf || m === 0xfeedfaf7) return b.readUInt32LE(4) & 0x00ffffff;
  return null;
}

function 是MachO(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  const m = b.readUInt32LE(0);
  return m === 0xfeedfacf || m === 0xfeedfaf7 || (m >>> 8) === 0xfeedface;
}

/** 校验二进制架构与目标平台一致 */
function 校验架构(源, 平台) {
  if (平台.机器码 === null) {
    // macOS / Windows：这里只做粗判（macOS 用 MachO，Windows 用 MZ）
    if (平台.名.startsWith('darwin') && !是MachO(源)) {
      throw new Error('二进制不是 Mach-O 格式，不能放进 ' + 平台.名 + ' 子包');
    }
    if (平台.名.startsWith('win32')) {
      const fd = fs.openSync(源, 'r');
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 0);
      fs.closeSync(fd);
      if (!(b[0] === 0x4d && b[1] === 0x5a)) {
        throw new Error('二进制不是 PE/MZ 格式，不能放进 ' + 平台.名 + ' 子包');
      }
    }
    return;
  }
  const m = 读ELF机器码(源);
  if (m === null) throw new Error('不是 ELF64 二进制：' + 源);
  if (m !== 平台.机器码) {
    const 名 = m === 62 ? 'x86-64' : (m === 183 ? 'aarch64' : ('机器码 ' + m));
    throw new Error('架构不符：' + 源 + ' 是 ' + 名 + '，目标子包要 ' +
      (平台.机器码 === 62 ? 'x86-64' : 'aarch64'));
  }
}

/**
 * 同步主包的 optionalDependencies：平台子包版本必须与主包版本一致。
 *
 * 为什么需要这道检查：0.1.36 推进版本号时漏了这里，主包引用了
 * 0.1.35 的平台子包（而 npm 上子包已发到 0.1.36）——从 Gitee 克隆后
 * 安装的用户会拉到旧子包。npm 不会报错（两个版本都存在），所以只能靠
 * 脚本自己拦。
 */
function 同步主包引用(主包版本) {
  const 主包路径 = path.join(ROOT, 'package.json');
  const 主包 = JSON.parse(fs.readFileSync(主包路径, 'utf8'));
  const 依赖 = 主包.optionalDependencies || {};
  let 改 = false;
  for (const 名 of Object.keys(依赖)) {
    if (!/^@yeyelailou\/cocn-/.test(名)) continue;
    if (依赖[名] !== 主包版本) {
      console.log(`同步主包引用：${名} ${依赖[名]} -> ${主包版本}`);
      依赖[名] = 主包版本;
      改 = true;
    }
  }
  if (改) {
    主包.optionalDependencies = 依赖;
    fs.writeFileSync(主包路径, JSON.stringify(主包, null, 2) + '\n');
  }
}

function 构建(平台名, 源) {
  const 平台 = 平台表.find(p => p.名 === 平台名);
  if (!平台) {
    console.error('未知平台：' + 平台名 + '（可用：' + 平台表.map(p => p.名).join(', ') + '）');
    process.exit(1);
  }
  if (!源 || !fs.existsSync(源)) {
    console.error('找不到源二进制：' + (源 || '(未指定)'));
    process.exit(1);
  }
  try {
    校验架构(源, 平台);
  } catch (e) {
    console.error('架构校验失败：' + e.message);
    process.exit(1);
  }

  const 目录 = path.join(OUT_DIR, 平台.名);
  fs.rmSync(目录, { recursive: true, force: true });
  fs.mkdirSync(path.join(目录, 'bin'), { recursive: true });

  const 二进制名 = 平台.名.startsWith('win32') ? '引导器.exe' : '引导器';
  fs.copyFileSync(源, path.join(目录, 'bin', 二进制名));
  if (!平台.名.startsWith('win32')) fs.chmodSync(path.join(目录, 'bin', 二进制名), 0o755);

  const 主包版本 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  同步主包引用(主包版本);
  const 清单 = {
    name: '@yeyelailou/co-' + 平台.名,
    version: 主包版本,
    description: 'cocn 引导二进制（' + 平台.名 + ' 平台）—— 供 @yeyelailou/co 通过 optionalDependencies 引用',
    os: 平台.os,
    cpu: 平台.cpu,
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'https://gitee.com/COSMOnb666/cocn.git' },
    homepage: 'https://gitee.com/COSMOnb666/cocn',
    author: '张宇 (cosmo)',
    keywords: ['coCN', '中文编程', '引导器', 'bootstrap', 平台.名],
    files: ['bin/'],
  };
  fs.writeFileSync(path.join(目录, 'package.json'), JSON.stringify(清单, null, 2) + '\n');

  console.log('已生成平台子包：' + 目录);
  console.log('  平台约束：os=' + JSON.stringify(平台.os) + ' cpu=' + JSON.stringify(平台.cpu));
  console.log('  二进制：bin/' + 二进制名 + '（' + Math.round(fs.statSync(path.join(目录, 'bin', 二进制名)).size / 1024) + 'K）');
  console.log('  发布命令：cd "' + 目录 + '" && npm publish --access public');
}

const 参数 = process.argv.slice(2);
if (参数.includes('--列出')) {
  console.log('平台子包清单：');
  for (const p of 平台表) {
    console.log('  ' + p.名.padEnd(14) + 'os=' + JSON.stringify(p.os).padEnd(22) + 'cpu=' + JSON.stringify(p.cpu));
  }
  console.log('\n生成：node 工具/发布/构建平台包.js --平台 <平台名> --源 <二进制路径>');
} else {
  const i平台 = 参数.indexOf('--平台');
  const i源 = 参数.indexOf('--源');
  构建(i平台 >= 0 ? 参数[i平台 + 1] : '', i源 >= 0 ? 参数[i源 + 1] : '');
}
