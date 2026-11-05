#!/usr/bin/env node
// ============================================================
// 深度比较.js —— 比较两个 JSON AST 文件是否语义一致
// 用法：node 深度比较.js js版.json coCN版.json
// ============================================================

function 深度相等(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!深度相等(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      if (!深度相等(a[ka[i]], b[kb[i]])) return false;
    }
    return true;
  }
  return false;
}

const fs = require("fs");
const jsPath = process.argv[2];
const coPath = process.argv[3];

if (!jsPath || !coPath) {
  console.error("用法：node 深度比较.js js版.json coCN版.json");
  process.exit(1);
}

const jsAst = JSON.parse(fs.readFileSync(jsPath, "utf8"));
const coAst = JSON.parse(fs.readFileSync(coPath, "utf8"));

if (深度相等(jsAst, coAst)) {
  console.log("  ✓ 通过");
  process.exit(0);
} else {
  console.log("  ✗ 失败：AST 结构不一致");
  console.log("  JS版:  " + JSON.stringify(jsAst).substring(0, 300));
  console.log("  coCN版: " + JSON.stringify(coAst).substring(0, 300));
  process.exit(1);
}
