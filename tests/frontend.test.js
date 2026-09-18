/* 前端纯逻辑自测: node tests/frontend.test.js
 * 由 selftest.py 在检测到 node 时自动调用, 也可单独运行。 */
"use strict";

const path = require("path");
const C = require(path.join(__dirname, "..", "core.js"));

let passed = 0;
const failures = [];
const pending = [];  // 异步测试用例
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
// 编辑边界: 超限输入必须完整保留, 由校验拦截而不是被静默裁剪
// ---------------------------------------------------------------
(function () {
  check("分词器与页面使用同一实现",
    JSON.stringify(C.splitSymbolList("a b，c、d, e")) === JSON.stringify(["a", "b", "c", "d", "e"]));

  // 8 个合法, 9 个必须报错(而不是保留前 8 个再当成合法表去算)
  const d8 = C.defaultDraft();
  d8.productions[0].rhs = ["id", "id", "id", "id", "id", "id", "id", "id"];
  check("右部 8 个符号合法", C.validateDraft(d8).errors.length === 0);
  const d9 = C.defaultDraft();
  const nine = ["id", "id", "id", "id", "id", "id", "id", "id", "id"];
  d9.productions[0].rhs = nine;
  const r9 = C.validateDraft(d9);
  check("右部 9 个符号被校验拦截", r9.errors.some((e) => e.includes("右部最多 8")));
  check("草稿里 9 个符号一个不少地保留", JSON.stringify(d9.productions[0].rhs) === JSON.stringify(nine));

  // 30 个终结符合法, 31 个报错且完整保留
  const mk30 = () => {
    const d = C.defaultDraft();
    d.terminals = Array.from({ length: 30 }, (_, i) => "t" + i);
    // 避免与 rhs 未知符号相互干扰: 简单文法
    d.start = "S";
    d.productions = [{ id: "s", lhs: "S", rhs: ["t0"] }];
    return d;
  };
  check("30 个终结符合法", C.validateDraft(mk30()).errors.length === 0);
  const d31 = mk30();
  const thirtyOne = Array.from({ length: 31 }, (_, i) => "t" + i);
  d31.terminals = thirtyOne;
  const r31 = C.validateDraft(d31);
  check("31 个终结符被校验拦截", r31.errors.some((e) => e.includes("1~30")));
  check("31 个终结符完整保留", d31.terminals.length === 31 &&
    JSON.stringify(d31.terminals) === JSON.stringify(thirtyOne));
})();

// ---------------------------------------------------------------
// 当前执行进度 vs 预计算结论: 只有走到最后一步才算接受/出错/超步
// ---------------------------------------------------------------
function traceWith(status, n) {
  const steps = [];
  for (let i = 1; i <= n; i++) {
    steps.push({ index: i,
      before: { stateStack: [0], symbolStack: [], remaining: ["$"] },
      action: i === n && status === "accepted"
        ? { type: "accept" }
        : { type: "shift", to: i, symbol: "id" },
      after: { stateStack: [0, i], symbolStack: ["id"], remaining: ["$"] } });
  }
  return { tokens: status === "accepted" ? [] : ["id"], status,
           steps, final: { stateStack: [], symbolStack: [], remaining: ["$"] } };
}

(function () {
  const pb = C.makePlayback(traceWith("accepted", 5));
  check("刚载入轨迹未走步: 不能是已接受", C.playbackOutcome(pb) === "running");
  C.stepForward(pb);
  check("走到第 1 步仍是执行中", C.playbackOutcome(pb) === "running");
  while (C.stepForward(pb)) { /* 走到末尾 */ }
  check("走到最后一步且结论为接受 → accepted", C.playbackOutcome(pb) === "accepted");
  C.stepBack(pb);
  check("回退离开接受步 → 恢复执行中", C.playbackOutcome(pb) === "running");
  C.stepForward(pb);
  check("再次前进 → 重新接受", C.playbackOutcome(pb) === "accepted");
  C.resetPlayback(pb);
  check("复位 → running", C.playbackOutcome(pb) === "running");

  const pe = C.makePlayback(traceWith("error", 4));
  check("错误轨迹未走完不是出错", C.playbackOutcome(pe) === "running");
  while (C.stepForward(pe)) {}
  check("错误轨迹走完才是 error", C.playbackOutcome(pe) === "error");

  const pl = C.makePlayback(traceWith("limit", 3));
  while (C.stepForward(pl)) {}
  check("超步结论只在末尾出现", C.playbackOutcome(pl) === "limit");
})();

// ---------------------------------------------------------------
// 请求台账: 纪元身份 + abort
// ---------------------------------------------------------------
(function () {
  const m = C.createRequestManager();
  const a = m.start();
  let abortedA = false;
  if (a.signal) a.signal.addEventListener("abort", () => { abortedA = true; });
  check("首个票据是当前请求", m.isCurrent(a.token));
  const b = m.start();
  check("新请求使旧票据失效", !m.isCurrent(a.token) && m.isCurrent(b.token));
  check("开始新请求会 abort 旧请求", abortedA);
  m.invalidate();
  check("invalidate 后所有票据失效", !m.isCurrent(b.token));
})();

function fakeTable(mode, draft) {
  return { version: 1, mode, grammar: JSON.parse(JSON.stringify(draft)),
    nullable: [], first: {}, follow: {},
    states: [{ id: 0, items: [], transitions: {}, action: {}, goto: [] }],
    conflicts: [] };
}

// ---------------------------------------------------------------
// 异步建表: 过期成功/失败、内容不匹配、乱序, 都不得覆盖当前状态
// ---------------------------------------------------------------
pending.push((async function () {
  // 1) SLR 响应延迟, 期间已切到 LR1: 旧成功响应必须 stale
  let s = C.createAppState();
  let m = C.createRequestManager();
  const oldReq = C.requestBuild(s, m, () =>
    new Promise((r) => setTimeout(() => r(fakeTable("SLR", s.draft)), 5)));
  C.modeChanged(s, "LR1");
  m.invalidate();
  const old = await oldReq;
  check("延迟返回的 SLR 成功响应被拒绝", old.status === "stale" && s.table === null);
  const cur = await C.requestBuild(s, m, () => Promise.resolve(fakeTable("LR1", s.draft)));
  check("之后的 LR1 响应正常生效",
    cur.status === "applied" && C.hasFreshTable(s) && s.table.mode === "LR1");

  // 2) 较早请求的失败响应在失效后返回: 静默, 不报错误
  let s2 = C.createAppState(); let m2 = C.createRequestManager();
  const failReq = C.requestBuild(s2, m2, () =>
    new Promise((_, rej) => setTimeout(() => rej(new Error("旧失败")), 5)));
  C.grammarChanged(s2); m2.invalidate();
  const staleFail = await failReq;
  check("过期的失败响应静默", staleFail.status === "stale");

  // 3) 当前请求失败必须正常暴露给调用方
  const nowFail = await C.requestBuild(s2, m2, () => Promise.reject(new Error("真失败")));
  check("当前请求失败被暴露", nowFail.status === "error" && nowFail.error.message === "真失败");

  // 4) 响应内容与当前草稿/模式不符(乱序/错配)即便票据最新也拒绝
  let s3 = C.createAppState(); let m3 = C.createRequestManager();
  const hacked = await C.requestBuild(s3, m3, () => Promise.resolve(fakeTable("LR1", s3.draft)));
  check("模式不符的响应拒绝落库", hacked.status === "stale" && s3.table === null);

  // 5) 确定性乱序: 先发的大响应后到, 后发的小响应先到
  let s4 = C.createAppState(); let m4 = C.createRequestManager();
  const first = C.requestBuild(s4, m4, () =>
    new Promise((r) => setTimeout(() => {
      const t = fakeTable("SLR", s4.draft); t._tag = "first";
      r(t);
    }, 30)));
  // 第一个请求在途, 不能 start 第二个(语义上会 abort 它), 这里直接验证 abort+身份:
  const secondTicket = m4.start();
  check("第二个建表请求使第一个过期", !m4.isCurrent(secondTicket.token - 1));
  const firstResult = await first;
  check("先发出后到达的成功响应不覆盖", firstResult.status === "stale");
}));

// ---------------------------------------------------------------
// 异步分析: 身份含输入; 旧输入的轨迹绝不覆盖新输入
// ---------------------------------------------------------------
pending.push((async function () {
  let s = C.createAppState(); let m = C.createRequestManager();
  C.tableGenerated(s, fakeTable("SLR", s.draft));

  const traceId = { status: "accepted", tokens: ["id"], steps: [1, 2, 3, 4, 5], final: {} };
  const oldParse = C.requestParse(s, m, "id", () =>
    new Promise((r) => setTimeout(() => r(traceId), 5)));
  C.inputChanged(s, "id + id");
  m.invalidate();
  const old = await oldParse;
  check("旧输入 id 的延迟成功轨迹被拒绝", old.status === "stale" && s.pb === null);

  const traceNew = { status: "accepted", tokens: ["id", "+", "id"], steps: [1, 2, 3], final: {} };
  const now = await C.requestParse(s, m, "id + id", () => Promise.resolve(traceNew));
  check("新输入轨迹生效",
    now.status === "applied" && JSON.stringify(s.trace.tokens) === JSON.stringify(["id", "+", "id"]));

  // 文法改动后即便输入字符串相同, 旧分析响应也作废
  let s2 = C.createAppState(); let m2 = C.createRequestManager();
  C.tableGenerated(s2, fakeTable("SLR", s2.draft));
  const p2 = C.requestParse(s2, m2, "id", () =>
    new Promise((r) => setTimeout(() =>
      r({ status: "accepted", tokens: ["id"], steps: [1], final: {} }), 5)));
  C.grammarChanged(s2); m2.invalidate();
  const r2 = await p2;
  check("文法改动后旧分析响应作废", r2.status === "stale" && s2.pb === null);
}));

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
(async function () {
  await Promise.all(pending);
  if (failures.length) {
    console.error(`前端测试失败 ${failures.length} 项, 通过 ${passed} 项:`);
    for (const [n, d] of failures) console.error("  [FAIL] " + n + "  " + d);
    process.exit(1);
  }
  console.log(`前端测试全部通过: ${passed} 项断言`);
})();
