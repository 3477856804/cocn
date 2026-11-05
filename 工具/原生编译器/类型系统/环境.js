// ============================================================
// 环境.js —— 类型环境：变量名 -> 静态类型 的映射（作用域链）
//
// 类型推断过程中，每个作用域持有一张符号表。环境支持：
//   - 词法作用域链：函数体 / 块 / 循环各自一层
//   - 定义 define：首次声明变量
//   - 查找 lookup：沿作用域链向上
//   - 赋值 set：变量重新赋值；若与既有类型不一致则【提升为动态】
//   - 快照 snapshot / 合并 merge：用于控制流汇合点（如果分支、循环头）
//
// 关键语义——「类型漂移即动态」：
//   若 x 先被推断为整数，后来又被赋值为字符串，则 x 在该作用域内
//   必须升级为动态（顶部）。这正是动态类型语言的核心开销来源，
//   类型系统要尽量在编译期消除它；消除不掉的位置才退回动态。
// ============================================================

'use strict';

const T = require('./类型');

class 环境 {
  /**
   * @param {环境} [父] 外层作用域
   */
  constructor(父) {
    this.父 = 父 || null;
    /** @type {Map<string, object>} 当前层符号表：名字 -> 类型 */
    this.表 = new Map();
    /** 记录被赋值覆盖过（发生过类型变化）的变量名 -> true */
    this.漂移 = new Set();
  }

  /** 进入一个新的嵌套作用域 */
  进作用域() { return new 环境(this); }

  /**
   * 定义一个新变量（变量声明 / 函数参数 / 循环变量）。
   * 若已存在同名变量（内层遮蔽外层），直接覆盖内层表。
   */
  定义(名字, 类型) {
    this.表.set(名字, 类型 || T.bot());
  }

  /**
   * 给变量赋值（x = 值）。沿作用域链找到它的定义点并更新类型。
   * 若新类型与旧类型不一致（LUB 不是旧类型自身），标记为漂移。
   * @returns {object} 更新后的类型
   */
  赋值(名字, 新类型) {
    let e = this;
    while (e) {
      if (e.表.has(名字)) {
        const 旧 = e.表.get(名字);
        const 合并 = T.lub(旧, 新类型);
        e.表.set(名字, 合并);
        // 类型发生了扩展/漂移 -> 记录（保守地认为可能影响下游）
        if (!T.equal(旧, 合并)) e.漂移.add(名字);
        return 合并;
      }
      e = e.父;
    }
    // 未找到定义点：视为隐式全局变量，定义在当前层
    this.表.set(名字, 新类型 || T.bot());
    return this.表.get(名字);
  }

  /** 查找变量类型（不修改）。找不到返回底部。 */
  查找(名字) {
    let e = this;
    while (e) {
      if (e.表.has(名字)) return e.表.get(名字);
      e = e.父;
    }
    return T.bot();
  }

  /** 是否在本层或外层已定义 */
  已定义(名字) {
    let e = this;
    while (e) {
      if (e.表.has(名字)) return true;
      e = e.父;
    }
    return false;
  }

  /** 取本层所有符号（用于调试 / 导出类型标注） */
  本层符号() {
    const out = {};
    for (const [k, v] of this.表) out[k] = v;
    return out;
  }

  /**
   * 打平成一张「全局限定视图」Map（本层覆盖外层）。
   * 用于在控制流汇合处做合并：把两个分支结束时的环境各自打平，
   * 再逐变量取 LUB。
   */
  打平() {
    const out = new Map();
    // 从最外层向内层铺，内层覆盖外层
    const 链 = [];
    let e = this;
    while (e) { 链.unshift(e); e = e.父; }
    for (const 层 of 链) for (const [k, v] of 层.表) out.set(k, v);
    return out;
  }

  /**
   * 把另一个环境的类型按 LUB 合并进当前环境（控制流汇合用）。
   * @param {Map<string,object>} 另一视图 另一分支的 打平() 结果
   */
  合并进(另一视图) {
    const 当前 = this.打平();
    for (const [k, t2] of 另一视图) {
      const t1 = 当前.get(k) || T.bot();
      const 合并 = T.lub(t1, t2);
      if (!T.equal(t1, t2) && !T.equal(t2, t1)) {
        // 两个分支类型不同 -> 汇合处类型提升（可能漂移）
        this.赋值(k, t2);
      }
    }
  }
}

module.exports = 环境;
