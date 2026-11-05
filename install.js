#!/usr/bin/env node
/**
 * coCN npm 包 postinstall 脚本
 *
 * 职责（刻意做得很窄）：
 *   1) 清理旧版本留下的编译缓存（~/.cocn/cache）；
 *   2) 若本机有 gcc/clang，用仓库里的 启动器.c 构建【原生加速器】bin/cocn
 *      （把「运行 coCN 程序」这件事本身变成原生速度）。
 *
 * 引导器（宿主 C 自举解释器，语义真值参照）**不在这里下载**：
 * 它由平台专属子包提供，主包通过 optionalDependencies 引用
 * （@yeyelailou/co-linux-x64 / -linux-arm64 …），
 * npm 会自动只安装与当前平台匹配的那个 —— 这与 deno / bun / node
 * 的发布方式一致：装完即用，不依赖 postinstall 联网。
 *
 * 找不到引导器时 bin/入口.js 会给出明确提示，不会静默失败。
 *
 * 修复（2026-11-02，本地复现）：直接 git clone 后 make test 37/37 全败，
 * 根因正是这里——本机没有 npm 平台子包，bin/引导器根本不存在，而
 * 仓库里 工具/发布/平台包/<平台>/bin/引导器 明明就有同平台二进制。
 * 所以下面加了仓库内兜底：node_modules 里找不到时，从仓库内平台包
 * 复制一份到 bin/引导器并补执行位；npm 正式安装时子包优先，行为不变。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 包版本：用于 ~/.cocn/abi-version 缓存指纹与 -DCOCN_ABI 编译指纹。
// 必须跟随 package.json —— 此前硬编码为 '0.1.17'，导致「发版即自动作废
// 上一版缓存产物」这一设计从未生效（当前版本恒等于硬编码值，提前 return）。
const VERSION = (() => {
  try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
})();
const BIN_DIR = path.join(__dirname, 'bin');
const NATIVE_DIR = path.join(__dirname, '工具', '原生编译器');

function log(msg) {
  console.log(`\x1b[34m[coCN]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.warn(`\x1b[33m[coCN!]\x1b[0m ${msg}`);
}
function error(msg) {
  console.error(`\x1b[31m[coCN!!]\x1b[0m ${msg}`);
}

/** 清理旧版留下的编译缓存。
 *
 * 为什么需要：缓存指纹现在掺了包版本（-DCOCN_ABI="cocn-direct-<版本>"），
 * 升级后每个程序都会重编一遍，这是对的；但旧产物只是「不可达」，
 * 还躺在 ~/.cocn/cache/ 里——里面可能有 0.1.14 那批「算错」的 ELF，
 * 占着磁盘还容易被误当有效产物。所以发版时按版本戳清一次。
 *
 * 安全边界（这是删用户主目录下的东西，必须收敛）：
 *   - 只动 ~/.cocn/cache 这一层，不递归；
 *   - 只删【普通文件】（lstat，不是软链接、不是目录）；
 *   - 文件名必须是 16 位十六进制，或 <16位hex>.tmp<数字>（原子写的临时名）；
 *   - 版本戳文件本身不参与匹配（前缀不是 16 位 hex）。
 * 任何一步出错都只 warn，绝不中断安装。 */
function 清理旧版缓存() {
  const home = process.env.HOME || require('os').homedir();
  if (!home) return;
  const cache = path.join(home, '.cocn', 'cache');
  const stamp = path.join(home, '.cocn', 'abi-version');
  let 当前 = null;
  try { 当前 = fs.readFileSync(stamp, 'utf8').trim(); } catch (e) { /* 首装 */ }
  if (当前 === VERSION) return;              // 同版本重复安装，不动任何文件

  const 名字 = /^[0-9a-f]{16}(\.tmp\d+)?$/;
  let 删 = 0, 跳 = 0;
  try {
    for (const f of fs.readdirSync(cache)) {
      if (!名字.test(f)) { 跳++; continue; }
      const p = path.join(cache, f);
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile()) { 跳++; continue; }   // 目录/软链接一律不碰
        fs.unlinkSync(p); 删++;
      } catch (e) { 跳++; }
    }
  } catch (e) {
    return;                                     // 目录不存在 = 没缓存，正常
  }
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, VERSION + '\n');
  } catch (e) { /* 写戳失败不影响正确性 */ }
  if (删 || 跳) log(`已清理旧版编译缓存：删除 ${删} 个产物，保留 ${跳} 项非产物文件`);
}

/** 构建原生加速器 bin/cocn（把「运行 coCN 程序」变成原生速度）。
 *
 * 没有编译器不影响可用性：引导器自解释器通道照样能跑，结果一致，只是慢。
 * 所以这里任何失败都只 warn，不让安装失败。 */
function 构建原生加速器() {
  if (process.platform === 'win32') {
    warn('Windows 暂不构建原生加速器，回退自解释器模式');
    return;
  }
  const 源码 = path.join(NATIVE_DIR, '启动器.c');
  const 产物 = path.join(BIN_DIR, 'cocn');
  if (!fs.existsSync(源码)) {
    warn('未找到 启动器.c，跳过原生加速器构建（引导器通道仍可用）');
    return;
  }
  let 编译器 = null;
  for (const c of ['cc', 'gcc', 'clang']) {
    try {
      execSync(`command -v ${c}`, { encoding: 'utf8', timeout: 10000 });
      编译器 = c;
      break;
    } catch (e) { /* 试下一个 */ }
  }
  if (!编译器) {
    warn('未检测到 C 编译器，跳过原生加速器构建（引导器通道仍可用）');
    return;
  }
  // 引号嵌套要小心（execSync 走 shell）：
  //   错：-DCOCN_ABI=\"...\"  → shell 吃掉反斜杠，C 侧收到裸 token
  //   错：-DCOCN_ABI='...'    → shell 单引号被剥掉，同样是裸 token
  //   对：-DCOCN_ABI='"..."'  → shell 单引号保住，C 双引号原样进 C 源码
  const abi = `-DCOCN_ABI='"cocn-direct-${VERSION}"'`;
  let 成功 = false;
  let 最后错误 = '';
  for (const 附加 of ['-static', '']) {
    // execSync 在退出码非 0 时会抛异常，所以用 try/catch 判成败；
    // 不能只看「有没有抛」就当成功（早期版本把失败当成功，
    // 于是编译失败仍打印「原生组件已构建」，实测 Termux 上误报）。
    try {
      execSync(`${编译器} -O2 ${附加} ${abi} -o "${产物}" "${源码}"`, {
        encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe']
      });
      成功 = true;
      break;
    } catch (e) {
      最后错误 = ((e.stderr || '') + (e.stdout || '') + (e.message || '')).toString()
        .split('\n').filter(Boolean).slice(0, 2).join(' | ');
    }
  }
  if (!成功) {
    warn('原生加速器构建失败（静态与动态都不行），AOT 加速不可用' + (最后错误 ? '：' + 最后错误 : ''));
    warn('coCN 仍可用：走引导器自解释器通道（慢一些，但结果一致）');
    // 编译失败可能留下半成品产物：必须删掉，
    // 否则 bin/cocn 存在但跑不起来，bin/入口.js 的 启动器可用()
    // 只看魔数与架构，会把这个坏文件当成可用通道去执行。
    try { if (fs.existsSync(产物)) fs.unlinkSync(产物); } catch (e) { /* 忽略 */ }
    return;
  }
  try { fs.chmodSync(产物, 0o755); } catch (e) { /* 忽略 */ }
  log('原生加速器已构建（AOT 加速可用）');
}

/** 给需要可执行的产物补上执行位。
 *
 * 为什么需要：
 *   1) 平台子包里的引导器 —— npm 解包不保留可执行位（实测装完是 -rw-------），
 *      而引导器必须能被 execve 执行；缺执行位时 bin/入口.js 与 C 启动器
 *      的 X_OK 检查都会失败，表现为「找不到引导器」，而文件明明在那。
 *   2) bin 入口 —— npm 只建符号链接，目标的执行位要靠 postinstall 补
 *      （打包机可能是只读分区，chmod 落不了盘，git 记录的 100755 也不生效）。
 *
 * 缺执行位不影响安装是否成功，但会让全局 cocn 命令报
 * "bad interpreter" / "No such file or directory" —— 所以这里统一补齐。
 */
function 补执行位(路径列表) {
  for (const p of 路径列表) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if ((st.mode & 0o111) !== 0) continue;   // 已有执行位
      fs.chmodSync(p, st.mode | 0o755);
      log('已补执行位: ' + p);
    } catch (e) { /* 忽略 */ }
  }
}

/** 平台子包里的引导器（可能是嵌套或同级两种布局） */
function 找平台子包引导器() {
  const 平台 = (process.platform === 'android' ? 'linux' : process.platform) + '-' +
    (process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : ''));
  if (!平台.endsWith('-x64') && !平台.endsWith('-arm64')) return [];
  const 名 = '@yeyelailou/co-' + 平台;
  const 命中 = [];
  let 目录 = __dirname;
  for (let i = 0; i < 6; i++) {
    for (const 底 of [
      path.join(目录, 'node_modules', 名, 'bin'),
      path.join(目录, '..', 'node_modules', 名, 'bin'),
    ]) {
      for (const f of ['引导器', '引导器.exe']) {
        const p = path.join(底, f);
        if (fs.existsSync(p)) 命中.push(p);
      }
    }
    目录 = path.dirname(目录);
    if (目录 === path.dirname(目录)) break;
  }
  return 命中;
}

/** 仓库内兜底：git clone 后没有 npm 平台子包时，从仓库自带的
 *  工具/发布/平台包/<平台>/bin/引导器 复制到 bin/引导器。
 *  只在 bin/引导器不存在时复制，不覆盖已有文件；复制后补执行位。
 *  架构不匹配时不复制（避免 bin/入口.js 把错架构二进制当成可用通道）。 */
function 复制仓库内平台引导器() {
  const 目标 = path.join(BIN_DIR, '引导器');
  try { if (fs.existsSync(目标)) return; } catch (e) { return; }
  const 平台 = (process.platform === 'android' ? 'linux' : process.platform) + '-' +
    (process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : ''));
  if (!平台.endsWith('-x64') && !平台.endsWith('-arm64')) return;
  const 源 = path.join(__dirname, '工具', '发布', '平台包', 平台, 'bin', '引导器');
  try {
    if (!fs.existsSync(源)) { warn('仓库内也没有对应平台的引导器：' + 源); return; }
    const buf = Buffer.alloc(20);
    const fd = fs.openSync(源, 'r');
    try { if (fs.readSync(fd, buf, 0, 20, 0) < 20) return; } finally { fs.closeSync(fd); }
    if (!(buf[0] === 0x7f && buf.toString('ascii', 1, 4) === 'ELF' && buf[4] === 2)) return;
    const 机器 = buf.readUInt16LE(18);
    if (process.arch === 'x64' && 机器 !== 62) return;
    if (process.arch === 'arm64' && 机器 !== 183) return;
    fs.copyFileSync(源, 目标);
    fs.chmodSync(目标, 0o755);
    log('已从仓库内平台包复制引导器: ' + 源 + ' -> ' + 目标);
  } catch (e) { warn('复制仓库内引导器失败：' + e.message); }
}

function main() {
  log(`coCN v${VERSION} 安装开始（${process.platform}/${process.arch}）`);

  // 如果是 npm publish 或 dry-run，跳过安装
  if (process.env.npm_config_dry_run) {
    log('dry-run 模式，跳过安装步骤');
    return;
  }

  复制仓库内平台引导器();
  补执行位([
    path.join(BIN_DIR, 'cocn.js'),      // sh 薄壳：npm 建的符号链接指向它
    path.join(BIN_DIR, '入口.js'),        // 纯 JS 入口（co 命令指向它）
    path.join(BIN_DIR, '引导器'),
  ].concat(找平台子包引导器()));

  清理旧版缓存();
  构建原生加速器();
  log('运行方式: cocn 程序.co');
}

// 安装脚本不应因「可选加速器构建失败」而让整个 npm install 失败：
// 引导器（平台子包提供）已经能跑自解释器通道，装完即用。
// 所以这里只报错、不退出非零 —— 早期版本 exit(1) 导致 Termux 上
// 明明引导器可用却被判为安装失败（实测 npm error code 1）。
try {
  main();
} catch (e) {
  error(`安装脚本异常: ${e.message}`);
  error('不影响使用：引导器通道仍可运行 coCN 程序。');
}
