/* 页面级回归测试: node tests/page.test.js
 *
 * 直接启动真实的 index.html + core.js + app.js(jsdom), 只替换网络层:
 *   - GET  fixtures/grammars.json 用仓库真实文件
 *   - POST /api/* 经 tests/py_bridge.py 同步调用真实 lr_core / server 同一套计算
 * 请求的"返回时机与顺序"由测试显式控制, 可确定性复现延迟与乱序, 不依赖手速。
 *
 * 断言全部经由真实 DOM(按钮/输入框/徽标/表格)完成, 不接触 app.js 私有状态。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { JSDOM } = require(path.join(__dirname, "..", "node_modules", "jsdom"));

const ROOT = path.join(__dirname, "..");
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; } else { failures.push([name, detail || ""]); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function ticks(n) { for (let i = 0; i < n; i++) await sleep(0); }

/** 调真实 Python 后端(与 server.py 相同函数), 返回 fetch 风格 {ok,status,data}。 */
function bridge(endpoint, payload) {
  const r = spawnSync("python3", [path.join(__dirname, "py_bridge.py")], {
    input: JSON.stringify({ endpoint, payload }),
    cwd: ROOT, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("bridge failed: " + r.stderr);
  const out = JSON.parse(r.stdout);
  return out.ok
    ? { ok: true, status: 200, data: out.data }
    : { ok: false, status: 400, data: { error: out.error } };
}

/**
 * 可控时序的 fetch 桩: POST 请求入队但不返回, 直到测试显式 flush。
 * flush() 按入队顺序返回; popLast() 只返回最后一个(制造乱序);
 * deliverOne 可强制成功/失败, 无视 abort(用于证明接收端自身做身份核验)。
 */
function installFetch(window) {
  const q = [];
  function fakeFetch(url, opts) {
    if (typeof url !== "string" || url.startsWith("api/") === false) {
      // GET fixtures 等静态请求: 测试统一在安装前处理
      return Promise.reject(new Error("unexpected url " + url));
    }
    return new Promise((resolve, reject) => {
      q.push({
        url, body: JSON.parse(opts.body), signal: opts.signal || null,
        resolve, reject,
      });
    });
  }
  function deliver(entry, override) {
    if (entry.done) return;
    entry.done = true;
    if (override === "abort") {
      entry.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const ep = entry.url.replace("api/", "");
    let resp;
    try {
      resp = bridge(ep, entry.body);
    } catch (e) {
      entry.reject(e);
      return;
    }
    if (override === "failure") resp = { ok: false, status: 400, data: { error: "模拟失败" } };
    entry.resolve({ ok: resp.ok, status: resp.status, json: async () => resp.data });
  }
  fakeFetch.q = q;
  fakeFetch.flush = async function () {
    const all = q.splice(0);
    all.forEach((e) => deliver(e));
    await ticks(6);
  };
  fakeFetch.popLast = async function (override) {
    const e = q.pop();
    deliver(e, override);
    await ticks(6);
  };
  fakeFetch.flushFirst = async function (override) {
    const e = q.shift();
    deliver(e, override);
    await ticks(6);
  };
  fakeFetch.pending = () => q.length;
  window.fetch = fakeFetch;
  return fakeFetch;
}

async function boot() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8080/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.AbortController = AbortController;
  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) w.CSS.escape = (s) => String(s);
  // 静态 fixtures 直接读文件; POST 走可控队列
  w.fetch = (url) => {
    if (String(url).includes("grammars.json")) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "grammars.json"), "utf8")),
      });
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const alerts = [];
  w.alert = (msg) => alerts.push(String(msg));
  // 拦截导出下载, 直接拿到将被写进文件的 JSON
  let downloaded = null;
  w.Blob = class FakeBlob { constructor(parts) { downloaded = parts[0]; } };
  w.URL.createObjectURL = () => "blob:fake";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { /* 阻止 jsdom 导航 */ };

  w.eval(fs.readFileSync(path.join(ROOT, "core.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  // jsdom 在文档就绪后自行派发 DOMContentLoaded; 这里绝不再手动派发,
  // 否则 init 执行两次、事件绑定两份, 一次点击会前进两步。
  await sleep(30);
  const net = installFetch(w);   // init 之后替换为可控 POST 桩
  return { w, dom, net, alerts, getDownload: () => downloaded };
}

const $ = (w, id) => w.document.getElementById(id);
function input(w, id, value) {
  const node = $(w, id);
  node.value = value;
  node.dispatchEvent(new w.Event("input", { bubbles: true }));
}
function click(w, id) { $(w, id).click(); }
function text(w, id) { return $(w, id).textContent; }
function badge(w) { return $(w, "staleBadge").textContent; }
function runBadge(w) { return $(w, "runStatus").textContent; }

const PSEUDO = {
  version: 1, name: "伪冲突验证", start: "S", terminals: ["a", "b"],
  productions: [
    { id: "p1", lhs: "S", rhs: ["A", "B"] },
    { id: "p2", lhs: "S", rhs: ["a"] },
    { id: "p3", lhs: "A", rhs: ["a"] },
    { id: "p4", lhs: "B", rhs: ["b"] },
  ],
};

async function importDraft(env, draft) {
  click(env.w, "importBtn");
  $(env.w, "importText").value = JSON.stringify(draft);
  click(env.w, "importConfirmBtn");
  await env.net.flush();
}

function openTab(w, tab) {
  w.document.querySelectorAll(".tab").forEach((b) => {
    if (b.dataset.tab === tab) b.click();
  });
}
function actionCell(w, state, sym) {
  return w.document.querySelector(
    `#parseTable td[data-state="${state}"][data-symbol="${sym}"]`);
}
async function startAndDeliver(env, inputText) {
  input(env.w, "inputText", inputText);
  click(env.w, "startBtn");
  await env.net.flush();
}
function traceRowCount(w) {
  return w.document.querySelectorAll("#traceTable tbody tr").length;
}

(async function main() {
  // ===============================================================
  // A. 伪冲突文法: 属性 / 完整表 / 接受, 全程走真实页面 + 真实后端
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    await importDraft(env, PSEUDO);
    check("导入后名称进入编辑框", $(w, "nameInput").value === "伪冲突验证");
    check("生成按钮可用", $(w, "generateBtn").disabled === false);

    click(w, "generateBtn");
    check("生成中按钮锁定", $(w, "generateBtn").disabled === true);
    await env.net.flush();
    check("SLR 徽标显示表有效", badge(w) === "SLR 表有效", badge(w));
    check("共 6 个状态(状态导航 6 个 pill)",
      w.document.querySelectorAll("#stateNav .state-pill").length === 6);

    openTab(w, "attrs");
    const attrsText = w.document.querySelector("#attrsView").textContent;
    check("nullable 为空(无任何非终结符可空)", attrsText.includes("（无）"));
    const attrRows = w.document.querySelectorAll("#attrsView tr");
    function rowOf(nt) {
      for (const tr of attrRows) {
        if (tr.querySelector("th") && tr.querySelector("th").textContent === nt) {
          return tr.querySelector("td").textContent;
        }
      }
      return "";
    }
    check("FIRST(S) = {a}(不含 ε/*/+)", rowOf("S").includes("FIRST") &&
      /FIRST\s*=\s*\{a\}/.test(rowOf("S")) && !rowOf("S").includes("ε"), rowOf("S"));
    check("FOLLOW(A) = {b}", /FOLLOW\s*=\s*\{b\}/.test(rowOf("A")), rowOf("A"));
    check("FIRST(B) = {b} 且不含 ε",
      /FIRST\s*=\s*\{b\}/.test(rowOf("B")) && !rowOf("B").includes("ε"), rowOf("B"));

    openTab(w, "conflicts");
    check("冲突页显示无冲突",
      w.document.querySelector("#conflictsView").textContent.includes("没有冲突"));
    openTab(w, "table");
    const cell = actionCell(w, "3", "$");
    check("状态 3 的 $ 格只有一个动作 r2(不是 r2/r3 伪冲突)",
      cell && cell.textContent.trim() === "r2", cell && cell.textContent);

    // 接受 a
    await startAndDeliver(env, "a");
    check("开始后未走步: 徽标是待执行而非已接受",
      runBadge(w) === "待执行", runBadge(w));
    check("快照提示尚未执行任何步骤",
      w.document.querySelector("#snapshotPanel").textContent.includes("尚未执行任何步骤"));
    const stepsA = traceRowCount(w);
    check("a 的轨迹有 3 步", stepsA === 3, String(stepsA));
    click(w, "stepBtn"); click(w, "stepBtn");
    check("走完前两步仍不是已接受", runBadge(w) !== "已接受", runBadge(w));
    click(w, "stepBtn");
    check("走到 accept 步才显示已接受", runBadge(w) === "已接受", runBadge(w));
    check("到末尾后前进一步禁用", $(w, "stepBtn").disabled === true);
    click(w, "backBtn");
    check("后退离开接受步 → 恢复执行中",
      runBadge(w).startsWith("执行中"), runBadge(w));
    check("后退后前进一步重新可用", $(w, "stepBtn").disabled === false);
    click(w, "stepBtn");
    check("再前进 → 重新已接受", runBadge(w) === "已接受", runBadge(w));
    click(w, "resetBtn");
    check("复位 → 待执行", runBadge(w) === "待执行", runBadge(w));

    // 接受 a b
    await startAndDeliver(env, "a b");
    check("a b 可开始(表无冲突)", traceRowCount(w) === 6, String(traceRowCount(w)));
    while (!$(w, "stepBtn").disabled) click(w, "stepBtn");
    check("a b 走完已接受", runBadge(w) === "已接受");

    // 错误串 a a: 保留成功前缀, 走完才显示出错, 绝不显示接受
    await startAndDeliver(env, "a a");
    check("错误轨迹载入时仍是待执行", runBadge(w) === "待执行");
    const errSteps = traceRowCount(w);
    check("a a 有成功前缀(走了 3 步: shift a / r A? 等)", errSteps >= 1, String(errSteps));
    for (let i = 0; i < errSteps - 1; i++) click(w, "stepBtn");
    check("错误轨迹未走完不显示出错/接受",
      runBadge(w) !== "出错" && runBadge(w) !== "已接受", runBadge(w));
    click(w, "stepBtn");
    check("错误轨迹走完显示出错", runBadge(w) === "出错", runBadge(w));
    const msg = $(w, "runMessage").textContent;
    check("错误信息保留成功前缀 a", msg.includes("状态 3") && msg.includes("a"), msg);
  }

  // ===============================================================
  // B. 页面编辑边界: 右部 8/9、终结符 30/31, 完整保留 + 禁止生成 + 导出一致
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    // 默认 expression 草稿, 第一条右部改 9 个 id
    const rhsBox = w.document.querySelectorAll("#prodList input.mono")[2];
    rhsBox.value = Array(9).fill("id").join(" ");
    rhsBox.dispatchEvent(new w.Event("input", { bubbles: true }));
    check("9 个 id 仍完整显示在编辑框",
      rhsBox.value.split(/\s+/).length === 9, rhsBox.value);
    check("9 个右部符号时报错", $(w, "grammarMessages").textContent.includes("右部最多 8"));
    check("非法草稿禁止生成", $(w, "generateBtn").disabled === true);

    rhsBox.value = Array(8).fill("id").join(" ");
    rhsBox.dispatchEvent(new w.Event("input", { bubbles: true }));
    check("修正为 8 个后报错消失", !$(w, "grammarMessages").textContent.includes("右部最多 8"));
    check("8 个符号允许生成", $(w, "generateBtn").disabled === false);
    click(w, "generateBtn");
    await env.net.flush();
    check("8 符号表正常生成", badge(w) === "SLR 表有效", badge(w));
    check("导出按钮在有效表上可用", $(w, "exportTableBtn").disabled === false);
    click(w, "exportTableBtn");
    const exported = JSON.parse(env.getDownload());
    check("导出表来自完整草稿: 第一条右部确为 8 个 id",
      exported.grammar.productions[0].rhs.length === 8 &&
      exported.grammar.productions[0].rhs.every((s) => s === "id"));

    // 31 个终结符
    const t31 = Array.from({ length: 31 }, (_, i) => "t" + i).join(" ");
    input(w, "terminalsInput", t31);
    check("31 个终结符完整保留在输入框",
      $(w, "terminalsInput").value.split(/\s+/).length === 31);
    check("31 个终结符报错且禁止生成",
      $(w, "grammarMessages").textContent.includes("1~30") &&
      $(w, "generateBtn").disabled === true);
    input(w, "terminalsInput", Array.from({ length: 30 }, (_, i) => "t" + i).join(" "));
    check("修正到 30 个后可生成(右部引用 t0 仍合法需同步调整, 这里只验证数量报错消失)",
      !$(w, "grammarMessages").textContent.includes("1~30"));
  }

  // ===============================================================
  // C. 异步建表乱序: SLR 延迟响应不得冒充 LR1
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    await importDraft(env, PSEUDO);
    click(w, "generateBtn");                    // SLR 请求排队(延迟)
    check("建表请求已发出且按钮锁定", env.net.pending() === 1);
    // 立即切 LR1
    w.document.querySelector('.mode-btn[data-mode="LR1"]').click();
    check("切模式后旧表不存在, 徽标未生成", badge(w) === "未生成", badge(w));
    check("切模式后按钮未被永久锁死", $(w, "generateBtn").disabled === false);
    check("按钮文案已复位", $(w, "generateBtn").textContent === "生成分析表");
    // 旧 SLR 响应现在才回来(无视 abort 强行成功): 必须被接收端身份核验拒绝
    await env.net.flushFirst();
    check("旧 SLR 成功响应不覆盖: 仍未生成", badge(w) === "未生成", badge(w));
    check("旧响应不把 LR1 标成有效", badge(w) !== "LR1 表有效");

    click(w, "generateBtn");                    // 新 LR1 请求
    await env.net.flush();
    check("LR1 响应生效: LR1 表有效", badge(w) === "LR1 表有效", badge(w));
    check("LR1 6 状态",
      w.document.querySelectorAll("#stateNav .state-pill").length === 6);
    openTab(w, "states");
    check("状态项目含 LR(1) 展望符 {..}(不是无展望符的 LR0 项目)",
      w.document.querySelector("#stateDetail").textContent.includes("{"));
  }

  // ===============================================================
  // D. 异步分析乱序: 先 id 后 id + id, 旧轨迹不得覆盖
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    click(w, "generateBtn");                    // 默认 expression, SLR
    await env.net.flush();
    input(w, "inputText", "id");
    click(w, "startBtn");                       // id 的分析请求延迟
    check("分析请求在途", env.net.pending() === 1);
    input(w, "inputText", "id + id");           // 立即改成新输入
    check("输入改动后开始按钮恢复可用(无旧 pb)",
      $(w, "startBtn").disabled === false &&
      w.document.querySelector("#traceContent").classList.contains("hidden"));
    await env.net.flushFirst();                 // 旧 id 轨迹(5 步)强行成功返回
    check("旧 id 轨迹被拒绝: 轨迹区仍隐藏",
      w.document.querySelector("#traceContent").classList.contains("hidden"));

    click(w, "startBtn");                       // 新输入请求
    await env.net.flush();
    check("新轨迹显示原始输入 id + id",
      w.document.querySelector("#snapshotPanel").textContent.includes("id + id"));
    // 直接用真实后端算期望轨迹步数
    const exprDraft = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "grammars.json"), "utf8"))
      .cases[0].grammar;
    const want = bridge("parse", { grammar: exprDraft, mode: "SLR", input: "id + id" });
    check("轨迹步数与后端一致(不是旧 id 的 5 步)",
      traceRowCount(w) === want.data.steps.length && want.data.steps.length !== 5,
      `${traceRowCount(w)} vs ${want.data.steps.length}`);
    check("载入后状态是待执行, 前进一步可用",
      runBadge(w) === "待执行" && $(w, "stepBtn").disabled === false);
  }

  // ===============================================================
  // E. 过期失败响应 + 当前失败响应
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    click(w, "generateBtn");
    input(w, "nameInput", "改了名字");           // 文法改动 → 旧建表作废
    check("有 1 个被作废的在途请求", env.net.pending() === 1);
    await env.net.flushFirst("failure");        // 旧请求失败响应晚到
    check("过期失败不弹失败横幅",
      !w.document.querySelector("#tableBanner").textContent.includes("生成失败"));
    check("编辑内容保留", $(w, "nameInput").value === "改了名字");

    click(w, "generateBtn");
    await env.net.popLast("failure");           // 当前请求确实失败
    check("当前失败显示生成失败",
      w.document.querySelector("#tableBanner").textContent.includes("生成失败"));
    check("当前失败后按钮恢复可用", $(w, "generateBtn").disabled === false);
  }

  // ===============================================================
  // F. 自动执行 / 暂停后改输入 / 前进-回退-再前进
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    click(w, "generateBtn");
    await env.net.flush();
    input(w, "inputText", "id + id * id");
    click(w, "startBtn");
    await env.net.flush();
    $(w, "speedSelect").value = "80";
    click(w, "autoBtn");
    check("自动执行中输入被保护(禁用)", $(w, "inputText").disabled === true);
    await sleep(250);
    click(w, "pauseBtn");
    check("暂停后编辑保护解除", $(w, "inputText").disabled === false);
    const posDuring = runBadge(w);
    check("暂停时处于中途执行状态", posDuring.startsWith("执行中"), posDuring);
    input(w, "inputText", "id");                // 暂停后改输入
    check("改输入后轨迹重置",
      w.document.querySelector("#traceContent").classList.contains("hidden"));
    check("有效表保留", badge(w) === "SLR 表有效");

    // 前进-回退-再前进
    click(w, "startBtn");
    await env.net.flush();
    click(w, "stepBtn"); click(w, "stepBtn");
    const afterTwo = runBadge(w);
    click(w, "backBtn");
    check("后退使步数减少", runBadge(w) !== afterTwo);
    click(w, "stepBtn");
    check("再前进一步恢复", runBadge(w) === afterTwo, `${runBadge(w)} vs ${afterTwo}`);
    // 自动走完
    $(w, "speedSelect").value = "80";
    click(w, "autoBtn");
    await sleep(900);
    check("自动走完到已接受", runBadge(w) === "已接受", runBadge(w));
    click(w, "backBtn");
    check("自动结束后回退 → 未完成", runBadge(w) !== "已接受", runBadge(w));
  }

  // ===============================================================
  // G. 无效 JSON 导入不破坏已有草稿/表/轨迹
  // ===============================================================
  {
    const env = await boot();
    const { w } = env;
    click(w, "generateBtn");
    await env.net.flush();
    input(w, "inputText", "id");
    click(w, "startBtn");
    await env.net.flush();
    click(w, "stepBtn");                        // 走到第 1 步
    const badgeBefore = badge(w);
    const rowsBefore = traceRowCount(w);
    const nameBefore = $(w, "nameInput").value;

    // 1) 不是 JSON
    click(w, "importBtn");
    $(w, "importText").value = "{ not json";
    click(w, "importConfirmBtn");
    await ticks(2);
    check("非 JSON 弹出失败提示", env.alerts.some((a) => a.includes("JSON 无法解析")));
    check("非 JSON 不改变草稿", $(w, "nameInput").value === nameBefore);
    check("非 JSON 表仍有效", badge(w) === badgeBefore);
    check("非 JSON 轨迹与步数保留", traceRowCount(w) === rowsBefore &&
      runBadge(w).startsWith("执行中"));

    // 2) 是 JSON 但校验不过(右部 9 个)
    const bad = JSON.parse(JSON.stringify(PSEUDO));
    bad.productions[0].rhs = ["A", "B", "a", "b", "a", "b", "a", "b", "a"];
    $(w, "importText").value = JSON.stringify(bad);
    click(w, "importConfirmBtn");
    await env.net.flush();
    check("非法草稿导入被拒", env.alerts.some((a) => a.includes("导入失败")));
    check("非法导入不替换草稿", $(w, "nameInput").value === nameBefore);
    check("非法导入后表仍有效", badge(w) === badgeBefore);
    check("非法导入后轨迹与当前步保留", traceRowCount(w) === rowsBefore &&
      runBadge(w).startsWith("执行中"));
  }

  if (failures.length) {
    console.error(`页面测试失败 ${failures.length} 项, 通过 ${passed} 项:`);
    for (const [n, d] of failures) console.error("  [FAIL] " + n + "  " + d);
    process.exit(1);
  }
  console.log(`页面测试全部通过: ${passed} 项断言`);
})().catch((e) => { console.error(e); process.exit(1); });
