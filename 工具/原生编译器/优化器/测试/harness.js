// ============================================================
// test/run.js —— 简易测试框架（node:test 风格但零依赖）
// ============================================================
'use strict';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); }

function summary() {
  console.log(`\n  通过 ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`  ${failed} 个失败：`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
}

module.exports = { test, assert, eq, summary };
