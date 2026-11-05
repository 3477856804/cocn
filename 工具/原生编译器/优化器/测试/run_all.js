// 测试入口：node run_all.js
'use strict';
require('./test_ssa');
require('./test_constfold');
require('./test_dce');
require('./test_loop');
require('./test_regalloc');
require('./test_e2e');
require('./test_gvn_spill');
const { summary } = require('./harness');
summary();
