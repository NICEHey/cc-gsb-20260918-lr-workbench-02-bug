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
// 汇总
// ---------------------------------------------------------------
if (failures.length) {
  console.error(`前端测试失败 ${failures.length} 项, 通过 ${passed} 项:`);
  for (const [n, d] of failures) console.error("  [FAIL] " + n + "  " + d);
  process.exit(1);
}
console.log(`前端测试全部通过: ${passed} 项断言`);
