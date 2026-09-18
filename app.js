/* LR 工作台前端主控: 文法编辑 / 表渲染 / 逐符号回放 / 失效规则 / 自动保存。
 * 纯原生 JavaScript, 依赖 core.js 的 LRCore。 */
(function () {
  "use strict";
  const C = window.LRCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "lr-workbench-draft-v1";

  // ---------------------------------------------------------------
  // 全局状态
  // ---------------------------------------------------------------
  const state = C.createAppState();
  let fixtures = [];
  let selectedState = 0;          // 状态族中当前选中的状态
  let selectedCell = null;        // {state, symbol} ACTION 单元格选择
  let activeTab = "states";
  let autoTimer = null;

  // ---------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  async function postJson(url, payload) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await resp.json(); } catch (_) { /* 非 JSON */ }
    if (!resp.ok) throw new Error((data && data.error) || `请求失败: HTTP ${resp.status}`);
    return data;
  }
  function setBanner(node, kind, html) {
    node.className = "banner " + kind;
    node.innerHTML = html;
  }
  function clearBanner(node) { node.className = "banner hidden"; node.innerHTML = ""; }
  function actionText(act) {
    if (act.type === "shift") return `s${act.to}`;
    if (act.type === "reduce") return `r${act.production}`;
    return "acc";
  }
  function actionDescribe(table, act) {
    if (act.type === "shift") return `移进, 转入状态 ${act.to}`;
    if (act.type === "reduce") return "按 " + C.productionText(table, act.production) + " 归约";
    return "接受";
  }
  function splitSymbols(raw) {
    return raw.split(/[\s,，、]+/).filter((s) => s.length > 0);
  }
  /** 终结符排序: 普通终结符按 Unicode 码点, 结束符 $ 固定最后(表格列惯例)。 */
  function terminalOrder(table) {
    return C.cpSorted(table.grammar.terminals).concat([C.END]);
  }

  // ---------------------------------------------------------------
  // 自动保存(仅草稿/模式/输入, 绝不保存表与运行状态)
  // ---------------------------------------------------------------
  function saveDraft() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        draft: state.draft, mode: state.mode, input: state.input,
      }));
    } catch (_) { /* 存储不可用时静默 */ }
  }
  function restoreDraft() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const v = C.validateDraft(obj.draft);
      if (!v.errors.length) {
        state.draft = C.normalizeDraft(obj.draft);
        state.mode = obj.mode === "LR1" ? "LR1" : "SLR";
        state.input = typeof obj.input === "string" ? obj.input : "";
      }
    } catch (_) { /* 损坏的缓存忽略, 使用默认草稿 */ }
  }

  // ---------------------------------------------------------------
  // 失效入口
  // ---------------------------------------------------------------
  function markGrammarEdited() {
    C.grammarChanged(state);
    saveDraft();
    renderStaleness();
    renderRunAvailability();
  }
  function markInputEdited() {
    C.inputChanged(state, $("inputText").value);
    saveDraft();
    clearBanner($("runMessage"));
    renderRunAvailability();
    renderTraceArea();
  }

  // ---------------------------------------------------------------
  // 文法编辑区
  // ---------------------------------------------------------------
  function renderGrammarForm() {
    $("nameInput").value = state.draft.name;
    $("startInput").value = state.draft.start;
    $("terminalsInput").value = state.draft.terminals.join(" ");
    renderProdList();
  }

  function renderProdList() {
    const list = $("prodList");
    list.innerHTML = "";
    state.draft.productions.forEach((p, i) => {
      const row = el("div", "prod-row");
      row.dataset.index = String(i);

      const idIn = el("input", "mono");
      idIn.value = p.id; idIn.placeholder = "唯一 ID";
      idIn.addEventListener("input", () => {
        p.id = idIn.value; markGrammarEdited(); renderMessages();
      });

      const lhsIn = el("input", "mono");
      lhsIn.value = p.lhs; lhsIn.placeholder = "左部";
      lhsIn.addEventListener("input", () => {
        p.lhs = lhsIn.value; markGrammarEdited(); renderMessages();
      });

      const rhsIn = el("input", "mono");
      rhsIn.value = p.rhs.join(" "); rhsIn.placeholder = "留空 = ε";
      rhsIn.title = "右部符号用空白分隔; 留空表示 ε";
      rhsIn.addEventListener("input", () => {
        // 完整保留用户输入(含超限内容), 由校验明确报错; 绝不静默裁剪后按另一份文法计算
        p.rhs = splitSymbols(rhsIn.value);
        markGrammarEdited(); renderMessages();
      });

      const ops = el("div", "prod-ops");
      const up = el("button", null, "↑");
      up.title = "上移"; up.disabled = i === 0;
      up.addEventListener("click", () => moveProd(i, -1));
      const down = el("button", null, "↓");
      down.title = "下移"; down.disabled = i === state.draft.productions.length - 1;
      down.addEventListener("click", () => moveProd(i, 1));
      const del = el("button", null, "删");
      del.title = "删除该产生式";
      del.addEventListener("click", () => deleteProd(i));
      ops.append(up, down, del);

      row.append(idIn, lhsIn, rhsIn, ops);
      list.appendChild(row);
    });
    $("prodCount").textContent =
      `${state.draft.productions.length} / ${C.LIMITS.maxProductions} 条` +
      (state.draft.productions.length >= C.LIMITS.maxProductions ? "（已达上限）" : "");
    renderMessages();
  }

  function moveProd(i, dir) {
    const arr = state.draft.productions;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    markGrammarEdited();
    renderProdList();
  }
  function deleteProd(i) {
    state.draft.productions.splice(i, 1);
    markGrammarEdited();
    renderProdList();
  }
  function addProduction() {
    if (state.draft.productions.length >= C.LIMITS.maxProductions) return;
    state.draft.productions.push({
      id: C.newId(),
      lhs: state.draft.start || "S",
      rhs: [],
    });
    markGrammarEdited();
    renderProdList();
  }

  function renderMessages() {
    const box = $("grammarMessages");
    box.innerHTML = "";
    const wrap = el("div", "msg-list");
    const v = C.validateDraft(state.draft);
    v.errors.forEach((m) => wrap.appendChild(el("div", "msg-err", "✗ " + m)));
    v.warnings.forEach((m) => wrap.appendChild(el("div", "msg-warn", "⚠ " + m)));
    if (v.errors.length || v.warnings.length) box.appendChild(wrap);
    $("generateBtn").disabled = v.errors.length > 0 || state.playing;
    return v;
  }

  function bindGrammarInputs() {
    $("nameInput").addEventListener("input", (e) => {
      state.draft.name = e.target.value; markGrammarEdited();
    });
    $("startInput").addEventListener("input", (e) => {
      state.draft.start = e.target.value; markGrammarEdited(); renderMessages();
    });
    $("terminalsInput").addEventListener("input", (e) => {
      // 同上: 超限输入完整保留并提示, 禁止后台按裁剪后的终结符集合计算
      state.draft.terminals = splitSymbols(e.target.value);
      markGrammarEdited(); renderMessages();
    });
    $("addProdBtn").addEventListener("click", addProduction);
  }

  // ---------------------------------------------------------------
  // 模式切换
  // ---------------------------------------------------------------
  function renderMode() {
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === state.mode);
      b.disabled = state.playing;
    });
  }
  function bindMode() {
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.addEventListener("click", () => {
        if (state.playing || b.dataset.mode === state.mode) return;
        C.modeChanged(state, b.dataset.mode);
        saveDraft();
        renderMode(); renderStaleness(); renderRunAvailability(); renderTraceArea();
      });
    });
  }

  // ---------------------------------------------------------------
  // 样例 / 导入 / 导出
  // ---------------------------------------------------------------
  async function loadFixturesList() {
    try {
      const data = await (await fetch("fixtures/grammars.json")).json();
      fixtures = data.cases || [];
      const sel = $("fixtureSelect");
      sel.innerHTML = "";
      fixtures.forEach((c) => {
        const o = el("option", null, `${c.label}（${c.key}）`);
        o.value = c.key;
        sel.appendChild(o);
      });
    } catch (err) {
      $("loadFixtureBtn").disabled = true;
      $("fixtureSelect").innerHTML = "";
    }
  }

  function applyLoadedGrammar(draft, inputText) {
    // 显式载入样例/导入成功后才替换草稿; 失败路径不会走到这里
    state.draft = C.normalizeDraft(draft);
    C.grammarChanged(state);
    if (typeof inputText === "string") {
      state.input = inputText;
      $("inputText").value = inputText;
    }
    saveDraft();
    renderGrammarForm();
    renderStaleness();
    renderRunAvailability();
    renderTraceArea();
  }

  function bindFixtureAndIo() {
    $("loadFixtureBtn").addEventListener("click", () => {
      const c = fixtures.find((x) => x.key === $("fixtureSelect").value);
      if (!c) return;
      if (state.playing) return;
      applyLoadedGrammar(c.grammar, c.input);
      setBanner($("tableBanner"), "info",
        `已载入样例「${escapeHtml(c.label)}」，点击「生成分析表」构造项目集族。`);
    });

    $("exportDraftBtn").addEventListener("click", () => {
      downloadJson(`grammar-draft-${state.mode.toLowerCase()}.json`, state.draft);
    });

    $("exportTableBtn").addEventListener("click", () => {
      if (!C.canExportTable(state)) return;
      downloadJson(`parse-table-${state.mode.toLowerCase()}.json`, state.table);
    });

    // 模态框
    const modal = $("importModal");
    $("importBtn").addEventListener("click", () => {
      if (state.playing) return;
      $("importText").value = "";
      modal.classList.remove("hidden");
    });
    $("importCancelBtn").addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    $("importFileBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { $("importText").value = String(reader.result || ""); };
      reader.readAsText(f);
    });
    $("importConfirmBtn").addEventListener("click", doImport);
  }

  async function doImport() {
    const raw = $("importText").value.trim();
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      alert("导入失败, JSON 无法解析: " + e.message + "\n当前草稿、有效表与轨迹均保持不变。");
      return;
    }
    // 客户端先查一遍, 再以服务器校验为权威; 任一失败都保留原草稿
    const local = C.validateDraft(obj);
    if (local.errors.length) {
      alert("导入失败, 草稿不符合格式:\n\n- " + local.errors.join("\n- ") +
        "\n\n当前草稿、有效表与轨迹均保持不变。");
      return;
    }
    try {
      const res = await postJson("api/validate", { grammar: obj });
      if (!res.valid) {
        alert("导入失败, 服务器校验未通过:\n\n- " + res.errors.join("\n- ") +
          "\n\n当前草稿、有效表与轨迹均保持不变。");
        return;
      }
      applyLoadedGrammar(res.clean, null);
      $("importModal").classList.add("hidden");
      setBanner($("tableBanner"), "ok", "草稿导入成功, 请重新生成分析表。");
    } catch (err) {
      alert("导入失败: " + err.message + "\n当前草稿、有效表与轨迹均保持不变。");
    }
  }

  // ---------------------------------------------------------------
  // 生成分析表
  // ---------------------------------------------------------------
  function bindGenerate() {
    $("generateBtn").addEventListener("click", generateTable);
  }
  async function generateTable() {
    if (!C.canGenerate(state)) return;
    const btn = $("generateBtn");
    btn.disabled = true; btn.textContent = "生成中…";
    clearBanner($("tableBanner"));
    try {
      const table = await postJson("api/build", { grammar: state.draft, mode: state.mode });
      C.tableGenerated(state, table);
      selectedState = 0;
      selectedCell = null;
      renderTableArea();
      renderStaleness();
      renderRunAvailability();
      renderTraceArea();
      const nConf = table.conflicts.length;
      if (nConf) {
        const kinds = C.conflictSummary(table);
        setBanner($("tableBanner"), "err",
          `⚠ 分析表构造完成但存在 <b>${nConf}</b> 个冲突单元格` +
          `（${Object.entries(kinds).map(([k, v]) => `${k} ×${v}`).join("，")}）。` +
          `所有候选动作均已保留, 可查看与导出, 但<b>禁止启动输入分析</b>。`);
      } else if (table.warnings && table.warnings.length) {
        setBanner($("tableBanner"), "warn",
          "分析表已生成, 无冲突。文法提示: " +
          table.warnings.map(escapeHtml).join("；"));
      } else {
        setBanner($("tableBanner"), "ok",
          `分析表已生成: ${state.mode} · ${table.states.length} 个状态 · 无冲突, 可以启动分析。`);
      }
    } catch (err) {
      setBanner($("tableBanner"), "err",
        "生成失败: " + escapeHtml(err.message) +
        "<br>未产生新的分析表, 已有内容(若存在)保持不变。");
    } finally {
      btn.textContent = "生成分析表";
      renderMessages();
    }
  }

  // ---------------------------------------------------------------
  // 过期 / 控件可用性
  // ---------------------------------------------------------------
  function renderStaleness() {
    const fresh = C.hasFreshTable(state);
    const badge = $("staleBadge");
    const content = $("tableContent");
    if (state.table && state.tableStale) {
      badge.textContent = "表已过期 · 需重新生成";
      badge.className = "badge badge-stale";
      content.classList.add("stale-view");
      // 文法/模式再次修改时, 旧的冲突或失败提示也应让位于"旧表"提示
      setBanner($("tableBanner"), "warn",
        "文法或分析模式已修改：当前显示的是<b>旧表</b>，仅可查看；" +
        "单步、自动执行与导出均已锁定，请重新生成。");
    } else if (!state.table) {
      badge.textContent = "未生成";
      badge.className = "badge badge-muted";
      content.classList.remove("stale-view");
      clearBanner($("tableBanner"));
    } else {
      badge.textContent = state.mode + " 表有效";
      badge.className = "badge badge-ok";
      content.classList.remove("stale-view");
    }
    $("exportTableBtn").disabled = !fresh;
    // 自动执行中禁改文法和输入
    const grammarDisabled = state.playing;
    ["nameInput", "startInput", "terminalsInput", "addProdBtn",
      "loadFixtureBtn", "importBtn", "fixtureSelect"].forEach((id) => {
        const n = $(id); if (n) n.disabled = grammarDisabled;
      });
    $("prodList").querySelectorAll("button,input").forEach((n) => {
      n.disabled = grammarDisabled;
    });
    $("generateBtn").disabled =
      grammarDisabled || C.validateDraft(state.draft).errors.length > 0;
    renderMode();
  }

  // ---------------------------------------------------------------
  // 表区: tabs / 状态族 / 表格 / 属性 / 冲突
  // ---------------------------------------------------------------
  function bindTabs() {
    $("viewTabs").addEventListener("click", (e) => {
      const b = e.target.closest(".tab");
      if (!b) return;
      activeTab = b.dataset.tab;
      document.querySelectorAll(".tab").forEach((x) =>
        x.classList.toggle("active", x === b));
      ["states", "table", "attrs", "conflicts"].forEach((t) =>
        $("pane-" + t).classList.toggle("hidden", t !== activeTab));
      renderTableHighlights();
    });
  }

  function renderTableArea() {
    const t = state.table;
    if (!t) {
      $("emptyTable").classList.remove("hidden");
      $("tableContent").classList.add("hidden");
      return;
    }
    $("emptyTable").classList.add("hidden");
    $("tableContent").classList.remove("hidden");
    $("conflictCount").textContent = `(${t.conflicts.length})`;
    renderStateNav();
    renderStateDetail();
    renderParseTable();
    renderAttrs();
    renderConflicts();
    renderTableHighlights();
  }

  function conflictStates() {
    const s = new Set();
    state.table.conflicts.forEach((c) => s.add(c.state));
    return s;
  }

  function renderStateNav() {
    const nav = $("stateNav");
    nav.innerHTML = "";
    const filter = $("stateFilter").value.trim().toLowerCase();
    const confStates = conflictStates();
    state.table.states.forEach((st) => {
      const groups = C.mergeItems(state.table, st.id);
      const text = groups.map((g) => {
        const p = C.productionOf(state.table, g.production);
        return p.lhs;
      }).join(" ");
      if (filter) {
        const hay = (`${st.id} ${text} ${Object.keys(st.transitions).join(" ")}`).toLowerCase();
        if (!hay.includes(filter)) return;
      }
      const pill = el("div", "state-pill");
      if (st.id === selectedState) pill.classList.add("active");
      if (confStates.has(st.id)) pill.classList.add("has-conflict");
      const left = el("span", null, `状态 ${st.id}`);
      const mini = el("span", "mini", `${st.items.length} 项目 · ${Object.keys(st.transitions).length} 转移`);
      pill.append(left, mini);
      pill.addEventListener("click", () => {
        selectedState = st.id;
        activeTab = "states";
        syncTabButtons();
        renderStateNav(); renderStateDetail(); renderTableHighlights();
      });
      nav.appendChild(pill);
    });
  }

  function syncTabButtons() {
    document.querySelectorAll(".tab").forEach((x) =>
      x.classList.toggle("active", x.dataset.tab === activeTab));
    ["states", "table", "attrs", "conflicts"].forEach((t) =>
      $("pane-" + t).classList.toggle("hidden", t !== activeTab));
  }

  function itemHtml(table, g) {
    const p = C.productionOf(table, g.production);
    const rhs = p.rhs;
    let core = "";
    for (let i = 0; i <= rhs.length; i++) {
      if (i === g.dot) core += '<span class="dotmark">●</span> ';
      if (i < rhs.length) {
        core += escapeHtml(rhs[i] === "" ? "ε" : rhs[i]) + " ";
      }
    }
    if (rhs.length === 0 && g.dot === 0) {
      core = '<span class="dotmark">●</span> <span class="eps-mark">ε</span>';
    }
    const head = `<span class="itm">[${g.production}] ${escapeHtml(p.lhs)} → ${core}</span>`;
    if (table.mode === "LR1") {
      const las = g.lookaheadList.map(escapeHtml).join(", ");
      return `${head}<span class="la">  , {${las}}</span>` +
        (g.lookaheadList.length > 1 ? ` <span class="hint">(合并 ${g.lookaheadList.length} 个展望符, 导出仍逐项保留)</span>` : "");
    }
    return head;
  }

  function renderStateDetail() {
    const t = state.table;
    const box = $("stateDetail");
    box.innerHTML = "";
    const st = t.states[selectedState];
    if (!st) return;
    const confHere = t.conflicts.filter((c) => c.state === st.id);

    const title = el("div", "state-title");
    title.appendChild(el("h3", null, `状态 I${st.id}`));
    if (st.id === 0) title.appendChild(el("span", "badge badge-info", "初始状态"));
    confHere.forEach((c) => {
      const tag = el("span", "badge badge-err", `${c.kind} @ ${c.symbol}`);
      tag.style.cursor = "pointer";
      tag.title = "在 ACTION 表中查看";
      tag.addEventListener("click", () => focusCell(st.id, c.symbol));
      title.appendChild(tag);
    });
    box.appendChild(title);

    const groups = C.mergeItems(t, st.id);
    const list = el("div", "item-list");
    groups.forEach((g) => {
      const d = el("div", "item-group");
      d.innerHTML = itemHtml(t, g);
      list.appendChild(d);
    });
    box.appendChild(list);
    const note = el("p", "hint",
      t.mode === "LR1"
        ? `共 ${st.items.length} 个 LR(1) 项目（同一核心的展望符已合并显示；完整项目见导出 JSON）。`
        : `共 ${st.items.length} 个 LR(0) 项目；归约列由 FOLLOW 集合决定。`);
    box.appendChild(note);

    const syms = Object.keys(st.transitions);
    if (syms.length) {
      box.appendChild(el("h4", null, "转移（点击跳转目标状态；待转移符号按 Unicode 码点排序）"));
      const chips = el("div", "trans-list");
      syms.forEach((s) => {
        const isNt = !t.grammar.terminals.includes(s);
        const chip = el("button", "trans-chip" + (isNt ? " nt" : ""));
        chip.innerHTML = `${escapeHtml(s)}<span class="arrow">→</span>${st.transitions[s]}`;
        chip.addEventListener("click", () => {
          selectedState = st.transitions[s];
          renderStateNav(); renderStateDetail();
        });
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }
    renderInspectorForState();
  }

  function renderParseTable() {
    const t = state.table;
    const tbl = $("parseTable");
    tbl.innerHTML = "";
    const terms = terminalOrder(t);
    const nts = C.cpSorted(Object.keys(t.follow));

    const thead = el("thead");
    const hr = el("tr");
    hr.appendChild(el("th", null, "状态Ｘ符号"));
    terms.forEach((x) => {
      const th = el("th", x === "$" ? "end-col" : null, x);
      hr.appendChild(th);
    });
    nts.forEach((x, i) => {
      const th = el("th", i === 0 ? "goto-sep" : null, x);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tbody = el("tbody");
    t.states.forEach((st) => {
      const tr = el("tr");
      tr.dataset.state = String(st.id);
      tr.appendChild(el("th", null, String(st.id)));
      terms.forEach((sym) => {
        const td = el("td");
        td.dataset.state = String(st.id);
        td.dataset.symbol = sym;
        const acts = st.action[sym];
        if (!acts) {
          td.className = "cell-empty";
          td.textContent = "·";
        } else {
          acts.forEach((a) => {
            const span = el("span", "cell-act act-" + a.type, actionText(a));
            td.appendChild(span);
          });
          if (acts.length > 1) td.classList.add("cell-conflict");
          if (acts.length === 1 && acts[0].type === "accept") td.classList.add("cell-accept");
        }
        td.addEventListener("click", () => {
          if (!acts) return;
          focusCell(st.id, sym);
        });
        tr.appendChild(td);
      });
      nts.forEach((nt, i) => {
        const td = el("td", i === 0 ? "goto-sep-cell" : null);
        const dst = st.goto[nt];
        if (dst === undefined) {
          td.classList.add("cell-empty"); td.textContent = "·";
        } else {
          td.textContent = String(dst);
          td.style.cursor = "pointer";
          td.title = `GOTO[${st.id}, ${nt}] = ${dst}，点击查看目标状态`;
          td.addEventListener("click", () => {
            selectedState = dst;
            activeTab = "states";
            syncTabButtons();
            renderStateNav(); renderStateDetail(); renderTableHighlights();
          });
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
  }

  function focusCell(sid, sym) {
    selectedCell = { state: sid, symbol: sym };
    selectedState = sid;
    activeTab = "table";
    syncTabButtons();
    renderTableArea();
    renderInspectorForCell(sid, sym);
  }

  function renderAttrs() {
    const t = state.table;
    const box = $("attrsView");
    box.innerHTML = "";

    const nul = el("div", "attr-block");
    nul.innerHTML = `<h4>nullable（可空非终结符）</h4>`;
    const nt = el("table");
    nt.innerHTML = `<tr><th>集合</th><td>${t.nullable.length
      ? t.nullable.map((x) => `<span class="set-null mono">${escapeHtml(x)}</span>`).join("　")
      : '<span class="hint">（无）</span>'}</td></tr>`;
    nul.appendChild(nt);
    box.appendChild(nul);

    const fb = el("div", "attr-block");
    fb.innerHTML = `<h4>FIRST / FOLLOW（数组按 Unicode 码点排序；空串记 ε，结束符记 $）</h4>`;
    const tb = el("table");
    C.cpSorted(Object.keys(t.first)).forEach((a) => {
      const tr = el("tr");
      tr.innerHTML =
        `<th class="mono">${escapeHtml(a)}</th>` +
        `<td><b>FIRST</b> = {${t.first[a].map(escapeHtml).join(", ")}}<br>` +
        `<b>FOLLOW</b> = {${t.follow[a].map(escapeHtml).join(", ")}}</td>`;
      tb.appendChild(tr);
    });
    fb.appendChild(tb);
    box.appendChild(fb);

    const pb = el("div", "attr-block");
    pb.innerHTML = `<h4>产生式编号（0 为自动加入的增广产生式，不写回草稿）</h4>`;
    const pt = el("table");
    t.grammar.productions.forEach((p, i) => {
      const tr = el("tr");
      tr.innerHTML = `<th class="mono">${i + 1}</th><td class="mono">${escapeHtml(p.lhs)} → ${
        p.rhs.length ? p.rhs.map(escapeHtml).join(" ") : "<span class='eps-mark'>ε</span>"
      } <span class="hint">(${escapeHtml(p.id)})</span></td>`;
      pt.appendChild(tr);
    });
    pb.appendChild(pt);
    box.appendChild(pb);
  }

  function renderConflicts() {
    const t = state.table;
    const box = $("conflictsView");
    box.innerHTML = "";
    if (!t.conflicts.length) {
      box.appendChild(el("p", "hint", "该分析表没有冲突：任何 ACTION 单元格都至多一个候选动作。"));
      return;
    }
    t.conflicts.forEach((c) => {
      const card = el("div", "conflict-card");
      const kindTag = `<span class="kind-tag kind-${c.kind}">${c.kind}</span>`;
      card.innerHTML = `<h4>状态 ${c.state} · 终结符 <span class="mono">${escapeHtml(c.symbol)}</span>${kindTag}</h4>`;
      const ul = el("div");
      c.actions.forEach((a) => {
        const line = el("div", "act", "• " + actionDescribe(t, a));
        ul.appendChild(line);
      });
      card.appendChild(ul);
      card.addEventListener("click", () => focusCell(c.state, c.symbol));
      box.appendChild(card);
    });
  }

  // ---------------------------------------------------------------
  // 检查器
  // ---------------------------------------------------------------
  function originItemHtml(table, it) {
    const g = { production: it.production, dot: it.dot,
      lookaheadList: it.lookahead !== undefined ? [it.lookahead] : [] };
    return itemHtml(table, g);
  }

  function renderInspectorForCell(sid, sym) {
    const t = state.table;
    const body = $("inspectorBody");
    body.innerHTML = "";
    const origins = C.actionOrigins(t, sid, sym);
    const confs = t.conflicts.filter((c) => c.state === sid && c.symbol === sym);
    body.appendChild(el("p", null, `ACTION[${sid}, ${sym}] —— ${origins.length} 个候选动作`));
    if (confs.length) {
      confs.forEach((c) => body.appendChild(el("div", "msg-err",
        `冲突类型: ${c.kind}（不按优先级或默认移进掩盖）`)));
    }
    origins.forEach((o) => {
      const div = el("div", "origin" + (confs.length ? " conflict" : ""));
      div.appendChild(el("div", "act-line",
        (o.action.type === "shift" ? "移进 " : o.action.type === "reduce" ? "归约 " : "接受 ") +
        actionText(o.action)));
      o.items.forEach((it) => {
        const d = el("div");
        d.innerHTML = originItemHtml(t, it);
        div.appendChild(d);
      });
      div.appendChild(el("div", "why", "依据: " + o.explanation));
      body.appendChild(div);
    });
  }

  function renderInspectorForState() {
    if (!selectedCell || selectedCell.state !== selectedState) {
      if (activeTab === "states") {
        const body = $("inspectorBody");
        body.innerHTML = "";
        body.appendChild(el("p", null, `状态 I${selectedState} 概览`));
        const t = state.table;
        const st = t.states[selectedState];
        body.appendChild(el("p", "hint",
          `项目 ${st.items.length} 个，转移符号 ${Object.keys(st.transitions).length} 个。` +
          `点击 ACTION 表中的单元格可查看每个动作对应的项目与判定依据。`));
        const terms = Object.keys(st.action).sort();
        if (terms.length) {
          body.appendChild(el("div", "act-line", "本状态有 ACTION 表项的终结符"));
          terms.forEach((sym) => {
            const chip = el("button", "trans-chip");
            chip.textContent = `${sym} : ${st.action[sym].map(actionText).join(" / ")}`;
            chip.addEventListener("click", () => focusCell(selectedState, sym));
            body.appendChild(chip);
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // 回放时的跨区高亮(查表位置 = 栈顶状态 × 当前输入符号)
  // ---------------------------------------------------------------
  function currentLookup() {
    if (!state.pb) return null;
    const snap = C.playbackSnapshot(state.pb, state.pb.pos);
    return {
      state: snap.stateStack[snap.stateStack.length - 1],
      symbol: snap.remaining[0],
    };
  }
  function renderTableHighlights() {
    if (!state.table) return;
    const look = state.pb ? currentLookup() : null;
    document.querySelectorAll("#parseTable td").forEach((td) => {
      td.classList.remove("cell-current");
    });
    document.querySelectorAll("#parseTable tr").forEach((tr) =>
      tr.classList.remove("row-current"));
    document.querySelectorAll(".state-pill").forEach((p) =>
      p.classList.remove("lookup"));
    if (!look) return;
    const tr = document.querySelector(`#parseTable tr[data-state="${look.state}"]`);
    if (tr) tr.classList.add("row-current");
    const td = document.querySelector(
      `#parseTable td[data-state="${look.state}"][data-symbol="${CSS.escape(look.symbol)}"]`);
    if (td) td.classList.add("cell-current");
    // 状态导航中标记栈顶状态
    document.querySelectorAll(".state-pill").forEach((p) => {
      if (p.querySelector("span") && p.firstChild &&
          p.firstChild.textContent === `状态 ${look.state}`) p.classList.add("lookup");
    });
    if (selectedCell && selectedCell.state === look.state &&
        selectedCell.symbol === look.symbol) {
      renderInspectorForCell(look.state, look.symbol);
    }
  }

  // ---------------------------------------------------------------
  // 执行区
  // ---------------------------------------------------------------
  function bindRunControls() {
    $("inputText").addEventListener("input", markInputEdited);
    $("startBtn").addEventListener("click", startAnalysis);
    $("stepBtn").addEventListener("click", () => {
      if (C.stepForward(state.pb)) renderPlayback();
    });
    $("backBtn").addEventListener("click", () => {
      if (C.stepBack(state.pb)) renderPlayback();
    });
    $("resetBtn").addEventListener("click", () => stopAndReset());
    $("autoBtn").addEventListener("click", startAuto);
    $("pauseBtn").addEventListener("click", pauseAuto);
    $("stateFilter").addEventListener("input", renderStateNav);
  }

  function renderRunAvailability() {
    const fresh = C.hasFreshTable(state);
    const noConflict = fresh && state.table.conflicts.length === 0;
    const playing = state.playing;
    const hasPb = !!state.pb;
    const atEnd = hasPb && C.playbackAtEnd(state.pb);

    $("inputText").disabled = playing;
    $("speedSelect").disabled = playing || !hasPb;
    $("startBtn").disabled = !noConflict || playing;
    $("stepBtn").disabled = !hasPb || playing || atEnd;
    $("backBtn").disabled = !hasPb || playing || state.pb.pos === 0;
    $("autoBtn").classList.toggle("hidden", playing);
    $("pauseBtn").classList.toggle("hidden", !playing);
    $("autoBtn").disabled = !hasPb || atEnd;
    $("resetBtn").disabled = !hasPb;

    const status = $("runStatus");
    if (!fresh) {
      status.textContent = "表未生成/已过期";
      status.className = "badge badge-stale";
    } else if (!noConflict) {
      status.textContent = `表有 ${state.table.conflicts.length} 个冲突 · 禁止分析`;
      status.className = "badge badge-err";
    } else if (playing) {
      status.textContent = "自动执行中…";
      status.className = "badge badge-info";
    } else if (hasPb) {
      const st = state.trace.status;
      status.textContent = { accepted: "已接受", error: "出错", limit: "超步终止" }[st] || "就绪";
      status.className = "badge " +
        (st === "accepted" ? "badge-ok" : st === "error" ? "badge-err" : "badge-stale");
    } else {
      status.textContent = "表无冲突 · 可开始";
      status.className = "badge badge-ok";
    }
  }

  function renderTraceArea() {
    if (!state.pb) {
      $("traceEmpty").classList.remove("hidden");
      $("traceContent").classList.add("hidden");
      return;
    }
    $("traceEmpty").classList.add("hidden");
    $("traceContent").classList.remove("hidden");
    renderPlayback();
  }

  async function startAnalysis() {
    if (!C.canRunAnalysis(state) || state.playing) return;
    clearBanner($("runMessage"));
    $("startBtn").disabled = true;
    try {
      const result = await postJson("api/parse", {
        grammar: state.draft, mode: state.mode, input: state.input,
      });
      // 以返回结果为准; 未知符号会在服务器开始前报错(走 catch), 不会到这里
      C.traceLoaded(state, result);
      renderRunAvailability();
      renderTraceArea();
      renderTableHighlights();
      if (result.status === "error") showTraceEndMessage(result);
    } catch (err) {
      setBanner($("runMessage"), "err", "无法开始分析: " + escapeHtml(err.message));
    } finally {
      renderRunAvailability();
    }
  }

  function showTraceEndMessage(result) {
    const e = result.error;
    if (result.status === "error") {
      setBanner($("runMessage"), "err",
        `✗ 在状态 <b>${e.state}</b> 遇到终结符 <b class="mono">${escapeHtml(e.symbol)}</b> 时缺失 ACTION。` +
        (e.expected.length
          ? `当前状态可以接受的终结符: ${e.expected.map(escapeHtml).join("、")}。`
          : "当前状态不接受任何终结符。") +
        (e.prefix.length
          ? `<br>成功前缀（已匹配）: <span class="mono">${e.prefix.map(escapeHtml).join(" ")}</span>`
          : "<br>没有可匹配的成功前缀。"));
    } else if (result.status === "limit") {
      setBanner($("runMessage"), "err", "✗ " + escapeHtml(e.message) + "（未伪装为接受）");
    }
  }

  function stackHtml(symbols, states, isAfter) {
    // 状态与符号并排显示
    const parts = [];
    for (let i = 0; i < states.length; i++) {
      const sym = i === 0 ? "" : (symbols[i - 1] || "");
      parts.push(`<span class="sym">${escapeHtml(sym)}</span>`);
    }
    return parts.join(" ");
  }

  function renderPlayback() {
    const pb = state.pb;
    const trace = state.trace;
    const snap = C.playbackSnapshot(pb, pb.pos);
    const record = C.currentStepRecord(pb);

    // ---- 三栈快照 ----
    const panel = $("snapshotPanel");
    panel.innerHTML = "";

    const stateCol = el("div", "snap-col");
    stateCol.appendChild(el("h5", null, "状态栈（栈顶加粗）"));
    const sb = el("div", "stack-box");
    sb.innerHTML = snap.stateStack.map((s, i) =>
      `<span class="sym ${i === snap.stateStack.length - 1 ? "top-mark" : ""}">${s}</span>`
    ).join(" ");
    stateCol.appendChild(sb);
    panel.appendChild(stateCol);

    const symCol = el("div", "snap-col");
    symCol.appendChild(el("h5", null, "符号栈"));
    const yb = el("div", "stack-box");
    yb.innerHTML = snap.symbolStack.length
      ? snap.symbolStack.map((s) => `<span class="sym">${escapeHtml(s)}</span>`).join(" ")
      : '<span class="hint">（空）</span>';
    symCol.appendChild(yb);
    panel.appendChild(symCol);

    const remCol = el("div", "snap-col remaining-box");
    remCol.appendChild(el("h5", null, "剩余输入（$ 为程序追加）"));
    const rb = el("div", "stack-box");
    const tokens = trace.tokens || [];
    rb.innerHTML = snap.remaining.map((tok, i) => {
      if (i === 0) return `<span class="tok current">${escapeHtml(tok)}</span>`;
      return `<span class="tok">${escapeHtml(tok)}</span>`;
    }).join(" ") + ` <span class="hint">｜原始: ${
      tokens.length ? tokens.map(escapeHtml).join(" ") : "（空输入）"
    }</span>`;
    remCol.appendChild(rb);
    panel.appendChild(remCol);

    const actDiv = el("div", "action-now");
    if (record) {
      const a = record.action;
      let txt = `第 ${record.index} 步: `;
      if (a.type === "shift") {
        txt += `<span class="shift-a">移进 ${escapeHtml(a.symbol)} → 状态 ${a.to}</span>`;
      } else if (a.type === "reduce") {
        txt += `<span class="reduce-a">归约 ${a.production}: ${escapeHtml(a.lhs)} → ${
          a.rhs.length ? a.rhs.map(escapeHtml).join(" ") : "ε"
        }</span>（右部 ${a.rhs.length} 个符号，弹栈 ${a.popped} 项` +
          (a.popped === 0 ? "，即 ε 归约弹 0 项" : "") +
          `，查 GOTO 进入状态 ${a.goto}）`;
      } else {
        txt += `<span class="accept-a">接受（仅增广开始项目完成且当前符号为 $）</span>`;
      }
      actDiv.innerHTML = txt;
    } else {
      actDiv.textContent = "尚未执行任何步骤（点击前进一步 / 自动执行）";
    }
    panel.appendChild(actDiv);

    // ---- 轨迹表 ----
    const tbl = $("traceTable");
    tbl.innerHTML = "";
    const head = el("thead");
    head.innerHTML = "<tr><th>#</th><th>执行前状态栈</th><th>执行前符号栈</th>" +
      "<th>剩余输入</th><th>动作</th><th>执行后状态栈</th><th>执行后符号栈</th></tr>";
    tbl.appendChild(head);
    const body = el("tbody");
    trace.steps.forEach((s) => {
      const tr = el("tr");
      if (s.index === pb.pos) tr.classList.add("step-current");
      else if (s.index < pb.pos) tr.classList.add("step-done");
      const a = s.action;
      let actTxt;
      if (a.type === "shift") actTxt = `移进 ${a.symbol} → s${a.to}`;
      else if (a.type === "reduce") actTxt =
        `归约 r${a.production}（${a.lhs} → ${a.rhs.length ? a.rhs.join(" ") : "ε"}）→ ${a.goto}`;
      else actTxt = "接受";
      tr.innerHTML =
        `<td class="step-no">${s.index}</td>` +
        `<td class="mini-stack">${s.before.stateStack.join(" ")}</td>` +
        `<td class="mini-stack">${s.before.symbolStack.map(escapeHtml).join(" ") || "—"}</td>` +
        `<td class="mini-stack">${s.before.remaining.map(escapeHtml).join(" ")}</td>` +
        `<td class="act-${a.type}">${escapeHtml(actTxt)}</td>` +
        `<td class="mini-stack">${s.after.stateStack.join(" ")}</td>` +
        `<td class="mini-stack">${s.after.symbolStack.map(escapeHtml).join(" ") || "—"}</td>`;
      tr.addEventListener("click", () => {
        if (state.playing) return;
        pb.pos = s.index;
        renderPlayback();
        renderRunAvailability();
        renderTableHighlights();
      });
      body.appendChild(tr);
    });
    tbl.appendChild(body);

    renderRunAvailability();
    renderTableHighlights();

    if (pb.pos === trace.steps.length) showTraceEndMessage(trace);
    else clearBanner($("runMessage"));
  }

  // ---------------------------------------------------------------
  // 自动执行(基于定时器, 不阻塞页面)
  // ---------------------------------------------------------------
  function startAuto() {
    if (!state.pb || state.playing) return;
    if (C.playbackAtEnd(state.pb)) return;
    state.playing = true;
    renderStaleness();
    renderRunAvailability();
    const speed = parseInt($("speedSelect").value, 10) || 300;
    autoTimer = setInterval(() => {
      if (!state.pb) { pauseAuto(); return; }
      const moved = C.stepForward(state.pb);
      renderPlayback();
      if (!moved || C.playbackAtEnd(state.pb)) {
        pauseAuto();
      }
    }, speed);
  }
  function pauseAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    state.playing = false;
    renderStaleness();
    renderRunAvailability();
  }
  function stopAndReset() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    state.playing = false;
    if (state.pb) C.resetPlayback(state.pb);
    clearBanner($("runMessage"));
    renderStaleness();
    renderPlayback();
  }

  // ---------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------
  function init() {
    restoreDraft();
    $("inputText").value = state.input;
    renderGrammarForm();
    renderMode();
    renderStaleness();
    renderRunAvailability();
    bindGrammarInputs();
    bindMode();
    bindFixtureAndIo();
    bindGenerate();
    bindTabs();
    bindRunControls();
    loadFixturesList();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
