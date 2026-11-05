// ============================================================
// AST工具.js —— coCN AST 的遍历 / 深拷贝 / 查询工具
//
// 与 语法分析器.co 输出的 AST 节点约定一致（节点用「类型」字段标识）：
//   程序 {语句:[]}
//   变量声明 {名字, 类型标注, 初始化}
//   赋值 {目标, 值}
//   如果 {条件, 则体:[], 否则链:[{条件,体}]}
//   当 {条件, 体:[]}
//   对于 {变量, 遍历源, 体:[], 是否遍历:1} | {变量, 起点,终点,步长, 体:[]}
//   返回 {值}   跳出 {}   继续 {}   抛出 {值}
//   尝试 {体, 捕获变量, 捕获体, 最终体}
//   匹配 {表达式, 分支:[{模式,体,是否默认}]}
//   函数定义/函数字面量 {名字, 参数:[], 参数类型:[], 参数默认:[], 返回类型, 体:程序}
//   函数调用 {被调者, 参数:[]}
//   下标 {容器, 索引}
//   二元 {运算符, 左, 右}   一元 {运算符, 操作数}
//   字面量 {值, 字面类型}   标识符 {名字}
//   列表字面量 {元素:[], 是否推导式, 推导体, 迭代变量, 推导源, 过滤器}
//   字典字面量 {键:[], 值:[]}   元组字面量 {元素:[]}
//   结构体定义 {名字, 字段:[str]}   类定义 {名字, 父类, 字段:[], 方法:[]}
//   枚举 {名字, 成员:[str]}   范围 {起点, 终点}   导入 {路径, 命名空间}
// ============================================================

'use strict';

// 需要作为【子 AST 节点】递归遍历的字段名
const 子节点字段 = new Set([
  '初始化', '值', '目标', '条件', '左', '右', '操作数', '被调者', '容器',
  '索引', '起点', '终点', '步长', '遍历源', '推导体', '推导源', '过滤器',
  '表达式', '模式', '体', '捕获体', '最终体'
]);
// 需要作为【子 AST 节点数组】遍历的字段名
const 子数组字段 = new Set([
  '语句', '元素', '参数', '键', '值', '方法', '字段', '则体', '否则链',
  '体' // 部分节点的体本身就是数组
]);

/**
 * 递归遍历 AST。visitor(node) 在每个节点被调用一次。
 * @param {object|array} node
 * @param {(node:object, parent:object, field:string)=>void} visitor
 */
function 遍历(node, visitor, parent = null, field = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) 遍历(node[i], visitor, parent, field);
    return;
  }
  if (typeof node.类型 !== 'string') return;   // 不是 AST 节点
  visitor(node, parent, field);

  for (const [k, v] of Object.entries(node)) {
    if (k === '类型') continue;
    if (子节点字段.has(k)) {
      遍历(v, visitor, node, k);
    } else if (Array.isArray(v)) {
      // 数组里可能是 AST 节点（则体/体/元素...）也可能是字符串（字段名/成员名）
      for (const item of v) {
        if (item && typeof item === 'object' && typeof item.类型 === 'string') {
          遍历(item, visitor, node, k);
        } else if (item && typeof item === 'object' && Array.isArray(item.体)) {
          // 否则链元素：{条件,体}
          if (item.条件) 遍历(item.条件, visitor, node, k);
          for (const s of item.体) 遍历(s, visitor, node, k);
        }
      }
    }
  }
}

/** 深拷贝 AST（JSON 可序列化，直接 structuredClone 风格） */
function 克隆(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(克隆);
  const out = {};
  for (const k of Object.keys(node)) out[k] = 克隆(node[k]);
  return out;
}

/** 统计一个函数体的「逻辑行数」（顶层语句 + 表达式节点数的近似） */
function 函数规模(函数节点) {
  let n = 0;
  遍历(函数节点.体, () => { n++; });
  return n;
}

/** 在整个 AST 中查找名为 name 的函数定义（顶层或类方法）。返回节点或 null。 */
function 查找函数(程序节点, 名字) {
  let 找到 = null;
  遍历(程序节点, (node) => {
    if (找到) return;
    if ((node.类型 === '函数定义' || node.类型 === '函数字面量') && node.名字 === 名字) {
      找到 = node;
    }
  });
  return 找到;
}

/** 收集顶层所有函数定义 */
function 收集顶层函数(程序节点) {
  const 表 = {};
  if (!程序节点 || !Array.isArray(程序节点.语句)) return 表;
  for (const st of 程序节点.语句) {
    if (!st || typeof st !== 'object') continue;
    if (st.类型 === '函数定义') 表[st.名字] = st;
    if (st.类型 === '类定义' && Array.isArray(st.方法)) {
      for (const m of st.方法) 表[st.名字 + '.' + m.名字] = m;
    }
  }
  return 表;
}

/** 给节点附加类型标注（就地写入 _类型 字段，代码生成器据此生成原生代码） */
function 标注类型(node, typeObj) {
  if (node && typeof node === 'object') node._类型 = typeObj;
}

/** 读取节点上的类型标注 */
function 读标注(node) {
  return node ? node._类型 : undefined;
}

module.exports = {
  遍历, 克隆, 函数规模, 查找函数, 收集顶层函数, 标注类型, 读标注
};
