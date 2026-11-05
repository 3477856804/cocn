#!/usr/bin/env node
'use strict';
/**
 * 发布脚本：把「源码里写的版本号」原样发到 npm
 *
 * 原则：
 *   - 版本号只有一个来源 —— 仓库 package.json 的 version，脚本绝不自动升版
 *   - 版本已存在就跳过（重复触发流水线时不会报错，也不会覆盖）
 *   - 发布顺序：平台子包（cocn-linux-x64 / -arm64）→ 主包
 *
 * 所以「发新版」= 改 package.json 的 version 并提交，流水线自动发布。
 *
 * 用法：
 *   NPM_TOKEN=xxx node 工具/发布/自动发布.js            # 真正发布
 *   NPM_TOKEN=xxx node 工具/发布/自动发布.js --预演     # 只打印将要发布的版本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const 主包路径 = path.join(ROOT, 'package.json');
const 主包 = JSON.parse(fs.readFileSync(主包路径, 'utf8'));
const 预演 = process.argv.includes('--预演');
const 版本 = 主包.version;
const 标签 = 预演 ? 'pipe' : 'inherit';

function 运行(命令, 目录) {
  return execSync(命令, { cwd: 目录 || ROOT, encoding: 'utf8', stdio: 标签 });
}

/** 该版本是否已经在 npm 上（已存在就跳过，保证可重复执行） */
function 已发布(包名, 版本号) {
  try {
    const 结果 = execSync(`npm view ${包名}@${版本号} version`, { encoding: 'utf8', stdio: 'pipe' }).trim();
    return 结果 === 版本号;
  } catch (e) {
    return false;
  }
}

/** 发布单个包；npm 对新包有「上一个还没处理完」的 409，退避重试几次 */
function 发布(目录, 说明) {
  for (let 次 = 1; ; 次++) {
    try {
      运行('npm publish --access public', 目录);
      return;
    } catch (e) {
      const 输出 = String(e.stderr || '') + String(e.message || '');
      if (!/E409|E500|fully processed|too quickly/.test(输出) || 次 >= 4) throw e;
      console.log('  registry 还在处理上一个包，等待后重试（第 ' + 次 + ' 次）: ' + 说明);
      execSync('sleep 20');
    }
  }
}

// 1) 平台子包：版本必须与主包完全一致
const 平台目录 = path.join(ROOT, '工具', '发布', '平台包');
const 平台表 = ['linux-x64', 'linux-arm64'];
const 子包清单 = [];
for (const 平台 of 平台表) {
  const 清单路径 = path.join(平台目录, 平台, 'package.json');
  if (!fs.existsSync(清单路径)) continue;
  if (!fs.existsSync(path.join(平台目录, 平台, 'bin', '引导器'))) {
    console.log('跳过平台（仓库内没有预置二进制）: ' + 平台);
    continue;
  }
  const 清单 = JSON.parse(fs.readFileSync(清单路径, 'utf8'));
  清单.version = 版本;
  fs.writeFileSync(清单路径, JSON.stringify(清单, null, 2) + '\n');
  子包清单.push({ 目录: path.join(平台目录, 平台), 名: 清单.name });
}

主包.optionalDependencies = 主包.optionalDependencies || {};
for (const 子 of 子包清单) 主包.optionalDependencies[子.名] = 版本;
fs.writeFileSync(主包路径, JSON.stringify(主包, null, 2) + '\n');

console.log(`源码版本 ${版本}：` + [主包.name, ...子包清单.map(s => s.名)].join(', '));

if (预演) {
  for (const 子 of 子包清单) console.log((已发布(子.名, 版本) ? '已存在，跳过 ' : '将发布 ') + 子.名 + '@' + 版本);
  console.log((已发布(主包.name, 版本) ? '已存在，跳过 ' : '将发布 ') + 主包.name + '@' + 版本);
  process.exit(0);
}

// 2) 先子包后主包（否则装主包的瞬间会找不到子包）
for (const 子 of 子包清单) {
  if (已发布(子.名, 版本)) {
    console.log('已存在，跳过 ' + 子.名 + '@' + 版本);
    continue;
  }
  console.log('发布 ' + 子.名 + '@' + 版本);
  发布(子.目录, 子.名);
}

if (已发布(主包.name, 版本)) {
  console.log('已存在，跳过 ' + 主包.name + '@' + 版本);
  process.exit(0);
}
console.log('发布 ' + 主包.name + '@' + 版本);
发布(ROOT, 主包.name);
console.log('完成：' + 主包.name + '@' + 版本);
