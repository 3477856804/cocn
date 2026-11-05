#!/usr/bin/env node
'use strict';
/**
 * coCN 文档生成器（对标 docs.rs：从源码注释自动生成 API 文档）
 *
 * 扫描包目录内所有 .co 文件，提取 `函数 名字(参数)` 上方连续的 `#` 注释块，
 * 输出纯文本到 docs/API.txt，并打印摘要。
 * 仓库纪律只允许根目录一个 README.md（含开发准则），因此这里不再生成其它 .md。
 *
 * 用法：node 工具/生态/docgen.js <包目录>
 */
const fs = require('fs');
const path = require('path');

function 遍历(目录) {
  const 命中 = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.') || f === 'node_modules') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (f.endsWith('.co')) 命中.push(p);
    }
  })(目录);
  return 命中;
}

/** 提取某函数定义上方紧邻的 `#` 注释块（到空行/非空非 # 行停止） */
function 提取文档(行, i) {
  const 块 = [];
  let j = i - 1;
  while (j >= 0) {
    const t = 行[j].trim();
    if (t.startsWith('#')) 块.unshift(行[j].replace(/^\s*#\s?/, ''));
    else if (t === '') { if (块.length) break; } // 空行：若有注释则停止（允许注释上方空行）
    else break;
    j--;
  }
  return 块;
}

/** 取待文档化的文件：优先 co.toml 的 lib 入口；
 *  没有清单时退化为「所有 .co 但排除测试/程序入口」，避免测试注释泄漏进 API 文档。 */
function 源文件(目录) {
  const tf = path.join(目录, 'co.toml');
  const 规范 = (() => { try { return require('./规范.js'); } catch (e) { return null; } })();
  let lib = null;
  if (规范 && fs.existsSync(tf)) {
    try { lib = 规范.读清单(目录).lib || null; } catch (e) { lib = null; }
  }
  if (lib && fs.existsSync(path.join(目录, lib))) return [path.join(目录, lib)];
  return 遍历(目录).filter((p) => {
    const b = path.basename(p);
    return !/测试/.test(b) && b !== '程序.co' && b !== 'main.co';
  });
}

function 生成(目录) {
  const 文件 = 源文件(目录);
  const 概述 = [];
  const 函数列表 = [];
  for (const f of 文件) {
    const 源码 = fs.readFileSync(f, 'utf8');
    const 行 = 源码.split(/\r?\n/);
    // 文件头概述：第一个非空 # 注释块（位于任何函数之前）
    for (let i = 0; i < 行.length; i++) {
      const t = 行[i].trim();
      if (t.startsWith('函数 ')) break;
      if (t.startsWith('#') && 概述.length < 8) 概述.push(行[i].replace(/^\s*#\s?/, ''));
    }
    const re = /^函数\s+([^\s(（]+)\s*\(([^)]*)\)/;
    for (let i = 0; i < 行.length; i++) {
      const m = 行[i].match(re);
      if (!m) continue;
      函数列表.push({ 名: m[1], 签名: m[0].replace(/^函数\s*/, ''), 文档: 提取文档(行, i).join('\n') });
    }
  }
  const 包名 = (() => {
    const tf = path.join(目录, 'co.toml');
    if (fs.existsSync(tf)) {
      const txt = fs.readFileSync(tf, 'utf8');
      const nm = txt.match(/name\s*=\s*"([^"]+)"/);
      return nm ? nm[1] : path.basename(目录);
    }
    return path.basename(目录);
  })();

  let md = '# ' + 包名 + ' — API 文档\n\n';
  // 包概述（含 ===== 之类横幅）用引用块承载，避免裸 = 行破坏 Markdown 排版
  if (概述.length) { md += 概述.map((l) => '> ' + l).join('\n') + '\n\n'; }
  md += '> 本文件由 `cocn doc` 自动生成（对标 docs.rs）。共 ' + 函数列表.length + ' 个函数。\n\n';
  md += '## 函数\n\n';
  if (!函数列表.length) md += '（无导出的函数定义）\n';
  for (const fn of 函数列表) {
    md += '### ' + fn.名 + '\n\n';
    md += '```co\n' + fn.签名 + '\n```\n\n';
    if (fn.文档) md += fn.文档 + '\n\n';
    else md += '_（暂无注释文档）_\n\n';
  }
  return md;
}

function 主() {
  const 目录 = process.argv[2] || process.cwd();
  const md = 生成(目录);
  const outDir = path.join(目录, 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'API.txt');
  fs.writeFileSync(out, md);
  console.log('[coCN] 已生成文档 -> ' + out + '（' + (md.match(/^### /gm) || []).length + ' 个函数）');
}

主();
