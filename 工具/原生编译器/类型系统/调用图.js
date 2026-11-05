// ============================================================
// 调用图.js —— 函数调用关系图构建
//
// 记录：
//   调用者 -> [被调者...]          （边）
//   被调者 -> [调用者...]          （反向边，用于内联决策：被调用次数）
//   递归检测：某函数是否直接/间接调用自己
//
// 内联决策需要这张图回答：
//   - 这个函数被几个调用点使用？（少则值得内联）
//   - 这个函数递归吗？（递归则不内联）
//   - 内联一个函数后，是否暴露新的内联机会？（需要迭代）
// ============================================================

'use strict';

const AU = require('./AST工具');

class 调用图 {
  constructor(程序节点) {
    this.程序 = 程序节点;
    this.函数表 = AU.收集顶层函数(程序节点);
    /** 邻接表：调用者 -> Set(被调者名) */
    this.边 = new Map();
    /** 反向边：被调者 -> Set(调用者名) */
    this.反边 = new Map();
    /** 每个函数的调用点列表：被调者 -> [调用节点] */
    this.调用点 = new Map();
  }

  构建() {
    for (const [名, fn] of Object.entries(this.函数表)) {
      this.边.set(名, new Set());
      // 遍历函数体里的所有调用
      AU.遍历(fn.体, (node) => {
        if (node.类型 === '函数调用' && node.被调者 && node.被调者.类型 === '标识符') {
          const 被调 = node.被调者.名字;
          this.边.get(名).add(被调);
          if (!this.反边.has(被调)) this.反边.set(被调, new Set());
          this.反边.get(被调).add(名);
          if (!this.调用点.has(被调)) this.调用点.set(被调, []);
          this.调用点.get(被调).push(node);
        }
      });
    }
    // 顶层程序体当作合成函数 "<main>"，扫描其中的调用。
    // 注意：只扫顶层语句及其表达式，不下降进嵌套函数体（那些已在上面登记）。
    this.边.set('<main>', new Set());
    if (this.程序 && Array.isArray(this.程序.语句)) {
      for (const st of this.程序.语句) {
        if (!st || typeof st !== 'object') continue;
        if (st.类型 === '函数定义' || st.类型 === '类定义') continue;  // 跳过函数体
        this.收集调用(st, '<main>');
      }
    }
    return this;
  }

  // 在一个节点内收集所有函数调用（不下降进函数定义体）
  收集调用(node, 调用者) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) this.收集调用(x, 调用者);
      return;
    }
    if (typeof node.类型 !== 'string') return;
    if (node.类型 === '函数定义' || node.类型 === '函数字面量' || node.类型 === '类定义') return;
    if (node.类型 === '函数调用' && node.被调者 && node.被调者.类型 === '标识符') {
      const 被调 = node.被调者.名字;
      this.边.get(调用者).add(被调);
      if (!this.调用点.has(被调)) this.调用点.set(被调, []);
      this.调用点.get(被调).push(node);
    }
    for (const k of Object.keys(node)) {
      if (k === '类型' || k === '名字') continue;
      this.收集调用(node[k], 调用者);
    }
  }

  /** 某函数被多少个调用点调用 */
  被调次数(函数名) {
    return this.调用点.has(函数名) ? this.调用点.get(函数名).length : 0;
  }

  /** 某函数是否递归（直接调用自己，或通过调用图闭包回到自己） */
  是否递归(函数名) {
    const 访问 = new Set();
    const 栈 = [函数名];
    while (栈.length) {
      const cur = 栈.pop();
      const 被调集 = this.边.get(cur);
      if (!被调集) continue;
      for (const 被调 of 被调集) {
        if (被调 === 函数名) return true;          // 直接递归
        if (!访问.has(被调)) { 访问.add(被调); 栈.push(被调); }
      }
    }
    return false;
  }

  /** 某函数是否含循环（用于内联决策：循环体小则内联收益大） */
  含循环(函数名) {
    const fn = this.函数表[函数名];
    if (!fn) return false;
    let 有 = false;
    AU.遍历(fn.体, (node) => {
      if (node.类型 === '当' || node.类型 === '对于') 有 = true;
    });
    return 有;
  }

  /** 函数体规模（节点数） */
  规模(函数名) {
    const fn = this.函数表[函数名];
    return fn ? AU.函数规模(fn) : 0;
  }
}

module.exports = 调用图;
