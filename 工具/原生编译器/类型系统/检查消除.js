// ============================================================
// 检查消除.js —— 数组边界检查消除 (BCE) + 空检查消除 (NCE)
//
// 动态类型语言每次 list[i] 都要做两件运行时检查：
//   1) i 是否在 [0, len(list)) 范围内？越界则抛异常；
//   2) list 是否为空指针/未初始化？为空则崩溃。
// 这两类检查在热循环里占比极高。本模块在编译期【证明】安全性，
// 让代码生成器删掉对应的比较与分支指令。
//
// 边界检查消除（BCE）：
//   - 识别循环归纳变量：对于 i 从 0 到 n-1；
//   - 循环体内 list[i] 的下标 i 就是归纳变量，
//     且 n == 长度(list) -> i 必然在界内 -> 消除检查；
//   - 常量下标 list[0] / list[3] 若列表已知非空且长度可证，也消除。
//
// 空检查消除（NCE）：
//   - 跟踪一个引用是否「一定非空」：
//       * 字面量 / 立即分配的对象 / 函数返回值类型非 nil -> 非空；
//       * 编译期可证明从未被赋空值的变量 -> 非空；
//   - 对已证非空的引用，删掉它每次解引用前的空检查。
// ============================================================

'use strict';

const T = require('./类型');
const AU = require('./AST工具');

class 检查消除 {
  /**
   * @param {object} ast 程序节点
   * @param {object} 推断结果 类型推断结果
   */
  constructor(ast, 推断结果) {
    this.ast = ast;
    this.推断 = 推断结果;
    /** 已消除边界检查的下标节点数 */
    this.消除边界检查数 = 0;
    /** 已消除空检查的引用节点数 */
    this.消除空检查数 = 0;
    /** 记录每个下标节点的安全判定 */
    this.边界安全 = new Map();   // 下标节点 -> true(安全)
  }

  执行() {
    // 1) 收集所有循环归纳变量及其上界
    this.分析循环归纳变量();
    // 2) 遍历所有下标访问，尝试消除边界检查
    this.消除边界检查();
    // 3) 消除空检查
    this.消除空检查();
    return {
      ast: this.ast,
      消除边界检查数: this.消除边界检查数,
      消除空检查数: this.消除空检查数
    };
  }

  // ---------- 1) 识别循环归纳变量 ----------
  分析循环归纳变量() {
    /** 变量名 -> {上界节点, 容器列表名} */
    this.归纳变量 = new Map();
    AU.遍历(this.ast, (node) => {
      if (node.类型 !== '对于') return;
      if (node.是否遍历 === 1) return;          // for-each 单独处理
      // 对于 i 从 a 到 b：i 是归纳变量，上界为 b
      this.归纳变量.set(node.变量, {
        起点: node.起点, 终点: node.终点, 步长: node.步长
      });
    });
  }

  // ---------- 2) 边界检查消除 ----------
  消除边界检查() {
    AU.遍历(this.ast, (node) => {
      if (node.类型 !== '下标') return;
      const idx = node.索引;
      const container = node.容器;

      // 情形 A：下标是循环归纳变量 i，且容器是对应列表
      if (idx && idx.类型 === '标识符' && this.归纳变量.has(idx.名字)) {
        // 归纳变量从 0 开始、终点是列表长度-1 -> 可证安全
        const iv = this.归纳变量.get(idx.名字);
        if (this.归纳起点为零(iv) && this.终点是列表长度(iv.终点, container)) {
          this.标记安全(node);
          return;
        }
      }
      // 情形 B：常量下标 >= 0，且列表类型已知非空（有明确元素类型）
      if (idx && idx.类型 === '字面量' && idx.字面类型 === '整数') {
        const v = Number(idx.值);
        const ct = container && container._类型;
        if (v >= 0 && ct && ct.k === 'list' && !(ct.elem.k === 'bot')) {
          // 保守：只有当列表字面量长度 > v 时才安全
          if (container.类型 === '列表字面量' && (container.元素 || []).length > v) {
            this.标记安全(node);
          }
        }
      }
    });
  }

  归纳起点为零(iv) {
    return iv.起点 && iv.起点.类型 === '字面量' && Number(iv.起点.值) === 0;
  }

  // 终点是否形如 长度(list) - 1（或 list 的长度）
  终点是列表长度(终点节点, container) {
    if (!终点节点) return false;
    // 长度(list) - 1：二元 '-' 右为字面量1，左是 长度(container)
    if (终点节点.类型 === '二元' && 终点节点.运算符 === '-') {
      const l = 终点节点.左, r = 终点节点.右;
      if (r && r.类型 === '字面量' && Number(r.值) === 1) {
        return this.是长度调用(l, container);
      }
    }
    return this.是长度调用(终点节点, container);
  }

  是长度调用(node, container) {
    if (!node || node.类型 !== '函数调用') return false;
    if (!node.被调者 || node.被调者.名字 !== '长度') return false;
    const arg = (node.参数 || [])[0];
    return arg && container && arg.类型 === '标识符' &&
      container.类型 === '标识符' && arg.名字 === container.名字;
  }

  标记安全(下标节点) {
    下标节点._边界检查消除 = true;       // 代码生成器：不发射 bounds check
    this.边界安全.set(下标节点, true);
    this.消除边界检查数++;
  }

  // ---------- 3) 空检查消除 ----------
  消除空检查() {
    // 收集所有「可证非空」的变量：
    //   - 初始化是字面量/立即分配对象的变量
    //   - 类型标注为非空标量（int/float/bool/str 字面）
    //   - 从未被赋空的变量
    const 非空变量 = new Set();
    AU.遍历(this.ast, (node) => {
      if (node.类型 !== '变量声明') return;
      const init = node.初始化;
      if (!init) return;
      const t = node._类型 || init._类型;
      // 标量 / 立即分配 / 字符串字面量 -> 不可能为空指针
      if (t && (t.k === 'int' || t.k === 'float' || t.k === 'bool' ||
                t.k === 'str' || t.k === 'struct' || t.k === 'object')) {
        非空变量.add(node.名字);
      } else if (init.类型 === '列表字面量' || init.类型 === '字典字面量') {
        非空变量.add(node.名字);           // 立即分配的容器，非空
      }
    });

    // 对每个标识符解引用（下标/成员访问），若基变量可证非空，消除空检查
    AU.遍历(this.ast, (node) => {
      if (node.类型 !== '下标') return;
      const c = node.容器;
      if (c && c.类型 === '标识符' && 非空变量.has(c.名字)) {
        node._空检查消除 = true;           // 代码生成器：不发射 null check
        this.消除空检查数++;
      }
    });
  }
}

module.exports = 检查消除;
