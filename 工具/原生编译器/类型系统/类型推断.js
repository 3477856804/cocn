// ============================================================
// 类型推断.js —— 数据流类型推断引擎
//
// 输入：coCN AST（JSON）。
// 输出：
//   1) 每个表达式/变量节点就地标注 _类型（静态类型）；
//   2) 每个函数的【签名】（参数类型 + 返回类型）；
//   3) 全局类型表，供函数特化 / 内联 / 代码生成消费。
//
// 推断策略（自底向上 + 定点迭代）：
//   - 字面量 -> 直接类型
//   - 变量声明 -> 从初始化表达式推断
//   - 赋值 -> 与既有类型 LUB；漂移则升级动态
//   - 二元/一元 -> 按运算符规则推导
//   - 函数调用 -> 用实参类型累积形参类型，返回值取函数已知返回类型
//   - 控制流汇合（如果分支 / 循环头）-> 逐变量 LUB 合并
//   - 函数间互相递归 -> 对所有函数做定点迭代直到签名收敛
// ============================================================

'use strict';

const T = require('./类型');
const 环境 = require('./环境');
const AU = require('./AST工具');

class 类型推断 {
  /**
   * @param {object} ast 程序节点 {类型:'程序', 语句:[...]}
   */
  constructor(ast) {
    this.ast = ast;
    this.函数表 = AU.收集顶层函数(ast);   // 名字 -> 函数节点
    /** 函数签名：名字 -> tFunc */
    this.签名 = {};
    /** 函数返回类型：名字 -> Type */
    this.返回类型 = {};
    /** 调用点记录：[{调用节点, 函数名, 实参类型:[Type]}] */
    this.调用点 = [];
    /** 全局（顶层）变量类型 */
    this.全局 = {};
    this.最大迭代 = 30;
  }

  // ---------- 入口：跑定点迭代直到收敛 ----------
  分析() {
    // 1) 先把结构体/类字段登记进类型系统
    this.登记类型定义();
    // 2) 迭代分析所有函数 + 顶层体，直到签名与全局类型都不再变化
    let n = 0;
    while (n < this.最大迭代) {
      this._变了 = false;
      this.调用点 = [];                       // 每轮重记调用点（按节点引用去重）
      for (const [名字, fn] of Object.entries(this.函数表)) {
        this.分析一个函数(名字, fn);
      }
      this.分析顶层();                          // 顶层调用也参与定点反馈
      n++;
      if (!this._变了) break;
    }
    this.迭代次数 = n;
    return this.结果();
  }

  结果() {
    return {
      签名: this.签名,
      返回类型: this.返回类型,
      调用点: this.调用点,
      全局: this.全局,
      迭代次数: this.迭代次数
    };
  }

  // ---------- 登记结构体/类/枚举 ----------
  登记类型定义() {
    this.结构体 = {};   // 名字 -> {字段:[str]}
    this.类 = {};       // 名字 -> {父类, 字段:[声明], 方法:[fn]}
    AU.遍历(this.ast, (node) => {
      if (node.类型 === '结构体定义') {
        this.结构体[node.名字] = { 字段: node.字段 || [] };
      } else if (node.类型 === '类定义') {
        this.类[node.名字] = { 父类: node.父类, 字段: node.字段, 方法: node.方法 };
      }
    });
  }

  // ---------- 顶层程序体 ----------
  分析顶层() {
    const env = new 环境();
    // 顶层函数本身在环境中可见（作为函数类型）
    for (const [名字, fn] of Object.entries(this.函数表)) {
      env.定义(名字, T.tFunc(名字, [], this.返回类型[名字] || T.bot()));
    }
    if (this.ast && Array.isArray(this.ast.语句)) {
      for (const st of this.ast.语句) this.分析语句(st, env);
    }
    // 导出全局变量
    for (const [k, v] of env.打平()) this.全局[k] = v;
  }

  // ---------- 分析单个函数体，更新其签名 ----------
  分析一个函数(名字, fn) {
    const env = new 环境();
    const 形参 = fn.参数 || [];
    // 形参类型：取该函数在所有调用点累积的 LUB；若有标注则用标注
    const 形参类型 = 形参.map((p, i) => {
      const 标注 = fn.参数类型 && fn.参数类型[i];
      if (标注) return this.标注到类型(标注);
      // 累积自调用点：签名[名字].params[i]
      const sig = this.签名[名字];
      if (sig && sig.params[i]) return sig.params[i];
      return T.bot();
    });
    形参.forEach((p, i) => env.定义(p, 形参类型[i]));

    const 返回 = this.分析程序节点(fn.体, env);

    // 返回类型累积 LUB（函数可能有多条 return）
    const 旧返回 = this.返回类型[名字] || T.bot();
    const 新返回 = T.lub(旧返回, 返回);
    if (!T.equal(旧返回, 新返回)) {
      this.返回类型[名字] = 新返回;
      this._变了 = true;
    }
    // 签名
    const 旧签名 = this.签名[名字];
    const 新签名 = T.tFunc(名字, 形参类型, 新返回);
    if (!旧签名 || !T.equal(旧签名, 新签名)) {
      this.签名[名字] = 新签名;
      this._变了 = true;
    }
  }

  // 把 coCN 类型标注关键字转成类型
  标注到类型(标注) {
    switch (标注) {
      case '整数': return T.tInt();
      case '浮点': return T.tFloat();
      case '字符串': return T.tStr();
      case '布尔': return T.tBool();
      case '空': case '空值': return T.tNil();
      default: return T.tDyn();
    }
  }

  // ---------- 分析一个「程序」节点（语句列表包裹） ----------
  分析程序节点(程序节点, env) {
    if (!程序节点) return T.bot();
    const 语句列表 = 程序节点.语句 || 程序节点; // 容忍直接传数组
    return this.分析语句列表(语句列表, env);
  }

  // ---------- 分析语句列表，返回最后一条表达式语句的类型 ----------
  分析语句列表(列表, env) {
    let 末类型 = T.bot();
    if (!Array.isArray(列表)) return 末类型;
    for (const st of 列表) {
      if (!st || typeof st !== 'object') continue;
      const t = this.分析语句(st, env);
      if (t) 末类型 = t;
    }
    return 末类型;
  }

  // ---------- 语句分发 ----------
  分析语句(st, env) {
    switch (st.类型) {
      case '变量声明': {
        let t = T.bot();
        if (st.初始化) t = this.分析表达式(st.初始化, env);
        if (st.类型标注) t = T.lub(t, this.标注到类型(st.类型标注));
        env.定义(st.名字, t);
        AU.标注类型(st, t);
        return null;
      }
      case '赋值': {
        const v = this.分析表达式(st.值, env);
        this.对目标赋值(st.目标, v, env);
        AU.标注类型(st, v);
        return v;
      }
      case '如果':  return this.分析如果(st, env);
      case '当':    return this.分析当(st, env);
      case '对于':  return this.分析对于(st, env);
      case '返回': {
        const t = st.值 ? this.分析表达式(st.值, env) : T.tNil();
        AU.标注类型(st, t);
        // 记录到当前函数返回类型
        return t;
      }
      case '跳出': case '继续': return null;
      case '抛出': return this.分析表达式(st.值, env);
      case '尝试': {
        this.分析语句列表(st.体, env);
        if (st.捕获变量) env.定义(st.捕获变量, T.tDyn());
        this.分析语句列表(st.捕获体, env);
        this.分析语句列表(st.最终体, env);
        return null;
      }
      case '匹配': {
        const on = this.分析表达式(st.表达式, env);
        for (const br of (st.分支 || [])) this.分析语句列表(br.体, env);
        return on;
      }
      case '函数定义': case '函数字面量': {
        // 嵌套函数：登记进函数表（延迟分析，下一轮迭代覆盖）
        if (st.名字 && !this.函数表[st.名字]) this.函数表[st.名字] = st;
        env.定义(st.名字, T.tFunc(st.名字, [], T.bot()));
        return null;
      }
      case '结构体定义': case '类定义': case '枚举': case '导入': return null;
      default: {
        // 表达式语句
        if (st.被调者 || st.左 !== undefined || st.类型 === '标识符' ||
            st.类型 === '字面量' || st.类型 === '函数调用' || st.类型 === '下标') {
          return this.分析表达式(st, env);
        }
        return null;
      }
    }
  }

  // 赋值目标可能是 标识符 / 下标
  对目标赋值(目标, v, env) {
    if (!目标) return;
    if (目标.类型 === '标识符') {
      env.赋值(目标.名字, v);
      AU.标注类型(目标, v);
    } else if (目标.类型 === '下标') {
      this.分析表达式(目标.容器, env);
      this.分析表达式(目标.索引, env);
    }
  }

  // ---------- 如果：分支汇合 LUB ----------
  分析如果(st, env) {
    this.分析表达式(st.条件, env);
    const before = env.打平();

    // 收集所有分支结束后的视图
    const 分支视图 = [];
    const thenEnv = this.派生环境(env, before);
    this.分析语句列表(st.则体, thenEnv);
    分支视图.push(thenEnv.打平());

    for (const br of (st.否则链 || [])) {
      if (br.条件) this.分析表达式(br.条件, env);
      const brEnv = this.派生环境(env, before);
      this.分析语句列表(br.体, brEnv);
      分支视图.push(brEnv.打平());
    }
    // 没有最终 else 分支时，控制流也可能「跳过整个如果」-> 并入 before
    分支视图.push(before);

    // 逐变量 LUB 合并回 env 顶层
    const 所有变量 = new Set();
    for (const v of 分支视图) for (const k of v.keys()) 所有变量.add(k);
    for (const k of 所有变量) {
      let t = T.bot();
      for (const v of 分支视图) t = T.lub(t, v.get(k) || T.bot());
      env.赋值(k, t);
    }
    return null;
  }

  // 从一个打平视图派生出独立环境（不共享父层可变表）
  派生环境(env, 视图) {
    const e = new 环境(env.父);
    for (const [k, t] of 视图) e.表.set(k, t);
    return e;
  }

  // ---------- 当循环：迭代到收敛 ----------
  分析当(st, env) {
    for (let i = 0; i < 10; i++) {
      const before = env.打平();
      this.分析表达式(st.条件, env);
      this.分析语句列表(st.体, env);
      const after = env.打平();
      if (视图相等(before, after)) break;
    }
    return null;
  }

  // ---------- 对于循环 ----------
  分析对于(st, env) {
    if (st.是否遍历 === 1) {
      // for-each：x 于 list -> x 为 list.elem
      const 容器类型 = this.分析表达式(st.遍历源, env);
      let 元素 = T.bot();
      if (容器类型.k === 'list') 元素 = 容器类型.elem;
      else if (容器类型.k === 'str') 元素 = T.tStr();
      else 元素 = T.tDyn();
      env.定义(st.变量, 元素);
      AU.标注类型({ 类型: '标识符', 名字: st.变量 }, 元素);
      for (let i = 0; i < 8; i++) {
        const before = env.打平();
        this.分析语句列表(st.体, env);
        const after = env.打平();
        if (视图相等(before, after)) break;
      }
    } else {
      // 范围：对于 x 从 a 到 b -> x 为 lub(a,b)
      const a = this.分析表达式(st.起点, env);
      const b = this.分析表达式(st.终点, env);
      env.定义(st.变量, T.lub(a, b));
      if (st.步长) this.分析表达式(st.步长, env);
      for (let i = 0; i < 8; i++) {
        const before = env.打平();
        this.分析语句列表(st.体, env);
        const after = env.打平();
        if (视图相等(before, after)) break;
      }
    }
    return null;
  }

  // ---------- 表达式分发 ----------
  分析表达式(node, env) {
    if (!node || typeof node !== 'object') return T.bot();
    let t;
    switch (node.类型) {
      case '字面量':
        t = T.fromLiteral(node.字面类型);
        break;
      case '标识符':
        t = env.查找(node.名字);
        break;
      case '二元': {
        const l = this.分析表达式(node.左, env);
        const r = this.分析表达式(node.右, env);
        t = T.binaryResult(node.运算符, l, r);
        break;
      }
      case '一元': {
        const o = this.分析表达式(node.操作数, env);
        t = (node.运算符 === '非') ? T.tBool() : (o.k === 'float' ? o : T.lub(o, T.tInt()));
        break;
      }
      case '函数调用':
        t = this.分析调用(node, env);
        break;
      case '下标': {
        const c = this.分析表达式(node.容器, env);
        this.分析表达式(node.索引, env);
        t = this.下标结果(c, node.索引);
        break;
      }
      case '列表字面量': {
        if (node.是否推导式 === 1) {
          // 列表推导式：元素类型 = 推导体类型
          const src = this.分析表达式(node.推导源, env);
          env.定义(node.迭代变量, src.k === 'list' ? src.elem : T.tDyn());
          if (node.过滤器) this.分析表达式(node.过滤器, env);
          const body = this.分析表达式(node.推导体, env);
          t = T.tList(body, false);
        } else {
          const elems = (node.元素 || []).map(e => this.分析表达式(e, env));
          const 合并 = elems.reduce((a, b) => T.lub(a, b), T.bot());
          t = T.tList(合并, elems.length > 0);
        }
        break;
      }
      case '字典字面量': {
        const ks = (node.键 || []).map(k => this.分析表达式(k, env));
        const vs = (node.值 || []).map(v => this.分析表达式(v, env));
        const k = ks.reduce((a, b) => T.lub(a, b), T.tStr());
        const v = vs.reduce((a, b) => T.lub(a, b), T.bot());
        t = T.tDict(k, v, (node.键 || []).length > 0);
        break;
      }
      case '元组字面量': {
        (node.元素 || []).map(e => this.分析表达式(e, env));
        t = T.tList(T.tDyn(), false, 'boxed[]');
        break;
      }
      case '范围': {
        this.分析表达式(node.起点, env);
        this.分析表达式(node.终点, env);
        t = T.tList(T.tInt(), true, 'int[]');
        break;
      }
      case '函数字面量': {
        t = T.tFunc(node.名字 || '', node.参数类型 || [], T.bot());
        break;
      }
      case '对象': {
        t = T.tObject(node.类名 || '?', {});
        break;
      }
      default:
        t = T.tDyn();
    }
    AU.标注类型(node, t);
    return t;
  }

  // 下标结果：list[i] -> elem；dict[k] -> val；obj.f -> 字段类型
  下标结果(容器类型, 索引节点) {
    if (容器类型.k === 'list') return 容器类型.elem;
    if (容器类型.k === 'str') return T.tStr();
    if (容器类型.k === 'dict') return 容器类型.val;
    if (容器类型.k === 'struct' && 索引节点 && 索引节点.类型 === '字面量') {
      const f = 容器类型.fields[索引节点.值];
      return f || T.tDyn();
    }
    if (容器类型.k === 'object' && 索引节点 && 索引节点.类型 === '字面量') {
      const f = 容器类型.fields[索引节点.值];
      return f || T.tDyn();
    }
    return T.tDyn();
  }

  // ---------- 函数调用：累积实参类型，返回返回类型 ----------
  分析调用(node, env) {
    // 解析被调者名字
    let 函数名 = null;
    if (node.被调者.类型 === '标识符') 函数名 = node.被调者.名字;
    else if (node.被调者.类型 === '下标' && node.被调者.容器.类型 === '标识符') {
      // 方法调用 obj.方法(...) —— 暂按普通函数处理，方法特化阶段再细化
      函数名 = null;
    }

    // 实参类型
    const 实参 = (node.参数 || []).map(a => this.分析表达式(a, env));

    if (函数名 && this.函数表[函数名]) {
      // 累积到形参类型（LUB）—— 这是反馈回定点迭代的关键
      const sig = this.签名[函数名] || T.tFunc(函数名, [], T.bot());
      const 旧参 = sig.params.slice();
      const 新参 = sig.params.map((p, i) => (实参[i] ? T.lub(p, 实参[i]) : p));
      // 形参数目可能滞后（首次见到该调用）
      while (新参.length < 实参.length) 新参.push(实参[新参.length] || T.bot());
      let 参变了 = false;
      for (let i = 0; i < 新参.length; i++) {
        if (!T.equal(新参[i], 旧参[i] || T.bot())) { 参变了 = true; break; }
      }
      if (参变了) {
        this.签名[函数名] = T.tFunc(函数名, 新参, sig.ret);
        this._变了 = true;
      }
      this.调用点.push({ 调用节点: node, 函数名, 实参类型: 实参 });
      // 返回值取已知返回类型
      const ret = this.返回类型[函数名] || T.bot();
      return ret;
    }
    // 未知函数 / 内建函数 -> 动态
    return T.tDyn();
  }
}

// ---------- 两个打平视图是否相等 ----------
function 视图相等(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, t] of a) {
    if (!T.equal(t, b.get(k) || T.bot())) return false;
  }
  return true;
}

module.exports = 类型推断;
