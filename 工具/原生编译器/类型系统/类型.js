// ============================================================
// 类型.js —— coCN 原生编译器的类型格（Type Lattice）
//
// 类型系统的数学核心。coCN 是动态类型语言，但我们在编译期为每个
// 变量/表达式推断出一个【静态类型】。类型之间构成一个格：
//
//                        动态 (Top，无法确定一切皆可能)
//                       / |  \           ...
//              联合类型 整数|浮点 (数值) ...
//              /   \    /
//           整数  浮点 字符串 布尔 列表 字典 函数 结构体 对象 ...（单类型）
//                       \   /
//                        底部 (Bottom，未定义/尚无信息)
//
// 所有类型都是普通 JSON 对象，便于：
//   1) 序列化进 AST 作为类型标注；
//   2) 被下游代码生成器消费（决定用 int[] / double[] 还是装箱指针）。
//
// 类型对象形态：
//   { k:'bot' }                                  底部（未定义）
//   { k:'int' } / { k:'float' } / { k:'str' }
//   { k:'bool' } / { k:'nil' }
//   { k:'list',  elem:<Type>,  specialized:bool, layout:'int[]'|'double[]'|'str[]'|'boxed[]' }
//   { k:'dict',  key:<Type>, val:<Type>, specialized:bool }
//   { k:'func',  name:str, params:[<Type>], ret:<Type> }
//   { k:'struct', name:str, fields:{字段名:<Type>} }
//   { k:'object', className:str, fields:{字段名:<Type>} }
//   { k:'union', types:[<Type>] }                联合类型（如 数值=int|float）
//   { k:'dyn' }                                  顶部（动态，放弃推断）
// ============================================================

'use strict';

// ---------- 类型构造器（工厂函数，统一入口） ----------
const bot   = () => ({ k: 'bot' });
const tInt  = () => ({ k: 'int' });
const tFloat= () => ({ k: 'float' });
const tStr  = () => ({ k: 'str' });
const tBool = () => ({ k: 'bool' });
const tNil  = () => ({ k: 'nil' });
const tDyn  = () => ({ k: 'dyn' });

const tList  = (elem, specialized = false, layout = null) => {
  if (!layout) {
    // 根据元素类型推断默认内存布局
    if (elem.k === 'int') layout = 'int[]';
    else if (elem.k === 'float') layout = 'double[]';
    else if (elem.k === 'str') layout = 'str[]';
    else layout = 'boxed[]';
  }
  return { k: 'list', elem, specialized, layout };
};

const tDict  = (key, val, specialized = false) => ({ k: 'dict', key, val, specialized });
const tFunc  = (name, params, ret) => ({ k: 'func', name: name || '', params: params || [], ret: ret || bot() });
const tStruct= (name, fields) => ({ k: 'struct', name, fields: fields || {} });
const tObject= (className, fields) => ({ k: 'object', className, fields: fields || {} });

// 数值联合类型的便捷构造（整数|浮点）
const tNum   = () => union([tInt(), tFloat()]);

// 规范化联合：拍平嵌套 union、去重、按 kind 排序，保持结构稳定
function union(types) {
  const flat = [];
  const seen = new Set();
  function push(t) {
    if (!t) return;
    if (t.k === 'bot') return;            // 底部吸收
    if (t.k === 'union') { t.types.forEach(push); return; }
    const key = keyOf(t);
    if (seen.has(key)) return;
    seen.add(key);
    flat.push(t);
  }
  types.forEach(push);
  if (flat.length === 0) return bot();
  if (flat.length === 1) return flat[0];
  flat.sort((a, b) => keyOf(a) < keyOf(b) ? -1 : 1);
  return { k: 'union', types: flat };
}

// ---------- 类型的稳定字符串键（用于去重 / 哈希 / 特化命名） ----------
function keyOf(t) {
  if (!t) return 'null';
  switch (t.k) {
    case 'bot':   return 'bot';
    case 'int':   return 'int';
    case 'float': return 'float';
    case 'str':   return 'str';
    case 'bool':  return 'bool';
    case 'nil':   return 'nil';
    case 'dyn':   return 'dyn';
    case 'list':  return 'list<' + keyOf(t.elem) + '>';
    case 'dict':  return 'dict<' + keyOf(t.key) + ',' + keyOf(t.val) + '>';
    case 'func':  return 'fn(' + t.params.map(keyOf).join(',') + ')->' + keyOf(t.ret);
    case 'struct':return 'struct:' + t.name;
    case 'object':return 'obj:' + t.className;
    case 'union': return '(' + t.types.map(keyOf).join('|') + ')';
    default:      return '?:' + t.k;
  }
}

// ---------- 特化函数命名用的短名（中文类型 -> C 风格后缀） ----------
const KIND_SHORT = {
  int: '整数', float: '浮点', str: '字符串', bool: '布尔', nil: '空',
  dyn: '动态', bot: '未定型'
};
function shortName(t) {
  if (!t) return '空';
  switch (t.k) {
    case 'list':   return '列表_' + shortName(t.elem);
    case 'dict':   return '字典_' + shortName(t.key) + '_' + shortName(t.val);
    case 'func':   return '函数';
    case 'struct': return '结构_' + t.name;
    case 'object': return '对象_' + t.className;
    case 'union':  return t.types.map(shortName).join('_或_');
    default:       return KIND_SHORT[t.k] || t.k;
  }
}

// ---------- 相等性 ----------
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'bot': case 'int': case 'float': case 'str': case 'bool':
    case 'nil': case 'dyn':
      return true;
    case 'list':  return equal(a.elem, b.elem);
    case 'dict':  return equal(a.key, b.key) && equal(a.val, b.val);
    case 'func': {
      if (a.params.length !== b.params.length) return false;
      if (!equal(a.ret, b.ret)) return false;
      for (let i = 0; i < a.params.length; i++)
        if (!equal(a.params[i], b.params[i])) return false;
      return true;
    }
    case 'struct': case 'object': {
      if (a.name !== b.name) return false;
      const fa = a.fields || {}, fb = b.fields || {};
      const ka = Object.keys(fa), kb = Object.keys(fb);
      if (ka.length !== kb.length) return false;
      for (const f of ka) if (!equal(fa[f], fb[f])) return false;
      return true;
    }
    case 'union': {
      if (a.types.length !== b.types.length) return false;
      const bset = new Set(b.types.map(keyOf));
      return a.types.every(t => bset.has(keyOf(t)));
    }
    default: return false;
  }
}

// ---------- 子类型判定：a <= b（a 在格中不高于 b） ----------
function isSubtype(a, b) {
  if (!a || !b) return false;
  if (a.k === 'bot') return true;            // 底部是一切的子类型
  if (b.k === 'dyn') return true;            // 一切是顶部的子类型
  if (b.k === 'union') return b.types.some(bt => isSubtype(a, bt));
  if (a.k === 'union') return a.types.every(at => isSubtype(at, b));
  return equal(a, b);
}

// ---------- 最小上界（LUB / 类型合并） ----------
// 这是控制流汇合处合并两个类型的核心运算：
//   整数 + 浮点   -> 数值(union)
//   整数 + 整数   -> 整数
//   整数 + 字符串 -> 动态(dyn)
//   列表<int> + 列表<float> -> 列表<数值>
function lub(a, b) {
  if (!a) return b || bot();
  if (!b) return a;
  if (a.k === 'bot') return b;
  if (b.k === 'bot') return a;
  if (a.k === 'dyn' || b.k === 'dyn') return tDyn();
  if (equal(a, b)) return a;

  // 数值提升：int <: float 时统一到 float
  if (a.k === 'int' && b.k === 'float') return tFloat();
  if (a.k === 'float' && b.k === 'int') return tFloat();

  // 列表：元素类型取 LUB，布局升级为装箱（除非元素仍是标量）
  if (a.k === 'list' && b.k === 'list') {
    const e = lub(a.elem, b.elem);
    if (e.k === 'dyn') return tList(tDyn(), false, 'boxed[]');
    return tList(e, false);
  }
  // 字典：键值分别取 LUB
  if (a.k === 'dict' && b.k === 'dict') {
    return tDict(lub(a.key, b.key), lub(a.val, b.val), false);
  }
  // 结构体：同名结构字段取 LUB，否则动态
  if (a.k === 'struct' && b.k === 'struct' && a.name === b.name) {
    const fields = {};
    for (const f of Object.keys(a.fields)) {
      fields[f] = a.fields[f] && b.fields[f] ? lub(a.fields[f], b.fields[f]) : tDyn();
    }
    return tStruct(a.name, fields);
  }
  // 函数：参数数不同则动态；否则逐参数取 LUB、返回取 LUB
  if (a.k === 'func' && b.k === 'func' && a.params.length === b.params.length) {
    const ps = a.params.map((p, i) => lub(p, b.params[i]));
    return tFunc(a.name || b.name, ps, lub(a.ret, b.ret));
  }
  // 联合展开：已在 union 构造里拍平
  if (a.k === 'union' || b.k === 'union') {
    const ta = a.k === 'union' ? a.types : [a];
    const tb = b.k === 'union' ? b.types : [b];
    return union(ta.concat(tb));
  }
  // 其他不相干类型 -> 动态
  return tDyn();
}

// ---------- 字面量 -> 类型（从 AST 字面类型映射） ----------
// AST 字面类型：整数 / 浮点 / 字符串 / 布尔
function fromLiteral(literalType) {
  switch (literalType) {
    case '整数': return tInt();
    case '浮点': return tFloat();
    case '字符串': return tStr();
    case '布尔': return tBool();
    default: return tDyn();
  }
}

// ---------- 二元运算符的类型推导 ----------
// 给定左右类型，返回运算结果类型。
// 【单调性约定】：任一操作数是 bot（尚未观察到任何信息）-> 结果 bot，
//   让定点分析从底部逐步上升；一旦确定为 dyn（放弃）才停在顶部。
function binaryResult(op, lt, rt) {
  // 任一操作数未知 -> 结果未知（保持在格底，等待更多调用点信息）
  if (!lt || lt.k === 'bot' || !rt || rt.k === 'bot') return bot();
  // 任一操作数已动态 -> 结果动态
  if (lt.k === 'dyn' || rt.k === 'dyn') return tDyn();

  const numeric = t => t.k === 'int' || t.k === 'float' || (t.k === 'union' &&
    t.types.some(x => x.k === 'int' || x.k === 'float'));

  // 比较运算一律返回布尔（即使操作数动态）
  const cmpOps = ['==', '!=', '<', '<=', '>', '>='];
  if (cmpOps.indexOf(op) >= 0) return tBool();
  if (op === '且' || op === '或') return tBool();
  if (op === '&&' || op === '||') return tBool();

  // 算术运算
  if (op === '+' ) {
    // 字符串拼接
    if (lt.k === 'str' || rt.k === 'str') return tStr();
    if (numeric(lt) && numeric(rt)) return lub(lt, rt);
    // 列表拼接
    if (lt.k === 'list' && rt.k === 'list') return tList(lub(lt.elem, rt.elem), false);
    return tDyn();
  }
  if (op === '-' || op === '*' || op === '/' || op === '%' || op === '**' ||
      op === '//' || op === '<<' || op === '>>' || op === '&' || op === '^' || op === '|') {
    if (numeric(lt) && numeric(rt)) return lub(lt, rt);
    return tDyn();
  }
  return tDyn();
}

// ---------- 序列化辅助 ----------
// 生成给代码生成器的「原生目标类型」字符串（C 类型名）。
function toC(t) {
  if (!t) return 'void*';
  switch (t.k) {
    case 'int':   return 'int64_t';
    case 'float': return 'double';
    case 'str':   return 'co_str*';
    case 'bool':  return 'bool';
    case 'nil':   return 'void*';
    case 'dyn':   return 'co_val';
    case 'list':  return t.layout;          // int[] / double[] / boxed[]
    case 'dict':  return 'co_dict*';
    case 'func':  return 'void*';
    case 'struct':return 'struct_' + t.name + '*';
    case 'object':return 'obj_' + t.className + '*';
    case 'union': {
      // 联合类型退化到动态装箱（除非只是数值联合 -> double）
      const nums = t.types.filter(x => x.k === 'int' || x.k === 'float');
      if (nums.length === t.types.length) return 'double';
      return 'co_val';
    }
    default: return 'co_val';
  }
}

module.exports = {
  bot, tInt, tFloat, tStr, tBool, tNil, tDyn, tList, tDict, tFunc, tStruct, tObject, tNum,
  union, keyOf, shortName, equal, isSubtype, lub, fromLiteral, binaryResult, toC
};
