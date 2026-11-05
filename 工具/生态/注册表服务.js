#!/usr/bin/env node
'use strict';
/**
 * coCN 包注册表服务（对标 crates.io 的 Web 注册表）
 *
 * 提供发布 / 搜索 / 下载 / 包详情 / yank·unyank API 与前端页。
 * 开发期存储落在 os.tmpdir()（不污染仓库），部署期可切到数据库 + 对象存储（方案 B）。
 *
 * 启动：node 工具/生态/注册表服务.js   （端口 COCR_PORT，默认 7878）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const 存储根 = path.join(os.tmpdir(), 'cocn-registry');
fs.mkdirSync(存储根, { recursive: true });
const 端口 = process.env.COCR_PORT ? parseInt(process.env.COCR_PORT, 10) : 7878;

function 包目录(名) { return path.join(存储根, 名); }
function 索引文件(名) { return path.join(包目录(名), 'index.json'); }
function tarball文件(名, 版本) { return path.join(包目录(名), 版本 + '.tar.gz'); }

function 读索引(名) {
  try { return JSON.parse(fs.readFileSync(索引文件(名), 'utf8')); } catch { return null; }
}
function 写索引(名, 数据) {
  fs.mkdirSync(包目录(名), { recursive: true });
  fs.writeFileSync(索引文件(名), JSON.stringify(数据, null, 2));
}
function 列出所有() {
  if (!fs.existsSync(存储根)) return [];
  return fs.readdirSync(存储根)
    .filter(n => fs.existsSync(索引文件(n)))
    .map(n => 读索引(n))
    .filter(Boolean)
    .sort((a, b) => (b.最新发布时间 || '').localeCompare(a.最新发布时间 || ''));
}

function 发送(res, 码, obj) {
  res.writeHead(码, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function 解析Body(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}
function 转义(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function 转义文本(s) { return 转义(s).replace(/\n/g, '<br>'); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    // 前端首页（对标 crates.io 前端）
    if (req.method === 'GET' && p === '/') {
      const 列表 = 列出所有();
      let html = '<!doctype html><meta charset=utf-8><title>coCN 包注册表</title>'
        + '<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 16px}'
        + 'li{margin:6px 0;list-style:none}.muted{color:#888}.tag{background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;margin:0 2px;font-size:12px}'
        + 'a{color:#166}.yank{color:#c33;font-size:12px;border:1px solid #c33;border-radius:4px;padding:1px 5px}</style>'
        + '<h1>coCN 包注册表</h1><p class="muted">对标 crates.io · 共 ' + 列表.length + ' 个包</p>'
        + '<p class="muted">搜索：<code>GET /api/v1/crates/search?q=关键词</code> · 详情：<code>/crates/&lt;包名&gt;</code></p><ul>';
      for (const c of 列表) {
        html += '<li><a href="/crates/' + 转义(c.name) + '"><b>' + 转义(c.name) + '</b></a>@' + 转义(c.最新版本)
          + ' ' + 转义(c.显示名 || '') + ' <span class="muted">— ' + 转义(c.description || '') + '</span>';
        if (c.yanked) html += ' <span class="yank">已撤回最新</span>';
        const 标签 = [].concat(c.keywords || [], c.categories || []).filter(Boolean);
        if (标签.length) html += '<br>' + 标签.map(t => '<span class="tag">' + 转义(t) + '</span>').join('');
        html += '</li>';
      }
      html += '</ul>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // 包详情页
    let dm = p.match(/^\/crates\/([^\/]+)$/);
    if (req.method === 'GET' && dm) {
      const c = 读索引(decodeURIComponent(dm[1]));
      if (!c) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('未找到包'); return; }
      let html = '<!doctype html><meta charset=utf-8><title>' + 转义(c.name) + ' · coCN 包注册表</title>'
        + '<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 16px}'
        + 'code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.muted{color:#888}.yank{color:#c33;border:1px solid #c33;border-radius:4px;padding:1px 5px}'
        + 'h2{border-bottom:1px solid #eee;padding-bottom:4px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 10px;text-align:left}</style>'
        + '<p><a href="/">← 返回注册表</a></p>'
        + '<h1>' + 转义(c.显示名 || c.name) + ' <span class="muted">' + 转义(c.name) + '</span></h1>'
        + '<p>' + 转义文本(c.description || '') + '</p>'
        + '<p class="muted">版本 ' + 转义(c.最新版本) + ' · license ' + 转义(c.license || '—')
        + (c.repository ? ' · <a href="' + 转义(c.repository) + '">仓库</a>' : '')
        + (c.authors ? ' · 作者 ' + 转义(c.authors) : '') + '</p>';
      if (c.keywords && c.keywords.length) html += '<p class="muted">关键词：' + c.keywords.map(t => '<code>' + 转义(t) + '</code>').join(' ') + '</p>';
      if (c.categories && c.categories.length) html += '<p class="muted">分类：' + c.categories.map(t => '<code>' + 转义(t) + '</code>').join(' ') + '</p>';
      html += '<h2>版本</h2><table><tr><th>版本</th><th>发布时间</th><th>状态</th></tr>';
      for (const v of (c.versions || []).slice().reverse()) {
        html += '<tr><td>' + 转义(v.version) + '</td><td>' + 转义(v.发布时间 || '') + '</td>'
          + '<td>' + (v.yanked ? '<span class="yank">已撤回</span>' : '正常') + '</td></tr>';
      }
      html += '</table>';
      if (c.readme) {
        html += '<h2>文档</h2><div class="readme">' + 转义Text块(c.readme) + '</div>';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // 搜索
    if (req.method === 'GET' && p === '/api/v1/crates/search') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const 列表 = 列出所有().filter(c =>
        c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
        || (c.显示名 || '').toLowerCase().includes(q)
        || (c.keywords || []).some(k => k.toLowerCase().includes(q))
        || (c.categories || []).some(k => k.toLowerCase().includes(q)));
      return 发送(res, 200, { crates: 列表 });
    }
    // 包信息
    let m = p.match(/^\/api\/v1\/crates\/([^\/]+)$/);
    if (req.method === 'GET' && m) {
      const i = 读索引(decodeURIComponent(m[1]));
      if (!i) return 发送(res, 404, { error: '未找到包' });
      return 发送(res, 200, i);
    }
    // 下载 tarball
    m = p.match(/^\/api\/v1\/crates\/([^\/]+)\/([^\/]+)\/download$/);
    if (req.method === 'GET' && m) {
      const f = tarball文件(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      if (!fs.existsSync(f)) return 发送(res, 404, { error: '未找到版本' });
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      fs.createReadStream(f).pipe(res);
      return;
    }
    // 发布
    if (req.method === 'POST' && p === '/api/v1/crates/new') {
      const body = await 解析Body(req);
      let pkg; try { pkg = JSON.parse(body); } catch { return 发送(res, 400, { error: 'JSON 无效' }); }
      const { name, version, tarball_base64 } = pkg;
      if (!name || !version || !tarball_base64) return 发送(res, 400, { error: '缺少 name/version/tarball_base64' });
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) return 发送(res, 400, { error: '版本号须为 semver' });
      const buf = Buffer.from(tarball_base64, 'base64');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      fs.mkdirSync(包目录(name), { recursive: true });
      fs.writeFileSync(tarball文件(name, version), buf);
      const 现在 = new Date().toISOString();
      let i = 读索引(name) || {
        name, 显示名: pkg.显示名 || name, description: pkg.description || '',
        keywords: pkg.keywords || [], categories: pkg.categories || [],
        license: pkg.license || '', repository: pkg.repository || '',
        authors: pkg.authors || '', versions: []
      };
      if (i.versions.find(v => v.version === version)) return 发送(res, 409, { error: '版本已存在' });
      i.显示名 = pkg.显示名 || i.显示名;
      i.description = pkg.description || i.description;
      i.keywords = pkg.keywords || i.keywords;
      i.categories = pkg.categories || i.categories;
      i.license = pkg.license || i.license;
      i.repository = pkg.repository || i.repository;
      i.authors = pkg.authors || i.authors;
      i.readme = pkg.readme || i.readme || '';
      i.versions.push({ version, deps: pkg.dependencies || {}, checksum: sha, yanked: false, 发布时间: 现在 });
      i.最新版本 = version;
      i.最新发布时间 = 现在;
      i.yanked = false;
      写索引(name, i);
      return 发送(res, 200, { ok: true, name, version, checksum: sha });
    }
    // yank / unyank
    m = p.match(/^\/api\/v1\/crates\/([^\/]+)\/([^\/]+)\/(yank|unyank)$/);
    if (req.method === 'POST' && m) {
      const i = 读索引(decodeURIComponent(m[1]));
      const v = decodeURIComponent(m[2]);
      if (!i) return 发送(res, 404, { error: '未找到包' });
      const 目标 = i.versions.find(x => x.version === v);
      if (!目标) return 发送(res, 404, { error: '未找到版本 ' + v });
      目标.yanked = m[3] === 'yank';
      i.yanked = i.versions.every(x => x.yanked);
      写索引(i.name, i);
      return 发送(res, 200, { ok: true, name: i.name, version: v, yanked: 目标.yanked });
    }
    return 发送(res, 404, { error: '未找到路由' });
  } catch (e) {
    return 发送(res, 500, { error: e.message });
  }
});

/** 把 README 文本做轻量 Markdown 渲染（标题/代码/段落），防 XSS */
function 转义Text块(text) {
  return 转义(text)
    .replace(/^# (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h4>$1</h4>')
    .replace(/```[\s\S]*?```/g, (m) => '<pre><code>' + m.replace(/```/g, '') + '</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

server.listen(端口, () => console.log('[coCN 注册表] 监听 http://localhost:' + 端口 + ' (存储: ' + 存储根 + ')'));
