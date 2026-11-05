#!/usr/bin/env node
'use strict';
// 示例包三通道验证器：每个 示例包/<包>/测试.co 跑 {native, eval, vm} 三通道
// 门禁：每包三通道均「通过 N/N，失败 0」且 stdout 逐字节一致。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const COJS = path.join(ROOT, 'bin', '入口.js');
// 引导器（宿主 C 真值参照）：默认用仓库自带的 bin/引导器（x86-64 ELF）。
// 非 x86 平台（如 Android/Termux aarch64）无法执行该二进制，
// 可用 COCN_BOOTSTRAP 指向自建的 aarch64 引导器：
//   aarch64-linux-android-clang -O2 -pthread -o 引导器-arm2 co.c -lm
//   COCN_BOOTSTRAP=$HOME/cocnwork/引导器-arm2 node 工具/生态/验证三通道.js
const BOOT = process.env.COCN_BOOTSTRAP || path.join(ROOT, 'bin', '引导器');
// 单通道超时：默认 60s；慢速宿主（如 Termux/aarch64 自举解释器）可调大，
// 例如 COCN_VERIFY_TIMEOUT=180000 node 工具/生态/验证三通道.js
const 通道超时 = process.env.COCN_VERIFY_TIMEOUT
  ? Math.max(1000, parseInt(process.env.COCN_VERIFY_TIMEOUT, 10) || 60000)
  : 60000;

function 跑(命令, 参数, 选项) {
  const r = spawnSync(命令, 参数, Object.assign({ encoding: 'utf8', timeout: 通道超时 }, 选项));
  let out = (r.stdout || '') + (r.stderr || '');
  if (r.error && r.error.code === 'ETIMEDOUT') out += '\n[超时] 通道超过 ' + Math.round(通道超时 / 1000) + 's 未结束';
  return { code: r.status === null ? 124 : r.status, out };
}

function 过(out) {
  return /失败 0/.test(out) && !/失败 [1-9]/.test(out);
}

let 总包 = 0, 全过 = 0;
const 失败 = [];

for (const 包 of fs.readdirSync(path.join(ROOT, '示例包'))) {
  const 包目录 = path.join(ROOT, '示例包', 包);
  const 测试文件 = path.join(包目录, '测试.co');
  if (!fs.statSync(包目录).isDirectory() || !fs.existsSync(测试文件)) continue;
  总包++;
  const ABSTEST = 测试文件;

  // native：包目录跑 bin/入口.js（原生启动器）。需显式传 PWD=包目录，
  // 因为导入解析按 环境变量("PWD") 定位相对模块，spawn 的 cwd 不会自动同步 PWD。
  const native = 跑('node', [COJS, '测试.co'], {
    cwd: 包目录,
    env: Object.assign({}, process.env, { PWD: 包目录 })
  });
  const native_ok = native.code === 0 && 过(native.out);

  // eval / vm：引导器 + 解释器.co，PWD=包目录、cwd=src
  const evalR = 跑(BOOT, ['解释器.co'], {
    cwd: SRC,
    env: Object.assign({}, process.env, { PWD: 包目录, COCN_TARGET: ABSTEST, COCN_BACKEND: 'eval' })
  });
  const eval_ok = evalR.code === 0 && 过(evalR.out);

  const vmR = 跑(BOOT, ['解释器.co'], {
    cwd: SRC,
    env: Object.assign({}, process.env, { PWD: 包目录, COCN_TARGET: ABSTEST, COCN_BACKEND: 'vm' })
  });
  const vm_ok = vmR.code === 0 && 过(vmR.out);

  const 末行 = (native.out.split('\n').filter(s => /通过/.test(s)).pop() || '').trim();
  if (native_ok && eval_ok && vm_ok) {
    if (native.out === evalR.out && native.out === vmR.out) {
      全过++;
      console.log('✓ ' + 包 + '  三通道一致  (' + 末行 + ')');
    } else {
      console.log('⚠ ' + 包 + '  三通道均过但输出分歧');
      失败.push(包 + '(分歧)');
    }
  } else {
    console.log('✗ ' + 包 + '  native=' + (native_ok ? 1 : 0) + ' eval=' + (eval_ok ? 1 : 0) + ' vm=' + (vm_ok ? 1 : 0));
    if (!native_ok) console.log('    native: ' + native.out.split('\n').slice(-2).join(' | '));
    if (!eval_ok) console.log('    eval:   ' + evalR.out.split('\n').slice(-2).join(' | '));
    if (!vm_ok) console.log('    vm:     ' + vmR.out.split('\n').slice(-2).join(' | '));
    失败.push(包);
  }
}

console.log('=========================================');
console.log('示例包: ' + 总包 + '  /  三通道全过: ' + 全过);
// 通道说明必须诚实：native 走 bin/入口.js，其内部在有可用 bin/cocn（C 原生启动器）
// 时才是「直接机器码 ELF」，否则回退引导器自解释器（与 vm 同源）。
// 回退情形下 native vs vm 的一致性是平凡的，真正有校验力的是 eval vs vm。
const 有原生启动器 = fs.existsSync(path.join(ROOT, 'bin', 'cocn'));
console.log('通道说明: native=' + (有原生启动器
  ? '直接机器码 ELF'
  : '引导器自解释器（无 bin/cocn，与 vm 同源；校验力在 eval vs vm）'));
if (失败.length) { console.log('失败包: ' + 失败.join(', ')); process.exit(1); }
console.log('[OK] 全部示例包三通道一致通过');
