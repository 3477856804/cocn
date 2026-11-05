#!/usr/bin/env node
/**
 * coCN npm 包可执行入口（原生优先）
 *
 *   cocn 程序.co [参数...]        运行（默认走 bin/cocn 原生启动器）
 *   cocn --编译 程序.co 输出文件   用直接机器码后端把 .co 编成 x86-64 ELF
 *   cocn --生成C 程序.co 输出.c    导出中间产物（保留给调试/教学）
 *   cocn --检查 程序.co             能力自检：能否走原生快路径（不能则给原因与建议）
 *   cocn                          进入 REPL（引导器 + repl.co）
 *
 * 为什么 --编译 必须在这里实现，而不是只在启动器里：
 *   bin/cocn（C 启动器）缓存未命中时会调 `node cocn.js --编译 源 目标`。
 *   0.1.12 的 cocn.js 没有这个分支，把 "--编译" 当成 .co 文件去找，
 *   报「找不到文件: --编译」并退出 —— 首次运行全挂、缓存永远为空，
 *   于是「原生速度」在真实安装里从没发生过。
 *
 * 编译走 工具/原生编译器/机器码生成器.js：直接吐静态 ELF，
 * 不依赖 gcc / 汇编器，产物里没有动态链接，启动就是内核 execve 本身。
 * 生成器不支持的写法会抛错——那种情况下由启动器退回解释器执行，
 * 但 `--编译` 作为显式请求必须失败并报出原因，不能悄悄给个慢产物。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PKG_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PKG_DIR, 'src');
const BIN_DIR = path.join(__dirname);
const NATIVE_DIR = path.join(PKG_DIR, '工具', '原生编译器');
const NATIVE_LAUNCHER = path.join(BIN_DIR, 'cocn');
const INTERPRETER_PATH = path.join(SRC_DIR, '解释器.co');
const REPL_PATH = path.join(SRC_DIR, 'repl.co');
const DIRECT_BACKEND = path.join(NATIVE_DIR, '机器码生成器.js');

/**
 * 找引导器（宿主 C 真值参照）。
 *
 * 按 npm 语言类包的通行做法（deno / bun / node）：主包不含二进制，
 * 二进制放在平台专属子包里，靠 optionalDependencies 让 npm 只装匹配
 * 平台的那个。查找顺序：
 *   1) COCN_BOOTSTRAP —— 显式指定优先（开发机自建引导器走这条）
 *   2) 平台子包 cocn-<platform>-<arch> 里的引导器
 *   3) 主包内 bin/引导器（老包遗留，或手工放进去的）
 *
 * 平台子包放在 node_modules 下，位置随安装方式而变（npm 扁平化 or 嵌套），
 * 所以逐个候选路径探测。
 */
function 找引导器() {
  if (process.env.COCN_BOOTSTRAP) return process.env.COCN_BOOTSTRAP;
  const 平台 = 平台标识();
  const 候选 = [];
  if (平台) {
    const 子包名 = '@yeyelailou/cocn-' + 平台;
    // npm 的两种布局都要覆盖：
    //   扁平化：node_modules/@yeyelailou/cocn 与 node_modules/@yeyelailou/cocn-linux-x64 同级
    //   嵌套：  node_modules/@yeyelailou/cocn/node_modules/@yeyelailou/cocn-linux-x64
    // 所以从本包所在目录逐级向上，每级都试「同级 node_modules」与「内嵌 node_modules」。
    let 目录 = PKG_DIR;
    for (let i = 0; i < 6; i++) {
      候选.push(path.join(目录, 'node_modules', 子包名, 'bin', '引导器'));
      候选.push(path.join(目录, 'node_modules', 子包名, 'bin', '引导器.exe'));
      候选.push(path.join(目录, '..', 'node_modules', 子包名, 'bin', '引导器'));
      候选.push(path.join(目录, '..', 'node_modules', 子包名, 'bin', '引导器.exe'));
      目录 = path.dirname(目录);
      if (目录 === path.dirname(目录)) break;
    }
  }
  候选.push(path.join(BIN_DIR, '引导器'));
  候选.push(path.join(BIN_DIR, '引导器.exe'));
  for (const c of 候选) {
    try {
      if (!fs.existsSync(c)) continue;
      // npm 解包可能不保留可执行位（实测装完是 -rw-------），
      // 而引导器必须能被 execve 执行。这里就地补执行位，
      // 覆盖「postinstall 被 --ignore-scripts 跳过」的场景。
      try {
        const st = fs.statSync(c);
        if ((st.mode & 0o111) === 0) fs.chmodSync(c, st.mode | 0o755);
      } catch (e) { /* 忽略 */ }
      return c;
    } catch (e) { /* 忽略 */ }
  }
  return path.join(BIN_DIR, '引导器');
}

/** 平台标识：与平台子包命名一致（linux-x64 / linux-arm64 / darwin-x64 ...） */
function 平台标识() {
  const p = process.platform === 'android' ? 'linux' : process.platform;
  const a = process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : null);
  if (!a) return null;
  return p + '-' + a;
}

const BOOTSTRAP = 找引导器();

function fail(msg) {
  console.error('\x1b[31m[coCN]\x1b[0m ' + msg);
  process.exit(1);
}

function pipeExit(child, label) {
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code || 0)));
  child.on('error', (err) => {
    console.error(`\x1b[31m[coCN]\x1b[0m ${label}启动失败: ${err.message}`);
    process.exit(1);
  });
}

const userArgs = process.argv.slice(2);
// 程序参数（源文件之后）：编码进 COCN_ARGV 以换行分隔，供层内置 读取命令行 取回。
// 宿主不提供命令行参数能力，此为层扩展；以换行分隔，故参数不应含换行（CLI 约定）。
const cocnArgv = userArgs.length > 1 ? userArgs.slice(1).join('\n') : '';
const argvEnv = { COCN_ARGV: cocnArgv };

// —— 生态子命令（对标 cargo 的 15 条命令）——
// new / install / add / remove / update / publish / search / yank / tree
// build / run / test / bench / doc / fmt
const 生态命令 = [
  'new', 'install', 'add', 'remove', 'update', 'publish', 'search', 'yank', 'tree',
  'build', 'run', 'test', 'bench', 'doc', 'fmt'
];
if (生态命令.includes(userArgs[0])) {
  const 生态 = require(path.join(PKG_DIR, '工具', '生态', 'cli.js'));
  生态.运行(userArgs[0], userArgs.slice(1))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('\x1b[31m[coCN]\x1b[0m ' + (e && e.message || e));
      process.exit(1);
    });
  return;
}

// —— --编译：.co -> x86-64 静态 ELF（原生启动器的首编通道）——
if (userArgs[0] === '--编译' || userArgs[0] === '--compile') {
  const 输入 = userArgs[1];
  const 输出 = userArgs[2];
  if (!输入 || !输出) fail('用法: cocn --编译 程序.co 输出可执行文件');
  const 绝对输入 = path.resolve(process.cwd(), 输入);
  const 绝对输出 = path.resolve(process.cwd(), 输出);
  if (!fs.existsSync(绝对输入)) fail(`找不到文件: ${输入}`);
  if (!fs.existsSync(DIRECT_BACKEND)) fail(`未找到直接机器码后端: ${DIRECT_BACKEND}`);
  let 后端;
  try {
    后端 = require(DIRECT_BACKEND);
  } catch (e) {
    fail(`机器码后端加载失败: ${e.message}`);
  }
  try {
    const 字节数 = 后端.直接编译(绝对输入, 绝对输出);
    console.error(`[coCN] 已编译 ${输入} -> ${输出}（${字节数} 字节，直接机器码，无 gcc 依赖）`);
    process.exit(0);
  } catch (e) {
    fail(`原生编译失败: ${e.message}`);
  }
}

// —— --检查：能力自检，报告「这个程序能否走原生快路径」——
// 原生后端不支持的写法（浮点、字典、真除法……）会静默回退到解释器：
// 结果依然正确，但速度掉一个量级，而用户只看到「慢」不知道慢在哪。
// 这个子命令把回退原因与改写建议直接说出来。
if (userArgs[0] === '--检查') {
  const 目标 = userArgs[1];
  if (!目标) { console.error('用法：cocn --检查 程序.co'); process.exit(2); }
  const 绝对 = path.resolve(process.cwd(), 目标);
  if (!fs.existsSync(绝对)) { console.error('找不到文件：' + 绝对); process.exit(2); }
  let 能力;
  try {
    能力 = require(path.join(NATIVE_DIR, '机器码生成器.js')).检查能力(绝对);
  } catch (e) {
    console.error('检查失败：' + (e && e.message || e));
    process.exit(2);
  }
  if (能力.可原生) {
    console.log('✅ 可走原生快路径（直接机器码，不经解释器）');
  } else {
    console.log('⚠ 需回退解释器通道（结果一致，速度慢一个量级）');
    console.log('  原因：' + 能力.原因);
    console.log('  建议：' + 能力.建议);
  }
  process.exit(能力.可原生 ? 0 : 1);
}

// —— --生成C：保留旧接口，交给传统汇编/运行时后端 ——
if (userArgs[0] === '--生成C') {
  const 入口 = path.join(NATIVE_DIR, '入口.js');
  if (!fs.existsSync(入口)) fail(`未找到 ${入口}`);
  const child = spawn('node', [入口, ...userArgs.slice(1)], { stdio: 'inherit' });
  pipeExit(child, '汇编后端');
}

// —— 无参数：交互式 REPL（自解释模式）——
if (userArgs.length === 0) {
  if (!fs.existsSync(REPL_PATH)) fail(`未找到 REPL 文件: ${REPL_PATH}`);
  if (!fs.existsSync(BOOTSTRAP)) fail('未找到引导器 bin/引导器，请重新安装: npm install -g @yeyelailou/cocn');
  // repl.co 自带持久环境与读取循环，不读 COCN_TARGET
  const child = spawn(BOOTSTRAP, [REPL_PATH], { stdio: 'inherit', env: process.env, cwd: SRC_DIR });
  pipeExit(child, 'REPL');
} else {
  // 解析为绝对路径：原生启动器与自解释器都以绝对路径定位目标最稳
  const absTarget = path.resolve(process.cwd(), userArgs[0]);
  const rest = userArgs.slice(1);

  // —— 通道一（默认）：原生启动器，编译缓存通道，毫秒级 ——
  // 包里预置的 bin/cocn 是 Linux x86-64 静态产物；其它平台若没 gcc 就没被
  // install.js 重建过。spawn 对 ENOEXEC 不会报错而是退化成 /bin/sh 执行
  // （实测），所以先用 启动器可用() 按魔数+架构自检，不匹配就直接走引导器。
  if (启动器可用(NATIVE_LAUNCHER)) {
    const child = spawn(NATIVE_LAUNCHER, [absTarget, ...rest], {
      stdio: 'inherit',
      env: Object.assign({}, process.env, argvEnv, { COCN_TARGET: absTarget, COCN_JS: __filename }),
      cwd: process.cwd()
    });
    child.on('error', (err) => {
      console.error(`[coCN] 原生启动器不可用（${err.code || err.message}），回退自解释器`);
      走引导器(absTarget, rest);
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : (code || 0)));
  } else {
    走引导器(absTarget, rest);
  }
}

/** bin/cocn 是否适配当前平台。
 *  包里预置的是 Linux x86-64 静态 ELF；install.js 在有 gcc 的平台上会用
 *  本机 gcc 重建它。但「没 gcc + 非本机预置」时文件仍是外平台二进制，
 *  node 的 spawn 对 ENOEXEC 不报错而是退化成 /bin/sh 执行（实测），
 *  会喷出乱码错误——所以调用前先按魔数与架构自检。 */
function 启动器可用(p) {
  let fd;
  const buf = Buffer.alloc(20);
  try {
    fd = fs.openSync(p, 'r');
    if (fs.readSync(fd, buf, 0, 20, 0) < 20) return false;
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // Termux 上 process.platform 是 'android'（不是 'linux'），但同样是
  // Linux 内核 + ELF 格式 —— 必须与 linux 一起判，否则架构自检被跳过。
  if (process.platform === 'linux' || process.platform === 'android') {
    // ELF64 + 架构匹配的 e_machine：x86-64=62、aarch64=183（小端读 2 字节）
    if (!(buf[0] === 0x7f && buf.toString('ascii', 1, 4) === 'ELF' && buf[4] === 2)) return false;
    const 机器 = buf.readUInt16LE(18);
    if (process.arch === 'x64') return 机器 === 62;
    if (process.arch === 'arm64') return 机器 === 183;
    return false;
  }
  if (process.platform === 'darwin') {
    const m = buf.readUInt32LE(0);
    const 是MachO = m === 0xfeedfacf || m === 0xfeedfaf7 || (m >>> 8) === 0xfeedface;
    if (!是MachO) return false;
    const cpu = buf.readUInt32LE(4) & 0x00ffffff;
    return (process.arch === 'x64' && cpu === 0x000007) ||
           (process.arch === 'arm64' && cpu === 0x00000c);
  }
  return false; // win32 等：走引导器
}

/** 通道二（回退）：引导器跑自解释器，任何环境可用，只是慢 */
function 走引导器(absTarget, rest) {
  if (!fs.existsSync(BOOTSTRAP)) {
    fail('未找到可执行通道（bin/cocn 或 bin/引导器）。请重新安装: npm install -g @yeyelailou/cocn');
  }
  // 引导器也是预编译二进制：包内那份是 Linux x86-64 静态 ELF。
  // 在别的架构上 node 的 spawn 对 ENOEXEC 不报错，而是退化成 /bin/sh 去执行
  // 这个二进制 —— 结果是喷一屏 shell 语法错误（实测：aarch64/Termux 上
  // 报 "引导器[12]: syntax error: unexpected '('"），完全看不出真实原因。
  // 所以这里先按魔数+架构自检，不匹配就给出可执行的提示。
  if (!启动器可用(BOOTSTRAP)) {
    fail('引导器 bin/引导器 与当前平台不匹配（' + process.platform + '/' + process.arch + '）。\n' +
         '  包内预置的是 Linux x86-64 静态 ELF；本机需要对应架构的引导器。\n' +
         '  解决办法：① 有 gcc 时用 npm install -g @yeyelailou/cocn 重装（postinstall 会用本机 gcc 重建）；\n' +
         '           ② 或手动下载对应平台的 coCN 引导二进制放到 bin/引导器：\n' +
         '              https://gitee.com/COSMOnb666/coCN/releases\n' +
         '  临时办法：设置 COCN_BOOTSTRAP 指向本机架构的引导器后重试。');
  }
  if (!fs.existsSync(INTERPRETER_PATH)) fail(`未找到自解释器文件: ${INTERPRETER_PATH}`);
  const child = spawn(BOOTSTRAP, [INTERPRETER_PATH], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, argvEnv, { COCN_TARGET: absTarget, COCN_BACKEND: process.env.COCN_BACKEND || 'vm' }),
    cwd: SRC_DIR
  });
  pipeExit(child, '自解释器');
}
