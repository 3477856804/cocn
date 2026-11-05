// ============================================================
// passes/dce.js —— Pass 2：死代码消除
//
// 使用跨块活跃变量分析：
//   1. 计算每个块的 liveIn/liveOut
//   2. 反向扫描块内指令，从 liveOut 开始维护 liveVars
//   3. 无副作用且 dest 不在 liveVars 的指令 -> 死，删除
//   4. 同时删除不可达块
//   5. 迭代直到不动点
// ============================================================
'use strict';

const I = require('../ir');
const A = require('../analysis');

function eliminateDeadCode(fn) {
  let outer = 0;
  let changedOverall = true;
  while (changedOverall && outer++ < 30) {
    changedOverall = false;
    I.buildCFG(fn);

    // 跨块活跃分析
    const { liveIn, liveOut } = A.liveness(fn);

    // 逐块反向扫描
    for (const blk of fn.blocks) {
      let liveVars = new Set(liveOut[blk.id]);
      // 先加终结符的 use
      for (const v of I.termUse(blk.term)) liveVars.add(v);

      const kept = [];
      // 反向遍历
      for (let i = blk.instrs.length - 1; i >= 0; i--) {
        const instr = blk.instrs[i];
        const d = I.instrDef(instr);
        const side = I.hasSideEffect(instr);
        const isLive = side || (d && liveVars.has(d));

        if (isLive) {
          kept.unshift(instr);
          // def 先杀
          if (d) liveVars.delete(d);
          // 加 use
          for (const u of I.instrUse(instr)) liveVars.add(u);
        }
        // phi 不能在这里删（SSA 结构需要）；后续 pass 处理
        if (!isLive && instr.op === 'phi') kept.unshift(instr);
      }
      if (kept.length !== blk.instrs.length) changedOverall = true;
      blk.instrs = kept;
    }

    // 不可达块删除
    const reach = A.reachable(fn);
    for (let b = 0; b < fn.blocks.length; b++) {
      if (!reach[b]) {
        fn.blocks[b].instrs = [];
        fn.blocks[b].term = I.unreachable();
        changedOverall = true;
      }
    }
    if (changedOverall) I.buildCFG(fn);
  }
  return fn;
}

module.exports = { eliminateDeadCode };
