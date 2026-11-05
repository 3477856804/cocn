'use strict';
/**
 * coCN 包清单规范（对标 Cargo.toml）
 *
 * 职责：解析 co.toml（TOML 子集）并校验包名/版本/依赖。
 * 说明：此前 cli.js 用 JSON.parse 读 .toml（名实不符），本模块改为真实 TOML 解析。
 * 支持的 TOML 子集：[section] / [a.b] / key = "字符串" / 数组 / 布尔 / 数字 / # 注释。
 */
const fs = require('fs');
const path = require('path');

/** 解析一个 TOML 标量或数组 */
function 解析值(v) {
  v = String(v).trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"(?:[^"\\]|\\.)*"/);
    return m ? m[0].slice(1, -1).replace(/\\"/g, '"') : v;
  }
  if (v.startsWith("'")) {
    const m = v.match(/^'[^']*'/);
    return m ? m[0].slice(1, -1) : v;
  }
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    const inner = end >= 0 ? v.slice(1, end) : v.slice(1);
    if (!inner.trim()) return [];
    return inner.split(',').map((s) => 解析值(s)).filter((x) => x !== '' && x !== null);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

/** 解析 TOML 文本为对象 */
function 解析TOML(文本) {
  const 根 = {};
  let 当前 = 根;
  for (const raw of String(文本).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.includes(']')) {
      const sec = line.slice(1, line.lastIndexOf(']')).trim();
      当前 = sec.split('.').reduce((o, k) => (o[k] = o[k] || {}), 根);
      continue;
    }
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().replace(/^["']|["']$/g, '');
    当前[key] = 解析值(line.slice(i + 1));
  }
  return 根;
}

/** 校验清单字段；失败抛错，成功返回清单对象 */
function 校验(c) {
  const 错误 = [];
  if (!c.name) 错误.push('缺少 name');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(c.name)) {
    错误.push('name 须为 ASCII（字母/数字/_/-，且以字母数字开头）：' + c.name);
  }
  if (!c.version) 错误.push('缺少 version');
  else if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(c.version)) {
    错误.push('version 须为 semver（主.次.修）：' + c.version);
  }
  if (c.dependencies != null && typeof c.dependencies !== 'object') {
    错误.push('dependencies 须为 [dependencies] 表');
  }
  if (错误.length) throw new Error('co.toml 校验失败：' + 错误.join('；'));
  return c;
}

/** 校验清单与包目录的一致性：声明的入口文件必须真的存在。
 *
 * 为什么要这条：0.1.26 之前 19 个示例包的 co.toml 都声明了
 * main = "程序.co"，但包里根本没有这个文件——清单校验当时只查 lib，
 * 于是这处不一致静默存在了很久。cocn run / cocn install 按 main
 * 找可执行入口时才会炸。现在把「声明即必须存在」变成硬规则。
 *
 * @param {object} c 清单对象
 * @param {string} [目录] 包目录；给了才检查文件是否存在
 */
function 校验入口(c, 目录) {
  if (!目录) return c;
  const 缺 = [];
  for (const 键 of ['lib', 'main']) {
    const 文件 = c[键];
    if (!文件) continue;
    if (!fs.existsSync(path.join(目录, 文件))) 缺.push(键 + '=' + 文件);
  }
  if (缺.length) {
    throw new Error('co.toml 声明的入口文件不存在：' + 缺.join('，') + '（要嘛补上文件，要嘛删掉该声明）');
  }
  return c;
}

/** 读取并校验某目录下的 co.toml */
function 读清单(目录) {
  const f = path.join(目录, 'co.toml');
  if (!fs.existsSync(f)) {
    throw new Error('缺少包清单 co.toml（可先运行：cocn new <包名>）');
  }
  return 校验入口(校验(解析TOML(fs.readFileSync(f, 'utf8'))), 目录);
}

/** 生成一个脚手架清单的 TOML 文本 */
function 生成清单文本({ name, 显示名, version, description, main, lib }) {
  return [
    '# coCN 包清单（对标 Cargo.toml）',
    `name = "${name}"`,
    `显示名 = "${显示名 || name}"`,
    `version = "${version || '0.1.0'}"`,
    `description = "${description || ''}"`,
    `keywords = []`,
    `categories = []`,
    `license = "MIT"`,
    `main = "${main || '程序.co'}"`,
    `lib = "${lib || '库.co'}"`,
    '',
    '[dependencies]',
    ''
  ].join('\n');
}

module.exports = { 解析TOML, 解析值, 校验, 校验入口, 读清单, 生成清单文本 };
