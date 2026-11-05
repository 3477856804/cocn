#!/usr/bin/env node
'use strict';
/**
 * 自动发布脚本：Gitee 源码一更新，就发布到 npm
 *
 * 做的事情（按 npm 平台子包 → 主包的顺序）：
 *   1) 查询 npm 上最新的版本号，算出下一个补丁版本（x.y.z + 1）
 *   2) 用仓库内预置的引导二进制重建各平台子包（cocn-linux-x64 / -arm64）
 *   3) 依次发布平台子包与主包
 *
 * 为什么版本号从 npm 取而不是从仓库取：
 *   仓库里的 package.json 版本是「上一次提交时的版本」，而 CI 可能连续
 *   触发多次发布；从 npm 取最新再 +1 可以保证版本永远不重复。
 *
 * 用法：
 *   NPM_TOKEN=xxx node 工具/发布/自动发布.js            # 真正发布
 *   NPM_TOKEN=xxx node 工具/发布/自动发布.js --预演     # 只打印将发布的版本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const 主包路径 = path.join(ROOT, 'package.json');
const 主包 = JSON.parse(fs.readFileSync(主包路径, 'utf8'));
const 预演 = process.argv.includes('--预演');

function 运行(命令, 目录) {
  return execSync(命令, { cwd: 目录 || ROOT, encoding: 'utf8', stdio: 预演 ? 'pipe' : 'inherit' });
}

/** 下一个补丁版本：由 版本.js 统一计算（0.0.1 起） */
function 下一版(版本) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(版本);
  if (!m) throw new Error('版本号格式不合法: ' + 版本);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// 1) 以 npm 上的最新版本为基准（刚发布时 registry 可能还没刷新，回退到本地版本）
let 线上版本 = 主包.version;
try {
  线上版本 = execSync(`npm view ${主包.name} version`, { encoding: 'utf8' }).trim() || 主包.version;
} catch (e) {
  console.log('读取 npm 版本失败，按本地版本继续: ' + e.message.split('\n')[0]);
}
const 新版本 = 下一版(线上版本);
console.log(`线上 ${线上版本} -> 本次发布 ${新版本}`);

// 2) 平台子包：版本必须与主包一致
const 平台目录 = path.join(ROOT, '工具', '发布', '平台包');
const 平台表 = ['linux-x64', 'linux-arm64'];
const 源二进制 = {
  'linux-x64': path.join(平台目录, 'linux-x64', 'bin', '引导器'),
  'linux-arm64': path.join(平台目录, 'linux-arm64', 'bin', '引导器'),
};
const 子包清单 = [];
for (const 平台 of 平台表) {
  if (!fs.existsSync(源二进制[平台])) {
    console.log('跳过平台（仓库内没有预置二进制）: ' + 平台);
    continue;
  }
  const 清单路径 = path.join(平台目录, 平台, 'package.json');
  const 清单 = JSON.parse(fs.readFileSync(清单路径, 'utf8'));
  子包清单.push({ 目录: path.join(平台目录, 平台), 名: 清单.name });
}

if (预演) {
  console.log('预演：将发布 ' + 子包清单.map(s => s.名 + '@' + 新版本).join(', ') + ' 与 ' + 主包.name + '@' + 新版本);
  process.exit(0);
}

// 3) 写版本：平台子包 + 主包
for (const 平台 of 平台表) {
  const 清单路径 = path.join(平台目录, 平台, 'package.json');
  if (!fs.existsSync(清单路径)) continue;
  const 清单 = JSON.parse(fs.readFileSync(清单路径, 'utf8'));
  清单.version = 新版本;
  fs.writeFileSync(清单路径, JSON.stringify(清单, null, 2) + '\n');
}
主包.version = 新版本;
主包.optionalDependencies = 主包.optionalDependencies || {};
for (const 子 of 子包清单) 主包.optionalDependencies[子.名] = 新版本;
fs.writeFileSync(主包路径, JSON.stringify(主包, null, 2) + '\n');

// 4) 发布顺序：先子包后主包（否则装主包的瞬间会找不到子包）
for (const 子 of 子包清单) {
  console.log('\n发布 ' + 子.名 + '@' + 新版本);
  运行('npm publish --access public', 子.目录);
}
console.log('\n发布 ' + 主包.name + '@' + 新版本);
运行('npm publish --access public', ROOT);
console.log('\n完成：' + 主包.name + '@' + 新版本);
