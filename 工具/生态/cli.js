'use strict';
/**
 * coCN 包管理器 CLI（对标 cargo）
 *
 * 命令集（15 条）：
 *   new / install / add / remove / update / publish / search / yank / tree
 *   build / run / test / bench / doc / fmt
 *
 * 由 bin/入口.js 分发到此。网络走 COCN_REGISTRY（默认 http://localhost:7878）。
 * 发布鉴权走 COCN_TOKEN（可选，注册表未开启鉴权时可省略）。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const 规范 = require('./规范.js');

const 根 = path.resolve(__dirname, '..', '..');
const COCN_JS = path.join(根, 'bin', '入口.js');
const 注册表 = process.env.COCN_REGISTRY || 'http://localhost:7878';
const 令牌 = process.env.COCN_TOKEN || '';
const 缓存根 = path.join(os.homedir(), '.cocn', 'registry');
fs.mkdirSync(缓存根, { recursive: true });

/* ────────────────── HTTP ────────────────── */

function 请求(方法, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(注册表 + pathname);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (令牌) headers['Authorization'] = 'Bearer ' + 令牌;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 方法, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function 下载文件(名, 版本) {
  return new Promise((resolve, reject) => {
    const u = new URL(注册表 + '/api/v1/crates/' + encodeURIComponent(名) + '/' + encodeURIComponent(版本) + '/download');
    fs.mkdirSync(path.join(缓存根, 名), { recursive: true });
    const out = fs.createWriteStream(path.join(缓存根, 名, 版本 + '.tar.gz'));
    const headers = 令牌 ? { Authorization: 'Bearer ' + 令牌 } : {};
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers }, (res) => {
      res.pipe(out);
      out.on('finish', () => resolve());
    });
    req.on('error', reject);
  });
}

/* ────────────────── 锁文件 ────────────────── */

const LOCK = () => path.join(process.cwd(), 'cocn.lock');

function 读Lock() {
  try { return JSON.parse(fs.readFileSync(LOCK(), 'utf8')); } catch { return {}; }
}
function 写Lock(lock) {
  fs.writeFileSync(LOCK(), JSON.stringify(lock, null, 2));
}

/* ────────────────── semver（最小实现） ────────────────── */

function 拆版本(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function 比版本(a, b) {
  const x = 拆版本(a), y = 拆版本(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/** 版本是否满足 range（支持 ^x.y.z / ~x.y.z / >=x.y.z / 精确） */
function 满足(range, v) {
  const r = String(range).trim();
  if (r === '*' || r === '') return true;
  if (r.startsWith('^') || /^\d/.test(r)) {
    const base = 拆版本(r.replace('^', ''));
    const cur = 拆版本(v);
    if (!base || !cur) return false;
    if (比版本(v, r.replace('^', '')) < 0) return false;
    return cur[0] === base[0];
  }
  if (r.startsWith('~')) {
    const base = 拆版本(r.slice(1));
    const cur = 拆版本(v);
    if (!base || !cur) return false;
    if (比版本(v, r.slice(1)) < 0) return false;
    return cur[0] === base[0] && cur[1] === base[1];
  }
  if (r.startsWith('>=')) return 比版本(v, r.slice(2)) >= 0;
  return 比版本(v, r) === 0;
}

/* ────────────────── 命令实现 ────────────────── */

async function cmd_new(名) {
  if (!名) throw new Error('用法：cocn new <包名>');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(名)) throw new Error('包名须为 ASCII：' + 名);
  const 目录 = path.join(process.cwd(), 名);
  if (fs.existsSync(目录)) throw new Error('目录已存在：' + 目录);
  fs.mkdirSync(目录, { recursive: true });
  fs.writeFileSync(path.join(目录, 'co.toml'), 规范.生成清单文本({ name: 名, 显示名: 名, version: '0.1.0' }));
  // 程序.co 是包的演示入口：与首批包风格一致，展示库里的能力，
  // 兼作冒烟测试（CI 的「包演示冒烟」门禁会逐包跑它）。
  fs.writeFileSync(path.join(目录, '程序.co'),
    '# ' + 名 + ' 演示入口：cocn run ' + 名 + '\n'
    + '导入 "标准库"\n'
    + '导入 "库"\n\n'
    + '输出("=== ' + 名 + ' 演示 ===")\n'
    + '输出("问候: " + 问候("世界"))\n');
  fs.writeFileSync(path.join(目录, '库.co'),
    '# ' + 名 + ' —— 包说明写在这里（对标哪个 crate、提供什么能力）\n'
    + '导入 "标准库"\n\n'
    + '# 问候(名字) -> 字符串：返回中文问候语\n'
    + '函数 问候(名字)\n    返回 "你好，" + 名字\n结束\n');
  // 脚手架只生成源码与测试：生态门禁要求每个包有 测试.co。
  // 仓库纪律只允许根目录一个 README.md（含开发准则），因此不再生成其它 .md。
  fs.writeFileSync(path.join(目录, '测试.co'),
    '# ' + 名 + ' 测试\n导入 "标准库"\n导入 "库"\n\n'
    + '测试用例("问候 带称呼", 函数()\n'
    + '    断言相等(问候("世界"), "你好，世界", "拼接待人称")\n'
    + '结束)\n\n运行所有测试()\n');
  console.log('[coCN] 已创建脚手架 ' + 名 + '（co.toml / 程序.co / 库.co / 测试.co）');
}

async function cmd_publish() {
  const 目录 = process.cwd();
  const toml = 规范.读清单(目录);
  // 仓库不再保留包级 README.md；存在时仍兼容读取，缺省为空。
  let readme = '';
  const readmePath = path.join(目录, 'README.md');
  if (fs.existsSync(readmePath)) readme = fs.readFileSync(readmePath, 'utf8');
  const tarball = path.join(os.tmpdir(), 'cocn-pkg-' + Date.now() + '.tar.gz');
  execFileSync('tar', ['czf', tarball, '--exclude', 'cocn.lock', '-C', 目录, '.'], { stdio: 'ignore' });
  const buf = fs.readFileSync(tarball);
  const checksum = crypto.createHash('sha256').update(buf).digest('hex');
  const r = await 请求('POST', '/api/v1/crates/new', {
    name: toml.name, version: toml.version, 显示名: toml.显示名, description: toml.description,
    keywords: toml.keywords, categories: toml.categories, license: toml.license,
    repository: toml.repository, authors: toml.authors, dependencies: toml.dependencies || {},
    readme, checksum, tarball_base64: buf.toString('base64')
  });
  fs.unlinkSync(tarball);
  if (r.status >= 400) throw new Error('发布失败(' + r.status + ')：' + ((r.body && r.body.error) || ''));
  console.log('[coCN] 已发布 ' + toml.name + '@' + toml.version + '（checksum ' + checksum.slice(0, 12) + '…）');
}

async function cmd_search(词) {
  const r = await 请求('GET', '/api/v1/crates/search?q=' + encodeURIComponent(词 || ''));
  const list = (r.body && r.body.crates) || [];
  if (!list.length) { console.log('[coCN] 无匹配包'); return; }
  for (const c of list) {
    console.log(c.name + '@' + c.最新版本 + '  ' + (c.显示名 || '') + '  ' + (c.description || ''));
  }
}

async function 取包信息(名) {
  const r = await 请求('GET', '/api/v1/crates/' + encodeURIComponent(名));
  if (r.status >= 400 || !r.body) throw new Error('未找到包：' + 名);
  return r.body;
}

async function 装包(名, 版本) {
  const info = await 取包信息(名);
  const v = 版本 || info.最新版本;
  const 版本信息 = (info.versions || []).find((x) => x.version === v);
  if (!版本信息) throw new Error('未找到版本 ' + 名 + '@' + v);
  await 下载文件(名, v);
  const dest = path.join(缓存根, 名, v);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['xzf', path.join(缓存根, 名, v + '.tar.gz'), '-C', dest], { stdio: 'ignore' });
  // 生态约定：把 lib 入口复制为 当前/<包名>.co，供 `导入 "<包名>"` 直接命中（执行导入 的回退路径）
  const 当前目录 = path.join(缓存根, 名, '当前');
  fs.rmSync(当前目录, { recursive: true, force: true });
  fs.mkdirSync(当前目录, { recursive: true });
  let lib名 = '库.co';
  const 包清单 = path.join(dest, 'co.toml');
  if (fs.existsSync(包清单)) {
    try {
      const c = 规范.解析TOML(fs.readFileSync(包清单, 'utf8'));
      if (c.lib) lib名 = c.lib;
    } catch { /* 清单异常时回落默认 库.co */ }
  }
  const lib源 = path.join(dest, lib名);
  if (fs.existsSync(lib源)) fs.copyFileSync(lib源, path.join(当前目录, 名 + '.co'));
  // checksum 校验（供应链不可变性）
  const 实际 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(缓存根, 名, v + '.tar.gz'))).digest('hex');
  if (版本信息.checksum && 实际 !== 版本信息.checksum) {
    throw new Error('checksum 不匹配，拒绝安装 ' + 名 + '@' + v);
  }
  return { v, checksum: 版本信息.checksum || 实际 };
}

async function cmd_install(名) {
  // 指定包名：即装即用（不写 co.toml，语义同 npm i <pkg>）
  if (名) {
    const [pkgName, ver] = 名.split('@');
    const lock = 读Lock();
    const { v, checksum } = await 装包(pkgName, ver);
    lock[pkgName] = { version: v, checksum };
    写Lock(lock);
    console.log('[coCN] 已安装 ' + pkgName + '@' + v + ' -> ' + path.join(缓存根, pkgName, v));
    return;
  }
  const toml = 规范.读清单(process.cwd());
  const deps = toml.dependencies || {};
  const lock = 读Lock();
  const 名表 = Object.keys(deps);
  if (!名表.length) { console.log('[coCN] co.toml 无依赖'); return; }
  for (const 名 of 名表) {
    const { v, checksum } = await 装包(名, lock[名] && lock[名].version);
    lock[名] = { version: v, checksum };
    console.log('[coCN] 已安装 ' + 名 + '@' + v + ' -> ' + path.join(缓存根, 名, v));
  }
  写Lock(lock);
}

async function cmd_add(名) {
  if (!名) throw new Error('用法：cocn add <包名>');
  const [pkgName, ver] = 名.split('@');
  const tomlPath = path.join(process.cwd(), 'co.toml');
  if (!fs.existsSync(tomlPath)) throw new Error('当前目录缺少 co.toml');
  const { v, checksum } = await 装包(pkgName, ver);
  // 追加到 [dependencies] 段（行式插入，避免把依赖拼到 [dependencies] 同一行导致解析错位）
  const range = ver ? '^' + ver : '^' + v;
  const 行 = fs.readFileSync(tomlPath, 'utf8').split('\n');
  let i = 行.findIndex((l) => l.trim() === '[dependencies]');
  if (i < 0) { 行.push('', '[dependencies]'); i = 行.length - 1; }
  let j = i + 1;
  while (j < 行.length && 行[j].trim() !== '' && !行[j].trim().startsWith('[')) j++;
  const 已有 = 行.some((l) => new RegExp('^' + pkgName + '\\s*=').test(l.trim()));
  if (!已有) 行.splice(j, 0, pkgName + ' = "' + range + '"');
  fs.writeFileSync(tomlPath, 行.join('\n'));
  const lock = 读Lock();
  lock[pkgName] = { version: v, checksum };
  写Lock(lock);
  console.log('[coCN] 已添加并安装 ' + pkgName + '@' + v);
}

async function cmd_remove(名) {
  if (!名) throw new Error('用法：cocn remove <包名>');
  fs.rmSync(path.join(缓存根, 名), { recursive: true, force: true });
  const lock = 读Lock();
  delete lock[名];
  写Lock(lock);
  const tomlPath = path.join(process.cwd(), 'co.toml');
  if (fs.existsSync(tomlPath)) {
    const 文本 = fs.readFileSync(tomlPath, 'utf8');
    fs.writeFileSync(tomlPath, 文本.replace(new RegExp('^' + 名 + '\\s*=.*\\n', 'm'), ''));
  }
  console.log('[coCN] 已移除 ' + 名);
}

async function cmd_update() {
  const toml = 规范.读清单(process.cwd());
  const deps = toml.dependencies || {};
  const lock = 读Lock();
  for (const 名 of Object.keys(deps)) {
    const info = await 取包信息(名);
    const 可用 = (info.versions || []).map((x) => x.version).filter((v) => 满足(deps[名], v));
    if (!可用.length) { console.log('[coCN] ' + 名 + ' 无满足 ' + deps[名] + ' 的版本'); continue; }
    可用.sort(比版本);
    const 最新 = 可用[可用.length - 1];
    if (lock[名] && lock[名].version === 最新) { console.log('[coCN] ' + 名 + '@' + 最新 + ' 已是最新'); continue; }
    const { v, checksum } = await 装包(名, 最新);
    lock[名] = { version: v, checksum };
    console.log('[coCN] 已更新 ' + 名 + ' -> ' + v);
  }
  写Lock(lock);
}

async function cmd_yank(参数) {
  const [名, 版本] = 参数;
  if (!名 || !版本) throw new Error('用法：cocn yank <包名> <版本>');
  const r = await 请求('POST', '/api/v1/crates/' + encodeURIComponent(名) + '/' + encodeURIComponent(版本) + '/yank', {});
  if (r.status >= 400) throw new Error('撤回失败(' + r.status + ')：' + ((r.body && r.body.error) || ''));
  console.log('[coCN] 已撤回 ' + 名 + '@' + 版本 + '（不再被新解析选中）');
}

async function cmd_unyank(参数) {
  const [名, 版本] = 参数;
  if (!名 || !版本) throw new Error('用法：cocn unyank <包名> <版本>');
  const r = await 请求('POST', '/api/v1/crates/' + encodeURIComponent(名) + '/' + encodeURIComponent(版本) + '/unyank', {});
  if (r.status >= 400) throw new Error('恢复失败(' + r.status + ')：' + ((r.body && r.body.error) || ''));
  console.log('[coCN] 已恢复 ' + 名 + '@' + 版本 + '（可被新解析选中）');
}

async function cmd_tree() {
  const toml = 规范.读清单(process.cwd());
  const lock = 读Lock();
  const 已见 = new Set();
  function 打印(名, 前缀, 深度) {
    if (深度 > 5) return;
    const 版本 = (lock[名] && lock[名].version) || '?';
    console.log(前缀 + 名 + '@' + 版本);
    if (已见.has(名)) { console.log(前缀 + '  └ (循环)'); return; }
    已见.add(名);
    const 子路径 = path.join(缓存根, 名, 版本, 'co.toml');
    if (!fs.existsSync(子路径)) return;
    const 子 = 规范.解析TOML(fs.readFileSync(子路径, 'utf8'));
    const deps = Object.keys(子.dependencies || {});
    deps.forEach((d, i) => 打印(d, 前缀 + (i === deps.length - 1 ? '  └ ' : '  ├ '), 深度 + 1));
  }
  Object.keys(toml.dependencies || {}).forEach((d) => 打印(d, '', 0));
}

/* —— 本地构建/运行/测试/基准/文档/格式化 —— */

function 跑cocn(参数) {
  const r = spawnSync(process.execPath, [COCN_JS].concat(参数), { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status;
}

function 入口文件() {
  const toml = 规范.读清单(process.cwd());
  return toml.main || '程序.co';
}

function cmd_build() {
  const 入口 = 入口文件();
  const 输出 = process.argv.includes('--输出') ? process.argv[process.argv.indexOf('--输出') + 1] : '程序.out';
  console.log('[coCN] 编译 ' + 入口 + ' -> ' + 输出 + '（原生机器码后端）');
  const code = 跑cocn(['--编译', 入口, 输出]);
  if (code !== 0) throw new Error('编译失败');
}

function cmd_run() {
  const code = 跑cocn([入口文件()]);
  if (code !== 0) process.exitCode = code;
}

function 收集文件(关键词) {
  const 目录 = process.cwd();
  const 命中 = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.') || f === 'node_modules') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.co') && f.includes(关键词)) 命中.push(p);
    }
  })(目录);
  return 命中;
}

function cmd_test() {
  let 文件 = 收集文件('测试');
  if (!文件.length) 文件 = 收集文件('test');
  if (!文件.length) { console.log('[coCN] 未找到测试文件（*测试*.co）'); return; }
  let 失败 = 0;
  for (const f of 文件) {
    console.log('—— ' + path.relative(process.cwd(), f));
    if (跑cocn([f]) !== 0) 失败++;
  }
  console.log(失败 ? '[coCN] 测试失败 ' + 失败 + ' 个文件' : '[coCN] 测试全部通过（' + 文件.length + ' 个文件）');
  if (失败) throw new Error('测试失败');
}

function cmd_bench() {
  let 文件 = 收集文件('基准');
  if (!文件.length) 文件 = 收集文件('bench');
  if (!文件.length) { console.log('[coCN] 未找到基准文件（*基准*.co）'); return; }
  for (const f of 文件) {
    console.log('—— ' + path.relative(process.cwd(), f));
    跑cocn([f]);
  }
}

function cmd_doc() {
  const 生成器 = path.join(__dirname, 'docgen.js');
  if (!fs.existsSync(生成器)) throw new Error('未找到文档生成器：' + 生成器);
  const r = spawnSync(process.execPath, [生成器, process.cwd()], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('文档生成失败');
}

function cmd_fmt() {
  // 保守格式化（对标 rustfmt 的入门档）：去行尾空白、压缩 3+ 空行、确保文件以换行结尾。
  // 完整中文缩进/关键字格式化属 0.3.x 范围，此处不做破坏性改写。
  let 计数 = 0;
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.') || f === 'node_modules') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.co')) continue;
      const 原 = fs.readFileSync(p, 'utf8');
      let 新 = 原
        .split(/\r?\n/)
        .map((l) => l.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s*$/, '\n');
      if (新 !== 原) { fs.writeFileSync(p, 新); 计数++; }
    }
  })(process.cwd());
  console.log('[coCN] 已格式化 ' + 计数 + ' 个 .co 文件（保守：空白/换行规整）');
}

/* ────────────────── 分发 ────────────────── */

async function 运行(子命令, 参数) {
  switch (子命令) {
    case 'new': return cmd_new(参数[0]);
    case 'publish': return cmd_publish();
    case 'search': return cmd_search(参数[0] || '');
    case 'install': return cmd_install(参数[0]);
    case 'add': return cmd_add(参数[0]);
    case 'remove': return cmd_remove(参数[0]);
    case 'update': return cmd_update();
    case 'yank': return cmd_yank(参数);
    case 'unyank': return cmd_unyank(参数);
    case 'tree': return cmd_tree();
    case 'build': return cmd_build();
    case 'run': return cmd_run();
    case 'test': return cmd_test();
    case 'bench': return cmd_bench();
    case 'doc': return cmd_doc();
    case 'fmt': return cmd_fmt();
    default: throw new Error('未知生态命令：' + 子命令);
  }
}

module.exports = { 运行 };
