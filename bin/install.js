#!/usr/bin/env node
/**
 * coCN npm 包 postinstall 脚本（自解释器版）
 *
 * 自解释器（词法分析器.co / 语法分析器.co / 求值器.co / 解释器.co /
 * 标准库.co）已随 npm 包发布，但它本身需要一个【引导 cocn 二进制】来启动。
 * 本脚本按平台/架构下载预编译引导二进制到 bin/cocn（Windows: bin/cocn.exe）。
 *
 * 注意：npm 包不再包含 co.c，因此不再提供源码编译回退；
 * 下载失败时给出明确错误，提示用户手动安装。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const VERSION = '0.1.20';
// 引导二进制版本：使用 v0.1.0（最后一个 C 构建版本，含完整内置函数）。
// 引导二进制仅用于启动 coCN 自解释器，其版本无需与包版本一致。
const BOOTSTRAP_VERSION = '0.1.0';
const BIN_DIR = path.join(__dirname, 'bin');
const BIN_NAME = process.platform === 'win32' ? '引导器.exe' : '引导器';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// 预编译引导二进制下载源（Gitee 优先，GitHub 备选）
const DOWNLOAD_BASES = [
  `https://gitee.com/COSMOnb666/coCN/releases/download/v${BOOTSTRAP_VERSION}`,
  `https://github.com/3477856804/coCN/releases/download/v${BOOTSTRAP_VERSION}`
];

function log(msg) {
  console.log(`\x1b[34m[coCN]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.warn(`\x1b[33m[coCN!]\x1b[0m ${msg}`);
}
function error(msg) {
  console.error(`\x1b[31m[coCN!!]\x1b[0m ${msg}`);
}

function getPlatform() {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return null;
  }
}

function getArch() {
  switch (process.arch) {
    case 'x64': return 'x86_64';
    case 'arm64': return 'aarch64';
    default: return null;
  }
}

function download(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { timeout: 30000, headers: { 'User-Agent': 'coCN-npm-installer' } }, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`重定向缺少 Location 头（HTTP ${response.statusCode}）`));
          return;
        }
        const nextUrl = location.startsWith('http') ? location : new URL(location, url).href;
        response.resume(); // 消耗响应体
        download(nextUrl, dest, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(dest));
      });
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
    request.on('error', (err) => {
      reject(err);
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('下载超时'));
    });
  });
}

async function tryDownloadBinary() {
  const platform = getPlatform();
  const arch = getArch();
  if (!platform || !arch) {
    error(`不支持的平台/架构: ${process.platform}/${process.arch}`);
    error('请前往 https://gitee.com/COSMOnb666/coCN/releases 手动下载对应二进制，放到 bin/cocn 后重试。');
    return false;
  }

  const asset = `coCN-${platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;

  for (const base of DOWNLOAD_BASES) {
    const url = `${base}/${asset}`;
    log(`尝试下载引导二进制: ${url}`);
    try {
      if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
      await download(url, BIN_PATH);
      if (process.platform !== 'win32') {
        fs.chmodSync(BIN_PATH, 0o755);
      }
      // 验证二进制可运行
      try {
        const out = execSync(`"${BIN_PATH}" --版本`, { encoding: 'utf8', timeout: 10000 });
        if (out.includes('coCN')) {
          log(`引导二进制下载成功: ${asset}`);
          return true;
        }
      } catch (e) {
        warn(`二进制验证失败: ${e.message}`);
      }
      fs.unlinkSync(BIN_PATH);
    } catch (e) {
      warn(`下载失败: ${e.message}`);
    }
  }
  return false;
}

/** 清理旧版本留下的编译缓存。
 *
 * 为什么需要：缓存指纹现在掺了包版本（-DCOCN_ABI="cocn-direct-<版本>"），
 * 升级后每个程序都会重编一遍，这是对的；但旧产物只是「不可达」，
 * 仍躺在 ~/.cocn/cache/ 里——里面可能有 0.1.14 那批「算错」的 ELF，
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

async function main() {
  log(`coCN v${VERSION} 安装开始（${process.platform}/${process.arch}）`);

  // 如果是 npm publish 或 dry-run，跳过安装
  if (process.env.npm_config_dry_run) {
    log('dry-run 模式，跳过引导二进制安装');
    return;
  }

  清理旧版缓存();

  // 优先使用包内自带的启动器（Linux x64 已随包打包，开箱即用）。
  // 注意：原生启动器不认识 --版本 参数（会按文件名报错并退出），
  // 旧版在此做 --版本 验证导致包内启动器被误删后替换为老引导器，
  // cocn 命令因此全部退回自解释器模式（秒级）。此处改为直接信任包内文件。
  if (fs.existsSync(BIN_PATH)) {
    log(`包内启动器就绪: ${BIN_PATH}`);
    log('运行方式: cocn 程序.co（原生编译缓存通道，毫秒级启动）');
    return;
  }

  // 包内无可用二进制（其他平台），尝试下载
  const success = await tryDownloadBinary();

  if (success) {
    log(`引导二进制就绪: ${BIN_PATH}`);
  } else {
    error('引导二进制不可用。npm 包内置的 coCN 自解释器需要一个引导 cocn 二进制才能启动。');
    error('请手动处理：');
    error('  1. 前往 https://gitee.com/COSMOnb666/coCN/releases 下载对应平台的引导二进制');
    error(`  2. 重命名为 ${BIN_NAME} 并放到 npm 包的 bin/ 目录`);
    error('  3. 或直接重新安装: npm install -g @yeyelailou/co');
    process.exit(1);
  }

  // 构建原生组件：运行时目标文件 + 原生启动器（有 gcc 才有 AOT 加速）
  buildNative();
  log('运行方式: cocn 程序.co');
}

/** 编译 运行时.c / 入口.c / 启动器.c，使 cocn 具备原生编译能力 */
function buildNative() {
  if (process.platform === 'win32') {
    warn('Windows 暂不构建原生启动器，回退自解释器模式');
    return;
  }
  const NATIVE_DIR = path.join(__dirname, '工具', '原生编译器');
  const objs = [
    [path.join(NATIVE_DIR, '运行时.c'), path.join(BIN_DIR, 'rt.o')],
    [path.join(NATIVE_DIR, '入口.c'), path.join(BIN_DIR, 'entry.o')]
  ];
  try {
    execSync('command -v gcc', { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    warn('未检测到 gcc，跳过原生组件构建（coCN 仍可用，走自解释器）');
    return;
  }
  try {
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    for (const [src, out] of objs) {
      if (!fs.existsSync(src)) continue;
      execSync(`gcc -O2 -fno-pie -c "${src}" -o "${out}"`, { encoding: 'utf8', timeout: 120000 });
    }
    // 原生启动器：让「运行 coCN 程序」本身也是原生速度
    // 优先静态链接：动态链接的启动器每次 exec 要走 ld.so，实测热路径
    // 多 ~900-1000us；静态版把缓存命中的总时长压回 4ms 以内。
    const launcherSrc = path.join(NATIVE_DIR, '启动器.c');
    const launcherOut = path.join(BIN_DIR, 'cocn');
    if (fs.existsSync(launcherSrc)) {
      // -DCOCN_ABI 把包版本烧进缓存指纹：发版即自动作废上一版产物，
      // 不必靠人记得手改 启动器.c 里的代次串（漏改 = 修复对用户无效）。
      const abi = `-DCOCN_ABI=\"cocn-direct-${VERSION}\"`;
      try {
        execSync(`gcc -O2 -static ${abi} -o "${launcherOut}" "${launcherSrc}"`, { encoding: 'utf8', timeout: 120000 });
      } catch (e) {
        execSync(`gcc -O2 ${abi} -o "${launcherOut}" "${launcherSrc}"`, { encoding: 'utf8', timeout: 120000 });
      }
      fs.chmodSync(launcherOut, 0o755);
    }
    log('原生组件已构建（AOT 加速可用）');
  } catch (e) {
    warn(`原生组件构建失败，回退自解释器模式: ${e.message}`);
  }
}

main().catch(e => {
  error(`安装脚本异常: ${e.message}`);
  process.exit(1);
});
