#!/usr/bin/env node
// ============================================================
// 入口.js —— coCN 原生编译器命令行
// 用法：node 入口.js 输入.co 输出.s
// ============================================================

const fs = require("fs");
const path = require("path");
const { 解析源 } = require("./语法分析器.js");
const { 生成汇编 } = require("./代码生成器.js");

function main() {
  const inFile = process.argv[2];
  const outFile = process.argv[3];
  if (!inFile || !outFile) {
    console.error("用法：node 入口.js 输入.co 输出.s");
    process.exit(1);
  }
  const src = fs.readFileSync(inFile, "utf8");
  let ast;
  try {
    ast = 解析源(src);
  } catch (e) {
    console.error("前端错误:", e.message);
    process.exit(2);
  }
  let asm;
  try {
    asm = 生成汇编(ast);
  } catch (e) {
    console.error("代码生成错误:", e.message);
    console.error(e.stack);
    process.exit(3);
  }
  fs.writeFileSync(outFile, asm);
}

main();
