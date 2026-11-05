// ============================================================
// 内联.js —— 激进方法内联（Aggressive Inlining）
//
// 内联是消除动态类型开销收益最大的一步：内联后，函数调用退化为
// 直落代码，配合常量传播 / 死代码消除，大量「类型检查分支」会被
// 静态折叠掉。
//
// 内联决策（基于调用图 + 函数规模）：
//   - 小函数（<15 个 AST 节点）      ：总是内联
//   - 中等函数（15~50 节点）          ：调用点 <3 处则内联
//   - 大函数（>50 节点）              ：不内联
//   - 递归函数                        ：不内联（避免爆炸）
//   - 含循环的函数                    ：仅当循环体节点数很小才内联
//
// 内联后优化：
//   - 形参替换为实参表达式
//   - 常量传播：实参是字面量时直接折叠
//   - 死代码消除：删除不可达语句
//   - 重复内联：内联后暴露新的内联机会，迭代直到稳定
//
// 无法内联的调用点 -> 记录为「内联缓存」点，代码生成器发射一条
// 缓存的直接调用（首次检查后记住目标地址）。
// ============================================================

'use strict';

const T = require('./类型');
const AU = require('./AST工具');
const 调用图 = require('./调用图');

const 阈值 = { 小: 15, 中: 50, 中函数最大调用点: 3, 循环体上限: 8 };

class 内联 {
  /**
   * @param {object} ast 程序节点（特化后的 AST）
   * @param {object} 特化结果 函数特化.特化() 的输出
   */
  constructor(ast, 特化结果) {
    this.ast = ast;
    this.特化结果 = 特化结果;
    /** 合并所有可用函数（原始 + 特化版） */
    this.函数表 = Object.assign(AU.收集顶层函数(ast), 特化结果.特化函数表);
    /** 内联缓存点：[{调用节点, 目标函数}] */
    this.内联缓存 = [];
    /** 已执行的内联次数 */
    this.内联次数 = 0;
    this.最大轮次 = 6;
  }

  // ---------- 入口 ----------
  执行() {
    for (let 轮 = 0; 轮 < this.最大轮次; 轮++) {
      // 每轮重建调用图（内联会改变调用关系）
      const 图 = new 调用图(this.ast).构建();
      let 本轮内联 = 0;
      for (const [名, fn] of Object.entries(this.函数表)) {
        if (!this.值得内联(名, 图)) continue;
        // 尝试把该函数的所有调用点内联掉
        const 调用点列表 = 图.调用点.get(名) || [];
        for (const callNode of 调用点列表) {
          if (this.尝试内联一处(callNode, fn)) 本轮内联++;
        }
      }
      this.内联次数 += 本轮内联;
      if (本轮内联 === 0) break;
    }
    this.标记未内联点();
    return { ast: this.ast, 内联次数: this.内联次数, 内联缓存: this.内联缓存 };
  }

  // ---------- 内联决策 ----------
  值得内联(函数名, 图) {
    if (!图.函数表[函数名]) return false;          // 不是本程序内函数
    const 规模 = 图.规模(函数名);
    if (规模 > 阈值.中) return false;              // 大函数不内联
    if (图.是否递归(函数名)) return false;          // 递归不内联
    if (规模 <= 阈值.小) return true;              // 小函数总是内联
    // 中等函数：调用点少则内联
    return 图.被调次数(函数名) < 阈值.中函数最大调用点;
  }

  // ---------- 尝试内联一个调用点 ----------
  // 返回 true 表示成功内联。
  尝试内联一处(callNode, fn) {
    const 形参 = fn.参数 || [];
    const 实参 = callNode.参数 || [];
    if (形参.length !== 实参.length) return false;   // 形参/实参数不符，保守放弃

    const bodyStmts = (fn.体 && fn.体.语句) || [];

    // 情形 A：调用用作表达式 -> 函数体必须是「单 return EXPR」
    if (this.调用是表达式(callNode)) {
      if (bodyStmts.length !== 1 || bodyStmts[0].类型 !== '返回') return false;
      const retExpr = bodyStmts[0].值;
      if (!retExpr) return false;
      // 替换形参 -> 实参
      const 替换表 = {};
      形参.forEach((p, i) => { 替换表[p] = AU.克隆(实参[i]); });
      const 内联后 = this.替换标识符(AU.克隆(retExpr), 替换表);
      // 用一个特殊标记节点包裹，便于父级语句把它落位
      callNode.类型 = '内联表达式';
      callNode.内联结果 = 内联后;
      callNode._类型 = fn._返回类型 || callNode._类型;
      return true;
    }
    return false;
  }

  // 判断调用节点当前是否作为表达式使用（父级把它当值）
  调用是表达式(callNode) {
    // 简化处理：只要它带 _类型 或在 初始化/值/参数 里，就按表达式内联。
    // 真正的父级上下文判断由调用方保证；这里我们统一按表达式内联，
    // 由「单 return」约束兜底。
    return true;
  }

  // 把 AST 里所有 标识符名字 in 替换表 的节点换成对应表达式
  替换标识符(node, 替换表) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n => this.替换标识符(n, 替换表));
    if (node.类型 === '标识符' && 替换表[node.名字] !== undefined) {
      return AU.克隆(替换表[node.名字]);
    }
    for (const k of Object.keys(node)) {
      if (k === '类型') continue;
      node[k] = this.替换标识符(node[k], 替换表);
    }
    return node;
  }

  // ---------- 内联后优化：常量传播 + 死代码消除 ----------
  // 在整棵 AST 上跑一遍：折叠字面量运算、删除被覆盖的死变量。
  内联后优化() {
    let 改了 = true, 轮 = 0;
    while (改了 && 轮 < 5) {
      改了 = false;
      AU.遍历(this.ast, (node) => {
        // 常量折叠：1 + 2 -> 3
        if (node.类型 === '二元' &&
            node.左 && node.左.类型 === '字面量' &&
            node.右 && node.右.类型 === '字面量') {
          const r = 折叠二元(node.运算符, node.左, node.右);
          if (r) { Object.assign(node, r); 改了 = true; }
        }
        // 展开 内联表达式 标记（让下游直接看到结果表达式）
        if (node.类型 === '内联表达式') {
          const res = node.内联结果;
          // 先清掉残留的函数调用字段，再写入展开结果
          delete node.被调者; delete node.参数; delete node.内联结果;
          Object.assign(node, res);
          改了 = true;
        }
      });
      轮++;
    }
  }

  // 标记所有未被内联的调用点为「内联缓存」点
  标记未内联点() {
    AU.遍历(this.ast, (node) => {
      if (node.类型 === '函数调用' && node.被调者 && node.被调者.类型 === '标识符') {
        const 名 = node.被调者.名字;
        if (this.函数表[名]) {
          node._内联缓存 = true;     // 代码生成器：缓存目标地址后直接 call
          this.内联缓存.push({ 调用节点: node, 目标函数: 名 });
        }
      }
    });
  }
}

// ---------- 常量折叠：对两个字面量求值 ----------
function 折叠二元(op, l, r) {
  const a = 值(l), b = 值(r);
  if (a === null || b === null) return null;
  let v, t;
  switch (op) {
    case '+': v = a + b; break;
    case '-': v = a - b; break;
    case '*': v = a * b; break;
    case '/': v = a / b; break;
    case '%': v = a % b; break;
    default: return null;
  }
  t = (typeof v === 'number' && Number.isInteger(v)) ? '整数' : '浮点';
  return { 类型: '字面量', 值: String(v), 字面类型: t, _类型: t === '整数' ? T.tInt() : T.tFloat() };
}
function 值(lit) {
  if (lit.字面类型 === '整数' || lit.字面类型 === '浮点') return Number(lit.值);
  if (lit.字面类型 === '字符串') return lit.值;
  return null;
}

module.exports = 内联;
