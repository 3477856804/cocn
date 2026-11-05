/**
 * coCN —— 中文编程语言（自解释器版）
 * npm 包主入口。
 *
 * coCN 自解释器随包发布（解释器.co 等 .co 文件），运行需要一个引导
 * cocn 二进制（postinstall 下载到 bin/）。本模块对外暴露：
 *   - run(目标程序)：以子进程方式用引导二进制启动自解释器运行目标程序。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PKG_DIR = __dirname;
const SRC_DIR = path.join(PKG_DIR, 'src');
const BIN_DIR = path.join(PKG_DIR, 'bin');
const BOOTSTRAP_NAME = process.platform === 'win32' ? 'cocn.exe' : 'cocn';
const BOOTSTRAP_PATH = path.join(BIN_DIR, BOOTSTRAP_NAME);
const INTERPRETER_PATH = path.join(SRC_DIR, '解释器.co');
const REPL_PATH = path.join(SRC_DIR, 'repl.co');

function findBootstrap() {
  if (fs.existsSync(BOOTSTRAP_PATH)) return BOOTSTRAP_PATH;
  const alt = path.join(BIN_DIR, process.platform === 'win32' ? 'co.exe' : 'co');
  if (fs.existsSync(alt)) return alt;
  return null;
}

module.exports = {
  version: '0.0.1',
  /** 引导 cocn 二进制路径（未安装时为 null） */
  binPath: findBootstrap(),
  /** 自解释器主入口路径 */
  interpreterPath: INTERPRETER_PATH,

  /**
   * 运行一个 coCN 程序文件。
   * @param {string} targetProgram 目标 .co 文件路径（相对路径基于 options.cwd 或当前进程 cwd）
   * @param {{cwd?: string, stdio?: any}} [options]
   * @returns {ChildProcess} 子进程对象
   */
  run(targetProgram, options = {}) {
    const bootstrap = findBootstrap();
    if (!bootstrap) {
      throw new Error('引导 cocn 二进制未安装，请重新运行 npm install -g @yeyelailou/cocn');
    }
    if (!fs.existsSync(INTERPRETER_PATH)) {
      throw new Error('coCN 自解释器（解释器.co）缺失，请重新安装');
    }
    if (!targetProgram) {
      throw new Error('用法: run(目标程序.co)');
    }
    const baseDir = options.cwd || process.cwd();
    const absTarget = path.resolve(baseDir, targetProgram);
    const env = Object.assign({}, process.env, { COCN_TARGET: absTarget });
    return spawn(bootstrap, [INTERPRETER_PATH], {
      stdio: options.stdio || 'inherit',
      env,
      cwd: SRC_DIR
    });
  },

  /**
   * 启动交互式 REPL（逐行读取并求值，跨行保留变量）。
   * @param {{cwd?: string, stdio?: any}} [options]
   * @returns {ChildProcess} 子进程对象
   */
  repl(options = {}) {
    const bootstrap = findBootstrap();
    if (!bootstrap) {
      throw new Error('引导 cocn 二进制未安装，请重新运行 npm install -g @yeyelailou/cocn');
    }
    if (!fs.existsSync(REPL_PATH)) {
      throw new Error('coCN REPL（repl.co）缺失，请重新安装');
    }
    // 不设置 COCN_TARGET：repl.co 自带读取循环与持久环境
    return spawn(bootstrap, [REPL_PATH], {
      stdio: options.stdio || 'inherit',
      env: process.env,
      cwd: SRC_DIR
    });
  }
};
