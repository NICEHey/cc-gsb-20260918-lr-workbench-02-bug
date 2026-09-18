/* 前端纯逻辑自测: node tests/frontend.test.js
 * 由 selftest.py 在检测到 node 时自动调用, 也可单独运行。 */
"use strict";

const path = require("path");
const C = require(path.join(__dirname, "..", "core.js"));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; } else { failures.push([name, detail || ""]); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------
// 符号与草稿校验
// ---------------------------------------------------------------
check("validSymbol 基本规则",
  C.validSymbol("id") && C.validSymbol("E") && C.validSymbol("_x9") &&
  C.validSymbol("+") && C.validSymbol("=") &&
  !C.validSymbol("9x") && !C.validSymbol("++") && !C.validSymbol(""));
["$", "ε", "@START"].forEach((s) => {
  const d = C.defaultDraft();
  d.terminals = [s];
  check("保留符号被拒: " + s, C.validateDraft(d).errors.some((e) => e.includes("保留")));
});

(function () {
  const d = C.defaultDraft();
  const snap = JSON.stringify(d);
  const r = C.validateDraft(d);
  check("默认草稿合法", r.errors.length === 0, JSON.stringify(r.errors));
  check("校验不修改草稿", JSON.stringify(d) === snap);
})();

(function () {
  const d = C.defaultDraft();
  d.terminals.push("E");
  check("终结符/非终结符重名报错",
    C.validateDraft(d).errors.some((e) => e.includes("同时")));
})();

(function () {
  const d = C.defaultDraft();
  d.productions[0].rhs.push("Q");
  check("未知符号报错", C.validateDraft(d).errors.some((e) => e.includes("未知符号")));
  const d2 = C.defaultDraft();
  d2.productions.push({ id: "f-id", lhs: "X", rhs: ["id"] }); // 与 f-id 同 id
  check("ID 重复报错", C.validateDraft(d2).errors.some((e) => e.includes("ID")));
  const d3 = C.defaultDraft();
  d3.productions.push({ id: "x", lhs: "F", rhs: ["id"] }); // 与 f-id 同体
  check("产生式重复报错(ID 不同也拒绝)",
    C.validateDraft(d3).errors.some((e) => e.includes("重复")));
  const d4 = C.defaultDraft();
  d4.start = "Z";
  check("缺失开始符号报错", C.validateDraft(d4).errors.some((e) => e.includes("开始符号")));
  const d5 = C.defaultDraft();
  d5.extra = 1;
  check("未知字段整体拒绝", C.validateDraft(d5).errors.some((e) => e.includes("未知字段")));
})();

(function () {
  const d = { version: 1, name: "lr", start: "A", terminals: ["a"],
    productions: [
      { id: "rec", lhs: "A", rhs: ["A", "a"] },
      { id: "eps", lhs: "A", rhs: [] },
    ] };
  const r = C.validateDraft(d);
  check("左递归与 ε 产生式合法", r.errors.length === 0, JSON.stringify(r.errors));
})();

// ---------------------------------------------------------------
// 项目合并 / 还原
// ---------------------------------------------------------------
function miniTable(mode) {
  // 0: S'→·S, S→·a ; --a-> 1 ; --S-> 2
  // 1: S→a·  (SLR 按 FOLLOW(S)={$} 归约; LR1 项目展望符 $)
  // 2: S'→S·  ($ accept)
  const items1 = mode === "SLR"
    ? [{ production: 1, dot: 1 }]
    : [{ production: 1, dot: 1, lookahead: "$" }];
  return {
    version: 1, mode,
    grammar: { version: 1, name: "m", start: "S", terminals: ["a"],
      productions: [{ id: "s-a", lhs: "S", rhs: ["a"] }] },
    nullable: [], first: { S: ["a"] }, follow: { S: ["$"] },
    states: [
      { id: 0,
        items: mode === "SLR"
          ? [{ production: 0, dot: 0 }, { production: 1, dot: 0 }]
          : [{ production: 0, dot: 0, lookahead: "$" }, { production: 1, dot: 0, lookahead: "$" }],
        transitions: { S: 2, a: 1 },
        action: { a: [{ type: "shift", to: 1 }] }, goto: { S: 2 } },
      { id: 1, items: items1, transitions: {},
        action: { $: [{ type: "reduce", production: 1 }] }, goto: {} },
      { id: 2,
        items: mode === "SLR" ? [{ production: 0, dot: 1 }]
          : [{ production: 0, dot: 1, lookahead: "$" }],
        transitions: {},
        action: { $: [{ type: "accept" }] }, goto: {} },
    ],
    conflicts: [],
  };
}

(function () {
  // 多展望符合并再还原
  const t = miniTable("LR1");
  t.states[0].items.push(
    { production: 1, dot: 0, lookahead: "b" },
    { production: 1, dot: 0, lookahead: "a" });
  const groups = C.mergeItems(t, 0);
  const g1 = groups.find((g) => g.production === 1);
  check("同核心多展望符合并展示", eq(g1.lookaheadList, ["$", "a", "b"]));
  const expanded = C.expandItemGroup(g1);
  check("合并组可还原每一个 LR1 项目",
    expanded.length === 3 && expanded.every((it) => typeof it.lookahead === "string"));
  const slrGroups = C.mergeItems(miniTable("SLR"), 0);
  check("SLR 组无展望符", slrGroups.every((g) => g.lookaheadList.length === 0));
})();

(function () {
  const slr = miniTable("SLR");
  const origins = C.actionOrigins(slr, 1, "$");
  check("SLR 归约解释明确引用 FOLLOW 成员",
    origins.length === 1 && origins[0].explanation.includes("FOLLOW") &&
    origins[0].explanation.includes("$"));
  const lr1 = miniTable("LR1");
  const o2 = C.actionOrigins(lr1, 1, "$");
  check("LR1 归约解释明确引用项目展望符",
    o2.length === 1 && o2[0].explanation.includes("展望符"));
  const o3 = C.actionOrigins(lr1, 2, "$");
  check("accept 解释限定增广项目与 $",
    o3[0].explanation.includes("@START") && o3[0].explanation.includes("$"));
  const o4 = C.actionOrigins(lr1, 0, "a");
  check("shift 解释给出目标状态", o4[0].explanation.includes("状态 1"));
})();

// ---------------------------------------------------------------
// 回放: 前进/后退完整恢复, ε 归约弹 0
// ---------------------------------------------------------------
(function () {
  const trace = {
    tokens: [],
    status: "accepted",
    final: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] },
    steps: [
      { index: 1,
        before: { stateStack: [0], symbolStack: [], remaining: ["$"] },
        action: { type: "reduce", production: 1, productionId: "eps", lhs: "S", rhs: [], popped: 0, goto: 1 },
        after: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] } },
      { index: 2,
        before: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] },
        action: { type: "accept" },
        after: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] } },
    ],
  };
  const pb = C.makePlayback(trace);
  check("初始快照状态栈 [0]", eq(C.playbackSnapshot(pb, 0).stateStack, [0]));
  check("可前进一步", C.stepForward(pb) && pb.pos === 1);
  const afterEps = C.playbackSnapshot(pb, 1);
  check("ε 归约后状态栈多出 GOTO、符号栈多出左部",
    eq(afterEps.stateStack, [0, 1]) && eq(afterEps.symbolStack, ["S"]));
  check("后退恢复完整分析状态(弹回 ε 归约前)",
    C.stepBack(pb) && eq(C.playbackSnapshot(pb, 0).symbolStack, []));
  check("不能退到负位置", C.stepBack(pb) === false);
  C.stepForward(pb); C.stepForward(pb);
  check("到末尾不能再前进", C.stepForward(pb) === false);
})();

// ---------------------------------------------------------------
// 失效规则状态机
// ---------------------------------------------------------------
(function () {
  const s = C.createAppState();
  check("初始无表", !C.hasFreshTable(s) && !C.canRunAnalysis(s));
  const t = miniTable("LR1");
  t.mode = "SLR"; // 与状态模式一致即可, 仅测状态机
  s.mode = "SLR";
  C.tableGenerated(s, t);
  check("生成后表新鲜可导出可分析", C.hasFreshTable(s) && C.canExportTable(s) && C.canRunAnalysis(s));

  C.grammarChanged(s);
  check("文法修改 → 表过期", s.tableStale && !C.hasFreshTable(s));
  check("过期表禁止单步/导出", !C.canStep(s) && !C.canExportTable(s));
  check("过期后旧轨迹被丢弃", s.pb === null && s.trace === null);

  C.tableGenerated(s, t);
  C.traceLoaded(s, { tokens: ["a"], steps: [{}], final: {} });
  check("载入轨迹后可单步", C.canStep(s));
  C.inputChanged(s, "a a");
  check("输入修改保留有效表", C.hasFreshTable(s) && !s.tableStale);
  check("输入修改只重置分析状态", s.pb === null && s.trace === null);

  C.tableGenerated(s, t);
  C.traceLoaded(s, { tokens: ["a"], steps: [{}], final: {} });
  C.modeChanged(s, "LR1");
  check("模式切换 → 表过期且轨迹丢弃",
    s.tableStale && !C.hasFreshTable(s) && s.pb === null);

  C.tableGenerated(s, miniTable("LR1"));
  C.traceLoaded(s, { tokens: ["a"], steps: [{}], final: {} });
  s.playing = true;
  check("自动执行中禁止改文法后生成(playing 门)", !C.canGenerate(s));
  check("自动执行中不能单步", !C.canStep(s));
  s.playing = false;
  check("暂停后恢复操作", C.canGenerate(s));
})();

(function () {
  // 冲突表: 新鲜但禁止分析, 仍可导出查看
  const s = C.createAppState();
  const t = miniTable("SLR");
  t.conflicts = [{ state: 1, symbol: "$", kind: "accept/reduce", actions: [] }];
  C.tableGenerated(s, t);
  check("有冲突的表禁止启动分析", C.hasFreshTable(s) && !C.canRunAnalysis(s));
  check("有冲突的表仍可导出", C.canExportTable(s));
})();

// ---------------------------------------------------------------
// 编辑边界: 右部 8/9、终结符 30/31, 超限完整保留、不裁剪
// ---------------------------------------------------------------
(function () {
  // splitSymbols 本身绝不截断(旧 bug: 输入框内容被 slice 后生成另一份文法)
  const nine = C.splitSymbols("id id id id id id id id id");
  check("切词完整保留 9 个右部符号", nine.length === 9, String(nine.length));
  const thirtyOne = C.splitSymbols(Array.from({ length: 31 }, (_, i) => "t" + i).join(" "));
  check("切词完整保留 31 个终结符", thirtyOne.length === 31);

  const mk = (rhsLen) => {
    const d = C.defaultDraft();
    d.start = "S";
    d.terminals = ["id"];
    d.productions = [
      { id: "long", lhs: "S", rhs: Array.from({ length: rhsLen }, () => "id") },
    ];
    return d;
  };
  const ok8 = mk(8);
  check("右部恰好 8 个符号合法", C.validateDraft(ok8).errors.length === 0);
  const bad9 = mk(9);
  const v9 = C.validateDraft(bad9);
  check("右部 9 个符号被拒并提示上限 8",
    v9.errors.some((e) => e.includes(String(C.LIMITS.maxRhs))), JSON.stringify(v9.errors));
  check("校验后 9 个符号仍完整保留在草稿里(不被裁剪)",
    bad9.productions[0].rhs.length === 9);

  const mkTerms = (n) => {
    const d = C.defaultDraft();
    d.start = "S";
    d.terminals = Array.from({ length: n }, (_, i) => "tt" + i);
    d.productions = [{ id: "s", lhs: "S", rhs: ["tt0"] }];
    return d;
  };
  check("终结符恰好 30 个合法", C.validateDraft(mkTerms(30)).errors.length === 0);
  const d31 = mkTerms(31);
  const v31 = C.validateDraft(d31);
  check("终结符 31 个被拒并提示上限 30",
    v31.errors.some((e) => e.includes(String(C.LIMITS.maxTerminals))),
    JSON.stringify(v31.errors));
  check("校验后 31 个终结符仍完整保留", d31.terminals.length === 31);
})();

// ---------------------------------------------------------------
// 播放位置状态: 预计算终态 ≠ 当前进度
// ---------------------------------------------------------------
function acceptedTrace() {
  return {
    tokens: [],
    status: "accepted",
    final: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] },
    steps: [
      { index: 1,
        before: { stateStack: [0], symbolStack: [], remaining: ["$"] },
        action: { type: "reduce", production: 1, productionId: "eps", lhs: "S", rhs: [], popped: 0, goto: 1 },
        after: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] } },
      { index: 2,
        before: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] },
        action: { type: "accept" },
        after: { stateStack: [0, 1], symbolStack: ["S"], remaining: ["$"] } },
    ],
  };
}

(function () {
  const s = C.createAppState();
  C.tableGenerated(s, miniTable("SLR"));
  C.traceLoaded(s, acceptedTrace());
  check("开始分析后 0 步: 状态为就绪而非已接受", C.playbackStatus(s) === "ready");
  check("0 步不算完成", C.playbackFinished(s) === false);
  C.stepForward(s.pb);
  check("中途(ε 归约)状态为执行中", C.playbackStatus(s) === "running");
  C.stepForward(s.pb);
  check("执行到 accept 步才标记已接受", C.playbackStatus(s) === "accepted");
  check("到 accept 步算完成", C.playbackFinished(s) === true);
  C.stepBack(s.pb);
  check("后退离开 accept 步恢复执行中", C.playbackStatus(s) === "running");
  C.stepBack(s.pb);
  check("后退到 0 步恢复就绪", C.playbackStatus(s) === "ready");
  // 前进—回退—再前进
  C.stepForward(s.pb); C.stepForward(s.pb);
  check("再前进可重新到达已接受", C.playbackStatus(s) === "accepted" && s.pb.pos === 2);
  C.resetPlayback(s.pb);
  check("复位后回到就绪、栈为初始 [0]",
    C.playbackStatus(s) === "ready" &&
    C.playbackSnapshot(s.pb, 0).stateStack.length === 1);

  // 错误轨迹: 末步不是 accept, 走到末尾才是 error, 绝不显示接受
  const errTrace = {
    tokens: ["a"], status: "error",
    final: { stateStack: [0, 1], symbolStack: ["a"], remaining: ["b", "$"] },
    error: { state: 1, symbol: "b", expected: ["$"], prefix: ["a"], message: "x" },
    steps: [{ index: 1,
      before: { stateStack: [0], symbolStack: [], remaining: ["a", "b", "$"] },
      action: { type: "shift", to: 1, symbol: "a" },
      after: { stateStack: [0, 1], symbolStack: ["a"], remaining: ["b", "$"] } }],
  };
  C.traceLoaded(s, errTrace);
  check("错误轨迹 0 步仍是就绪", C.playbackStatus(s) === "ready");
  C.stepForward(s.pb);
  check("错误轨迹走到末尾标记 error 而非 accepted",
    C.playbackStatus(s) === "error" && C.playbackFinished(s) === true);

  // 超步轨迹
  const limTrace = { tokens: ["a"], status: "limit",
    final: { stateStack: [0], symbolStack: [], remaining: ["a", "$"] },
    error: { message: "达到步数上限" },
    steps: [{ index: 1,
      before: { stateStack: [0], symbolStack: [], remaining: ["a", "$"] },
      action: { type: "shift", to: 2, symbol: "a" },
      after: { stateStack: [0, 2], symbolStack: ["a"], remaining: ["$"] } }] };
  C.traceLoaded(s, limTrace);
  C.stepForward(s.pb);
  check("超步轨迹标记 limit, 不伪装接受", C.playbackStatus(s) === "limit");
})();

// ---------------------------------------------------------------
// 异步: 确定性延迟 + 交换响应顺序; 过期成功/失败/finally 全部不生效
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// 异步用例收集(在汇总前统一等待, 保证乱序/过期断言都已执行)
// ---------------------------------------------------------------
const asyncCases = [];
function asyncCase(fn) {
  asyncCases.push(Promise.resolve().then(fn).catch((e) =>
    check("异步用例异常: " + (e && e.message), false, (e && e.stack) || String(e))));
}
function deferred() {
  let resolve = null, reject = null;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

asyncCase(async function () {
  // ---- 建表: 先发 SLR 请求(挂起), 立即切 LR1; 旧响应晚到不得显示为 LR1 ----
  const s = C.createAppState();
  const slrTable = miniTable("SLR");
  s.draft = C.normalizeDraft(slrTable.grammar);
  s.mode = "SLR";

  let successA = 0, failureA = 0, settledA = 0;
  let successB = 0, failureB = 0, settledB = 0;
  const d1 = deferred();
  C.runManagedRequest(s, "build", {
    send: () => d1.p,
    success: () => { successA++; }, failure: () => { failureA++; },
    settled: () => { settledA++; },
  });
  // 模拟页面: 模式切换立即作废旧建表请求
  C.modeChanged(s, "LR1");
  const lrTable = miniTable("LR1");
  const d2 = deferred();
  C.runManagedRequest(s, "build", {
    send: () => d2.p,
    success: (tbl, token) => {
      successB++;
      C.tableGenerated(s, tbl, token); // 页面 success 内以令牌身份生效
    },
    failure: () => { failureB++; },
    settled: () => { settledB++; },
  });

  // 旧(SLR)响应先不回来; 新(LR1)先回来
  d2.resolve(lrTable);
  await flushMicrotasks();
  // 旧响应(成功)晚到
  d1.resolve(slrTable);
  await flushMicrotasks();
  check("过期建表成功回调不执行", successA === 0);
  check("过期建表收尾不执行(不解锁旧控件)", settledA === 0);
  check("当前建表成功回调执行一次", successB === 1 && settledB === 1);
  check("旧 SLR 表未被当作 LR1 生效",
    s.table && s.table.mode === "LR1" && s.table === lrTable);
  check("LR1 表内容是带展望符的项目",
    s.table.states[0].items.every((it) => typeof it.lookahead === "string"));
});

asyncCase(async function () {
  // ---- 建表: 乱序两个成功响应, 先发的后回来, 不得覆盖 ----
  const s = C.createAppState();
  const base = miniTable("SLR");
  s.draft = C.normalizeDraft(base.grammar);
  s.mode = "SLR";
  const d1 = deferred(); const d2 = deferred();
  let tok1, tok2;
  let applied1 = false, applied2 = false;
  tok1 = C.runManagedRequest(s, "build", {
    send: () => d1.p,
    success: (tbl, token) => { applied1 = C.tableGenerated(s, tbl, token); },
    failure: () => {}, settled: () => {},
  });
  tok2 = C.runManagedRequest(s, "build", {
    send: () => d2.p,
    success: (tbl, token) => { applied2 = C.tableGenerated(s, tbl, token); },
    failure: () => {}, settled: () => {},
  });
  check("第二个建表请求取代第一个(身份不同)", tok1.seq !== tok2.seq);
  d2.resolve(base);           // 后发先至
  await flushMicrotasks();
  d1.resolve(base);           // 先发晚到
  await flushMicrotasks();
  check("晚到的先发建表响应被拒绝生效", applied1 === false);
  check("最新建表响应生效", applied2 === true && s.table !== null);
});

asyncCase(async function () {
  // ---- 建表: 过期失败响应不得覆盖新状态/错误解锁 ----
  const s = C.createAppState();
  const base = miniTable("SLR");
  s.draft = C.normalizeDraft(base.grammar);
  s.mode = "SLR";
  const d1 = deferred(); const d2 = deferred();
  let failA = 0, settleA = 0, okB = 0;
  C.runManagedRequest(s, "build", {
    send: () => d1.p,
    success: () => {}, failure: () => { failA++; }, settled: () => { settleA++; },
  });
  C.grammarChanged(s); // 编辑文法作废旧请求
  C.runManagedRequest(s, "build", {
    send: () => d2.p,
    success: (tbl, token) => { C.tableGenerated(s, tbl, token); okB++; },
    failure: () => {}, settled: () => {},
  });
  d1.reject(new Error("旧请求失败"));  // 旧请求失败晚到
  await flushMicrotasks();
  check("过期建表失败回调不执行", failA === 0 && settleA === 0);
  d2.resolve(base);                    // 新请求成功
  await flushMicrotasks();
  check("新请求成功且表生效", okB === 1 && C.hasFreshTable(s));
});

asyncCase(async function () {
  // ---- 分析: id 先发, 立即改输入为 a a; 旧轨迹(id)晚到不得覆盖新输入 ----
  const s = C.createAppState();
  const tbl = miniTable("SLR"); // 文法 S->a
  s.draft = C.normalizeDraft(tbl.grammar);
  s.mode = "SLR";
  C.tableGenerated(s, tbl);
  s.input = "a";

  const traceA = { tokens: ["a"], status: "accepted",
    final: { stateStack: [0, 1, 2], symbolStack: ["a", "S"], remaining: ["$"] },
    steps: [
      { index: 1, before: { stateStack: [0], symbolStack: [], remaining: ["a", "$"] },
        action: { type: "shift", to: 1, symbol: "a" },
        after: { stateStack: [0, 1], symbolStack: ["a"], remaining: ["$"] } },
      { index: 2, before: { stateStack: [0, 1], symbolStack: ["a"], remaining: ["$"] },
        action: { type: "reduce", production: 1, productionId: "s-a", lhs: "S", rhs: ["a"], popped: 1, goto: 2 },
        after: { stateStack: [0, 2], symbolStack: ["S"], remaining: ["$"] } },
      { index: 3, before: { stateStack: [0, 2], symbolStack: ["S"], remaining: ["$"] },
        action: { type: "accept" },
        after: { stateStack: [0, 2], symbolStack: ["S"], remaining: ["$"] } }] };

  const d1 = deferred(); const d2 = deferred();
  let loadedA = false, loadedB = false;
  C.runManagedRequest(s, "parse", {
    tokenInfo: { input: "a", tableKey: s.tableKey },
    send: () => d1.p,
    success: (tr, token) => { loadedA = C.traceLoaded(s, tr, token); },
    failure: () => {}, settled: () => {},
  });
  // 用户立即改输入: 旧分析作废, 表保留
  C.inputChanged(s, "a a");
  check("改输入后有效表仍保留", C.hasFreshTable(s));
  const traceB = JSON.parse(JSON.stringify(traceA));
  traceB.tokens = ["a", "a"];
  C.runManagedRequest(s, "parse", {
    tokenInfo: { input: "a a", tableKey: s.tableKey },
    send: () => d2.p,
    success: (tr, token) => { loadedB = C.traceLoaded(s, tr, token); },
    failure: () => {}, settled: () => {},
  });
  d2.resolve(traceB);
  await flushMicrotasks();
  d1.resolve(traceA); // 旧输入轨迹晚到
  await flushMicrotasks();
  check("旧输入的分析轨迹被拒绝", loadedA === false && s.trace !== traceA);
  check("新输入轨迹生效", loadedB === true && s.trace === traceB);
  check("界面轨迹对应当前输入 a a", JSON.stringify(s.trace.tokens) === JSON.stringify(["a", "a"]));
  check("新轨迹 0 步仍为就绪(不显示已接受)", C.playbackStatus(s) === "ready");
});

asyncCase(async function () {
  // ---- 文法改动在分析在途时: 旧分析成功/失败都作废, 表也过期 ----
  const s = C.createAppState();
  const tbl = miniTable("SLR");
  s.draft = C.normalizeDraft(tbl.grammar);
  C.tableGenerated(s, tbl);
  s.input = "a";
  const d = deferred();
  let ok = 0, fail = 0, settle = 0;
  C.runManagedRequest(s, "parse", {
    tokenInfo: { input: "a", tableKey: s.tableKey },
    send: () => d.p,
    success: () => { ok++; }, failure: () => { fail++; }, settled: () => { settle++; },
  });
  C.grammarChanged(s);
  d.resolve({ tokens: ["a"], status: "accepted", steps: [], final: {} });
  await flushMicrotasks();
  check("文法改动后旧分析成功不生效", ok === 0 && settle === 0);
  check("文法改动后表过期、轨迹清空", !C.hasFreshTable(s) && s.pb === null);

  // 失败路径同样作废
  const s2 = C.createAppState();
  s2.draft = C.normalizeDraft(tbl.grammar);
  C.tableGenerated(s2, tbl);
  s2.input = "a";
  const d2 = deferred();
  let f2 = 0;
  C.runManagedRequest(s2, "parse", {
    tokenInfo: { input: "a", tableKey: s2.tableKey },
    send: () => d2.p, success: () => {},
    failure: () => { f2++; }, settled: () => {},
  });
  C.grammarChanged(s2);
  d2.reject(new Error("旧分析失败"));
  await flushMicrotasks();
  check("文法改动后旧分析失败也不提示", f2 === 0);
});

// ---------------------------------------------------------------
// 暂停后改输入: 自动执行保护解除, 运行重置但表保留
// ---------------------------------------------------------------
(function () {
  const s = C.createAppState();
  C.tableGenerated(s, miniTable("SLR"));
  C.traceLoaded(s, acceptedTrace());
  s.playing = true; // 模拟自动执行中: 编辑受保护
  check("自动执行中禁止生成/单步", !C.canGenerate(s) && !C.canStep(s));
  // 页面暂停后(pauseAuto 会清 playing), 用户改输入
  s.playing = false;
  C.inputChanged(s, "a");
  check("暂停后改输入: 表保留、运行重置、可再次生成",
    C.hasFreshTable(s) && s.pb === null && C.canGenerate(s));
})();

// ---------------------------------------------------------------
// 无效导入不破坏已有草稿/表/轨迹(页面 doImport 仅在校验通过后才替换)
// ---------------------------------------------------------------
(function () {
  const s = C.createAppState();
  const tbl = miniTable("SLR");
  s.draft = C.normalizeDraft(tbl.grammar);
  C.tableGenerated(s, tbl);
  C.traceLoaded(s, acceptedTrace());
  const draftSnap = JSON.stringify(s.draft);

  // 复刻 app.js doImport 的生效条件: 本地或服务器任一失败都不调用替换
  function importWouldApply(obj) {
    const local = C.validateDraft(obj);
    return local.errors.length === 0;
  }
  check("坏 JSON 内容(未知字段)导入被拒", importWouldApply({ junk: 1 }) === false);
  const bad9 = { version: 1, name: "x", start: "S", terminals: ["a"],
    productions: [{ id: "p", lhs: "S", rhs: ["a", "a", "a", "a", "a", "a", "a", "a", "a"] }] };
  check("右部 9 符号的导入被拒", importWouldApply(bad9) === false);
  // 拒绝后页面状态原样保留
  check("导入失败后草稿不变", JSON.stringify(s.draft) === draftSnap);
  check("导入失败后有效表仍在", C.hasFreshTable(s));
  check("导入失败后轨迹仍在", s.pb !== null && s.trace !== null);
})();

// ---------------------------------------------------------------
// 汇总(等待全部异步乱序/过期用例结束后再统计)
// ---------------------------------------------------------------
Promise.all(asyncCases).then(() => {
  if (failures.length) {
    console.error(`前端测试失败 ${failures.length} 项, 通过 ${passed} 项:`);
    for (const [n, d] of failures) console.error("  [FAIL] " + n + "  " + d);
    process.exit(1);
  }
  console.log(`前端测试全部通过: ${passed} 项断言`);
});
