#!/usr/bin/env node
'use strict';
/**
 * cocn 短名包构建脚本：生成无作用域的 `colang` 包（薄壳）
 *
 * 为什么要有短名包：
 *   官方包是 `cocn`（无作用域，安装命令已经是短名），但 `cocn` 与
 *   已存在的 `co` 过于相似、npm 会拒绝发布；于是再发一份 `colang`
 *   （co + lang）作为备用短名，二者共用同一份源码。
 *
 * 为什么是【薄壳】而不是复制一份完整源码：
 *   薄壳只依赖官方包并转发调用，源码只有一份事实来源；
 *   发布体积从 ~4MB 降到几 KB，不会出现两个版本各发各的。
 *
 * 薄壳本身是 sh 脚本（不是 node 脚本）：
 *   Android/Termux 没有 /usr/bin/env，shebang 写 #!/usr/bin/env node 的
 *   全局命令会直接不可执行（实测报 "bad interpreter"）。
 *
 * 用法：
 *   node 工具/发布/构建短名包.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, '工具', '发布', '短名包');
const 主 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });

const 清单 = {
  // 短名固定为 colang：无作用域、语义清楚（co + lang）。
  name: process.env.CO_SHORT_NAME || 'colang',
  version: 主.version,
  description: 'cocn —— 让代码开口说中文的中文编程语言（自举，原 coCN）。短名安装：npm install -g ' + (process.env.CO_SHORT_NAME || 'colang') + '；官方包：cocn。',
  os: 主.os,
  cpu: 主.cpu,
  bin: { cocn: 'bin/cocn.js', co: 'bin/cocn.js' },
  license: 主.license,
  author: 主.author,
  keywords: 主.keywords,
  homepage: 主.homepage,
  repository: 主.repository,
  bugs: 主.bugs,
  engines: 主.engines,
  dependencies: { '@yeyelailou/cocn': 主.version },
  files: ['bin/'],
  // 不设 postinstall：引导器与原生加速器由依赖包 cocn 的
  // postinstall 负责（它自己会下载平台子包并补执行位）；
  // 短名包只做转发，重复一遍只会因为缺 install.js 而报错。
};
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(清单, null, 2) + '\n');

const 薄壳 = `#!/bin/sh
# ============================================================
# cocn 短名入口（npm install -g colang）
#
# 本文件只是转发：真正的实现与源码在 @yeyelailou/cocn 里。
# 这样短名包与官方包共用同一份源码，不会出现两个版本各发各的。
#
# 为什么是 sh 而不是 node 脚本：Android/Termux 没有 /usr/bin/env，
# shebang 写 #!/usr/bin/env node 的全局命令会直接不可执行。
# ============================================================

_self="$0"
if command -v readlink >/dev/null 2>&1; then
    _resolved=$(readlink -f "$0" 2>/dev/null)
    [ -n "$_resolved" ] && _self="$_resolved"
fi
SELF_DIR=$(dirname "$_self")

# 找 @yeyelailou/cocn 的安装位置（npm 扁平化 / 嵌套 / 全局三种布局都覆盖）
PKG=""
for d in "$SELF_DIR/.." "$SELF_DIR/../.." "$SELF_DIR/../../.." "$SELF_DIR"; do
    for p in "$d/node_modules/@yeyelailou/cocn" "$d/@yeyelailou/cocn"; do
        if [ -f "$p/bin/入口.js" ]; then
            PKG="$p"
            break
        fi
    done
    [ -n "$PKG" ] && break
done

if [ -z "$PKG" ]; then
    echo "[cocn] 未找到 @yeyelailou/cocn —— 请重装：npm install -g @yeyelailou/cocn" >&2
    exit 1
fi

NODE=$(command -v node 2>/dev/null)
[ -z "$NODE" ] && NODE=$(command -v nodejs 2>/dev/null)
if [ -z "$NODE" ]; then
    echo "[cocn] 未找到 node —— cocn 需要 Node.js 运行（建议 Node 18+）。" >&2
    exit 127
fi

exec "$NODE" "$PKG/bin/入口.js" "$@"
`;
fs.writeFileSync(path.join(OUT, 'bin', 'cocn.js'), 薄壳);
try { fs.chmodSync(path.join(OUT, 'bin', 'cocn.js'), 0o755); } catch (e) { /* 打包机可能只读 */ }

console.log('已生成短名包：' + OUT);
console.log('  包名: ' + 清单.name + '@' + 主.version);
console.log('  依赖: @yeyelailou/cocn@' + 主.version);
console.log('  安装: npm install -g ' + 清单.name);
console.log('  发布: cd "' + OUT + '" && npm publish --access public');
