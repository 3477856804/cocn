// ============================================================
// 逃逸分析.js —— Escape Analysis + 标量替换（Scalar Replacement）
//
// 目标：消除堆分配与指针间接，把「不逃逸」的对象拆成寄存器/栈上标量。
//
// 一个分配点（结构体实例 / 对象 / 列表字面量 / 字典字面量）的对象
// 在以下情况【逃逸出函数】：
//   1) 被 return 返回（调用方可能长期持有）；
//   2) 被存入全局变量；
//   3) 被作为实参传给别的函数（保守认为对方会留存）；
//   4) 被存入另一个已逃逸对象的字段/容器。
// 反之，若对象只在本函数内被读写字段、从未外流，则【不逃逸】。
//
// 对不逃逸对象：
//   - 标量替换：结构体 p = {x:1,y:2} 拆成两个独立标量 p$x, p$y；
//     p.x 的读写退化为对 p$x 的直接访问，零堆分配、零间接指针。
//   - 栈分配：不逃逸但较大的对象直接落在栈帧上（代码生成器据此分配）。
//   - 同步消除：coCN 单线程，不逃逸对象无需任何锁（恒可消除）。
// ============================================================

'use strict';

const T = require('./类型');
const AU = require('./AST工具');

class 逃逸分析 {
  /**
   * @param {object} ast 程序节点（特化 + 内联后）
   * @param {object} 推断结果 类型推断结果（含签名/全局）
   */
  constructor(ast, 推断结果) {
    this.ast = ast;
    this.推断 = 推断结果;
    this.函数表 = AU.收集顶层函数(ast);
    /** 分配点记录：[{节点, 变量名, 类型, 是否逃逸, 原因, 字段}] */
    this.分配点 = [];
    /** 标量替换记录：原对象变量名 -> [字段名] */
    this.标量替换表 = {};
  }

  分析() {
    // 逐个函数分析其函数体内的分配点
    for (const [名, fn] of Object.entries(this.函数表)) {
      this.分析函数(fn);
    }
    // 顶层也分析一遍
    this.分析函数({ 体: this.ast, 名字: '<main>' });
    return this.结果();
  }

  结果() {
    return {
      分配点: this.分配点,
      标量替换表: this.标量替换表,
      逃逸总数: this.分配点.filter(a => a.是否逃逸).length,
      可标量替换数: this.分配点.filter(a => !a.是否逃逸 && a.字段).length
    };
  }

  分析函数(fn) {
    const body = fn.体;
    if (!body) return;

    // 1) 找出本函数内所有「结构体/对象分配」并绑定到变量
    const 本地对象 = new Map();   // 变量名 -> {节点, 类型, 字段}
    AU.遍历(body, (node) => {
      if (node.类型 !== '变量声明') return;
      const init = node.初始化;
      if (!init) return;
      // 结构体实例：结构体名(...) 是函数调用形式；字典字面量 / 对象也算
      if (init.类型 === '字典字面量' || init.类型 === '对象' ||
          (init.类型 === '函数调用' && this.是构造调用(init))) {
        const 类型 = node._类型 || init._类型 || T.bot();
        const 字段 = this.提取字段(init, 类型);
        const rec = { 节点: node, 类型, 字段, 是否逃逸: false, 原因: '' };
        本地对象.set(node.名字, rec);
        this.分配点.push(rec);
      }
    });

    if (本地对象.size === 0) return;

    // 2) 对每个本地对象，跟踪它是否逃逸
    for (const [变量名, rec] of 本地对象) {
      this.判定逃逸(body, 变量名, rec);
    }

    // 3) 不逃逸的结构体对象 -> 标量替换
    for (const [变量名, rec] of 本地对象) {
      if (!rec.是否逃逸 && rec.字段 && Object.keys(rec.字段).length > 0) {
        this.标量表替换(body, 变量名, rec.字段);
        this.标量替换表[变量名] = Object.keys(rec.字段);
      }
    }
  }

  是构造调用(callNode) {
    // 结构体/类构造器调用：被调者是已知结构体或类名
    const 名 = callNode.被调者 && callNode.被调者.名字;
    if (!名) return false;
    return !!(this.推断 && (this.推断.结构体 && this.推断.结构体[名]));
  }

  提取字段(init, 类型) {
    const 字段 = {};
    if (init.类型 === '字典字面量') {
      (init.键 || []).forEach((k, i) => {
        const kn = k.类型 === '字面量' ? k.值 : ('f' + i);
        字段[kn] = (init.值[i] && init.值[i]._类型) || T.bot();
      });
    } else if (类型.k === 'struct' || 类型.k === 'object') {
      Object.assign(字段, 类型.fields || {});
    }
    return 字段;
  }

  // 判定某变量是否逃逸
  判定逃逸(body, 变量名, rec) {
    let 逃逸 = false;
    let 原因 = '';
    AU.遍历(body, (node) => {
      if (逃逸) return;
      // 情形1：被 return
      if (node.类型 === '返回' && this.引用变量(node.值, 变量名)) {
        逃逸 = true; 原因 = '被函数返回'; return;
      }
      // 情形2：作为实参传给别的函数
      if (node.类型 === '函数调用') {
        for (const a of (node.参数 || [])) {
          if (this.引用变量(a, 变量名)) {
            逃逸 = true; 原因 = '作为实参传给其他函数'; return;
          }
        }
      }
      // 情形3：赋值给全局 / 上层变量（简单近似：赋值目标不是本变量自身字段）
      if (node.类型 === '赋值' &&
          node.目标.类型 === '标识符' && this.引用变量(node.值, 变量名)) {
        // 若目标变量名不同，视为外流
        if (node.目标.名字 !== 变量名) {
          逃逸 = true; 原因 = '被赋值给另一变量'; return;
        }
      }
      // 情形4：存入容器/字段（obj.field = p 或 list.push(p)）
      if (node.类型 === '赋值' && node.目标.类型 === '下标' &&
          this.引用变量(node.值, 变量名)) {
        逃逸 = true; 原因 = '被存入容器/对象字段'; return;
      }
    });
    rec.是否逃逸 = 逃逸;
    rec.原因 = 原因;
  }

  // 判断表达式 node 是否「引用了变量 名」（直接标识符或经字段访问）
  引用变量(node, 名) {
    if (!node || typeof node !== 'object') return false;
    if (node.类型 === '标识符') return node.名字 === 名;
    // 下标访问 p.x / p[i]：基是该变量即算引用
    if (node.类型 === '下标') return this.引用变量(node.容器, 名);
    if (Array.isArray(node)) return node.some(n => this.引用变量(n, 名));
    for (const k of Object.keys(node)) {
      if (k === '类型' || k === '名字' || k === '值' && node.字面类型) continue;
      if (this.引用变量(node[k], 名)) return true;
    }
    return false;
  }

  // 标量替换：把 p.x 的下标访问改写为对标量 p$x 的直接引用
  标量表替换(body, 变量名, 字段) {
    AU.遍历(body, (node) => {
      if (node.类型 !== '下标') return;
      if (!node.容器 || node.容器.类型 !== '标识符' || node.容器.名字 !== 变量名) return;
      if (!node.索引 || node.索引.类型 !== '字面量') return;
      const 字段名 = node.索引.值;
      if (字段[字段名] === undefined) return;
      // p.x -> 标识符 p$x
      node.类型 = '标识符';
      node.名字 = 变量名 + '$' + 字段名;
      node._标量字段 = 字段名;
      delete node.索引; delete node.容器;
    });
  }
}

module.exports = 逃逸分析;
