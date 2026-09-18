"""LR 文法分析工作台 —— 纯标准库核心算法。

包含:
  * 草稿校验(严格遵守 fixtures/format.md)
  * nullable / FIRST / FOLLOW 不动点计算
  * SLR(1): LR(0) 项目集族 + FOLLOW 填归约
  * 规范 LR(1): FIRST(beta a) 展望符传播, 完整 LR(1) 项目作状态指纹(不做 LALR 合并)
  * ACTION/GOTO 表, 保留全部去重候选动作与冲突分类
  * 表驱动移进-归约分析(支持 ε 归约、错误定位、2000 步上限)
"""

from __future__ import annotations

import re
from collections import deque
from typing import Any

# ---------------------------------------------------------------------------
# 常量与限制
# ---------------------------------------------------------------------------

VERSION = 1
AUG = "@START"          # 增广非终结符(保留)
END = "$"               # 输入结束符(保留)
EPS = "ε"               # 空串记号(保留, 仅输出用)
RESERVED = (END, EPS, AUG)

MAX_PRODUCTIONS = 40
MAX_RHS = 8
MAX_TERMINALS = 30
MAX_NAME = 80
MAX_ID = 40
MAX_STATES = 256
MAX_INPUT = 200
MAX_STEPS = 2000

MODE_SLR = "SLR"
MODE_LR1 = "LR1"
MODES = (MODE_SLR, MODE_LR1)

_SYMBOL_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_SINGLE_CHAR_SYMBOLS = set("+*=()-/")
_DRAFT_KEYS = {"version", "name", "start", "terminals", "productions"}
_PROD_KEYS = {"id", "lhs", "rhs"}


class GrammarError(Exception):
    """文法本身或分析过程的可预期错误, message 可直接展示给用户。"""


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _is_str(x: Any) -> bool:
    return isinstance(x, str)


def valid_symbol(s: str) -> bool:
    if not isinstance(s, str) or len(s) == 0:
        return False
    if _SYMBOL_RE.fullmatch(s):
        return True
    return len(s) == 1 and s in _SINGLE_CHAR_SYMBOLS


def cp_sorted(values):
    """按 Unicode 码点排序(去重); Python 字符串比较即码点字典序。"""
    return sorted(set(values))


# ---------------------------------------------------------------------------
# 草稿校验
# ---------------------------------------------------------------------------

def validate_grammar(draft: Any):
    """严格校验草稿。

    返回 (clean_draft, errors[str], warnings[str])。
    失败时 clean_draft 为 None, 调用方必须保留原草稿不变。
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(draft, dict):
        return None, ["草稿必须是 JSON 对象"], warnings

    extra = [k for k in draft if k not in _DRAFT_KEYS]
    if extra:
        errors.append("存在未知字段: " + ", ".join(sorted(extra)))

    # ---- version ----
    version = draft.get("version")
    if "version" not in draft:
        errors.append("缺少 version 字段")
    elif isinstance(version, bool) or version != VERSION:
        errors.append(f"version 必须为整数 {VERSION}")

    # ---- name ----
    name = draft.get("name")
    if "name" not in draft:
        errors.append("缺少 name 字段")
    elif not _is_str(name):
        errors.append("name 必须是字符串")
    elif not (1 <= len(name) <= MAX_NAME):
        errors.append(f"name 长度须在 1~{MAX_NAME} 之间")

    # ---- start ----
    start = draft.get("start")
    if "start" not in draft:
        errors.append("缺少 start 字段")
    elif not _is_str(start):
        errors.append("start 必须是字符串")
    elif not valid_symbol(start):
        errors.append(f"开始符号 {start!r} 不符合符号命名规则")

    # ---- terminals ----
    terminals: list[str] = []
    term_raw = draft.get("terminals")
    if "terminals" not in draft:
        errors.append("缺少 terminals 字段")
    elif not isinstance(term_raw, list):
        errors.append("terminals 必须是数组")
    else:
        if not (1 <= len(term_raw) <= MAX_TERMINALS):
            errors.append(f"terminals 数量须在 1~{MAX_TERMINALS} 之间")
        seen_t: set[str] = set()
        for i, t in enumerate(term_raw):
            if not _is_str(t):
                errors.append(f"terminals[{i}] 必须是字符串")
                continue
            if not valid_symbol(t):
                errors.append(f"终结符 {t!r} 不符合符号命名规则")
            if t in RESERVED:
                errors.append(f"终结符 {t!r} 是保留符号, 禁止使用")
            if t in seen_t:
                errors.append(f"终结符 {t!r} 重复")
            seen_t.add(t)
        terminals = [t for t in term_raw if _is_str(t)]

    # ---- productions ----
    productions: list[dict] = []
    prod_raw = draft.get("productions")
    if "productions" not in draft:
        errors.append("缺少 productions 字段")
    elif not isinstance(prod_raw, list):
        errors.append("productions 必须是数组")
    else:
        if not (1 <= len(prod_raw) <= MAX_PRODUCTIONS):
            errors.append(f"产生式数量须在 1~{MAX_PRODUCTIONS} 之间")
        seen_ids: set[str] = set()
        for i, p in enumerate(prod_raw):
            where = f"productions[{i}]"
            if not isinstance(p, dict):
                errors.append(f"{where} 必须是对象")
                continue
            p_extra = [k for k in p if k not in _PROD_KEYS]
            if p_extra:
                errors.append(f"{where} 存在未知字段: " + ", ".join(sorted(p_extra)))
            pid = p.get("id")
            if "id" not in p:
                errors.append(f"{where} 缺少 id")
            elif not _is_str(pid):
                errors.append(f"{where}.id 必须是字符串")
            elif not (1 <= len(pid) <= MAX_ID):
                errors.append(f"{where}.id 长度须在 1~{MAX_ID} 之间")
            elif pid in seen_ids:
                errors.append(f"产生式 ID {pid!r} 重复")
            else:
                seen_ids.add(pid)
            lhs = p.get("lhs")
            if "lhs" not in p:
                errors.append(f"{where}({pid!r}) 缺少 lhs")
            elif not _is_str(lhs):
                errors.append(f"{where}({pid!r}) 的 lhs 必须是字符串")
            else:
                if not valid_symbol(lhs):
                    errors.append(f"{where}({pid!r}) 左部 {lhs!r} 不符合符号命名规则")
                if lhs in RESERVED:
                    errors.append(f"{where}({pid!r}) 左部使用了保留符号 {lhs!r}, 禁止出现在草稿中")
            rhs = p.get("rhs")
            if "rhs" not in p:
                errors.append(f"{where}({pid!r}) 缺少 rhs")
            elif not isinstance(rhs, list):
                errors.append(f"{where}({pid!r}) 的 rhs 必须是数组(留空表示 ε)")
            elif len(rhs) > MAX_RHS:
                errors.append(f"{where}({pid!r}) 右部最多 {MAX_RHS} 个符号")
            else:
                for j, s in enumerate(rhs):
                    if not _is_str(s):
                        errors.append(f"{where}({pid!r}) rhs[{j}] 必须是字符串")
                    else:
                        if not valid_symbol(s):
                            errors.append(f"{where}({pid!r}) 右部符号 {s!r} 不符合命名规则")
                        if s in RESERVED:
                            errors.append(f"{where}({pid!r}) 右部使用了保留符号 {s!r}, 禁止出现在草稿中")
            productions.append(p)

    if errors:
        return None, errors, warnings

    # 结构性检查通过后, 做跨字段语义检查
    terminal_set = set(terminals)
    lhs_set = {p["lhs"] for p in productions}

    if start in terminal_set:
        errors.append(f"开始符号 {start!r} 不能同时是终结符")
    if start not in lhs_set:
        errors.append(f"开始符号 {start!r} 没有作为任何产生式的左部(缺失开始符号)")

    overlap = terminal_set & lhs_set
    if overlap:
        errors.append("符号同时被声明为终结符和非终结符: " + ", ".join(cp_sorted(overlap)))

    known = terminal_set | lhs_set
    for p in productions:
        for s in p["rhs"]:
            if s not in known:
                errors.append(
                    f"产生式 {p['id']} 右部出现未知符号 {s!r}: "
                    "既未在 terminals 声明, 也不是任何产生式左部"
                )

    seen_bodies: set[tuple] = set()
    for p in productions:
        body = (p["lhs"], tuple(p["rhs"]))
        if body in seen_bodies:
            rhs_text = " ".join(p["rhs"]) if p["rhs"] else EPS
            errors.append(f"产生式 {p['id']}({p['lhs']} → {rhs_text}) 与另一条产生式完全重复")
        seen_bodies.add(body)

    if errors:
        return None, errors, warnings

    clean = {
        "version": VERSION,
        "name": name,
        "start": start,
        "terminals": list(terminals),
        "productions": [
            {"id": p["id"], "lhs": p["lhs"], "rhs": list(p["rhs"])}
            for p in productions
        ],
    }

    # 不可达 / 不可终结的非终结符仅警告
    generating: set[str] = set()
    changed = True
    while changed:
        changed = False
        for p in clean["productions"]:
            if p["lhs"] in generating:
                continue
            if all(s in terminal_set or s in generating for s in p["rhs"]):
                generating.add(p["lhs"])
                changed = True
    non_generating = lhs_set - generating
    if non_generating:
        warnings.append("以下非终结符无法推出任何终结符串(允许保留): "
                        + ", ".join(cp_sorted(non_generating)))

    reachable: set[str] = {start}
    queue = deque([start])
    while queue:
        a = queue.popleft()
        for p in clean["productions"]:
            if p["lhs"] != a:
                continue
            for s in p["rhs"]:
                if s in lhs_set and s not in reachable:
                    reachable.add(s)
                    queue.append(s)
    unreachable = lhs_set - reachable
    if unreachable:
        warnings.append("以下非终结符从开始符号不可达(允许保留): "
                        + ", ".join(cp_sorted(unreachable)))

    return clean, [], warnings


# ---------------------------------------------------------------------------
# 文法构造后的内部表示
# ---------------------------------------------------------------------------

class Grammar:
    def __init__(self, draft: dict):
        self.draft = draft
        self.terminals: list[str] = list(draft["terminals"])
        self.terminal_set = set(self.terminals)
        # 产生式 0 为增广产生式, 1..N 保持草稿顺序
        self.productions: list[tuple[str, tuple]] = [(AUG, (draft["start"],))]
        for p in draft["productions"]:
            self.productions.append((p["lhs"], tuple(p["rhs"])))
        self.nonterminals = sorted({lhs for lhs, _ in self.productions[1:]})
        self.by_lhs: dict[str, list[int]] = {}
        for i, (lhs, _) in enumerate(self.productions):
            self.by_lhs.setdefault(lhs, []).append(i)
        self.start = draft["start"]
        self.nullable: dict[str, bool] = {}
        self.first: dict[str, set[str]] = {}
        self.follow: dict[str, set[str]] = {}

    def is_terminal(self, s: str) -> bool:
        return s in self.terminal_set

    # -- 文法符号层的 FIRST/nullable 计算 --

    def compute_attributes(self) -> None:
        nts = self.nonterminals
        nullable = {a: False for a in nts}
        first: dict[str, set[str]] = {a: set() for a in nts}

        changed = True
        while changed:
            changed = False
            for idx in range(1, len(self.productions)):
                lhs, rhs = self.productions[idx]
                # nullable: 右部为空, 或右部符号全部是可空非终结符。
                # 终结符永远不可空(nullable 表只含非终结符, get 不到即为 False)。
                if not rhs:
                    if not nullable[lhs]:
                        nullable[lhs] = True
                        changed = True
                elif all(nullable.get(s, False) for s in rhs):
                    if not nullable[lhs]:
                        nullable[lhs] = True
                        changed = True
                # FIRST: 依次取右部符号的 FIRST, 遇不可空即止
                all_null = True
                for s in rhs:
                    if s in self.terminal_set:
                        if s not in first[lhs]:
                            first[lhs].add(s)
                            changed = True
                        all_null = False
                        break
                    before = len(first[lhs])
                    first[lhs] |= {x for x in first[s] if x != EPS}
                    if len(first[lhs]) != before:
                        changed = True
                    if not nullable[s]:
                        all_null = False
                        break
                if all_null:
                    if EPS not in first[lhs]:
                        first[lhs].add(EPS)
                        changed = True

        # FIRST/nullable 定点结束, 先挂到 self(FOLLOW 计算依赖 self._first_seq)
        self.nullable = nullable
        self.first = first

        follow: dict[str, set[str]] = {a: set() for a in nts}
        follow[self.start].add(END)
        changed = True
        while changed:
            changed = False
            for idx in range(1, len(self.productions)):
                lhs, rhs = self.productions[idx]
                for i, b in enumerate(rhs):
                    if b in self.terminal_set:
                        continue
                    beta = rhs[i + 1:]
                    add = self._first_seq(beta)
                    add.discard(EPS)
                    before = len(follow[b])
                    follow[b] |= add
                    if len(follow[b]) != before:
                        changed = True
                    # beta 可推出空串(含 beta 为空) → FOLLOW(A) 传播
                    if self._seq_nullable(beta):
                        before2 = len(follow[b])
                        follow[b] |= follow[lhs]
                        if len(follow[b]) != before2:
                            changed = True

        self.nullable = nullable
        self.first = first
        self.follow = follow

    def _seq_nullable(self, seq) -> bool:
        for s in seq:
            if s in self.terminal_set or s == END:
                return False
            if not self.nullable.get(s):
                return False
        return True

    def _first_seq(self, seq) -> set[str]:
        """符号串的 FIRST 集合(可能含 ε)。终结符(含结束符 $)直接返回自身。"""
        out: set[str] = set()
        all_null = True
        for s in seq:
            if s in self.terminal_set or s == END:
                out.add(s)
                all_null = False
                break
            out |= {x for x in self.first[s] if x != EPS}
            if not self.nullable[s]:
                all_null = False
                break
        if all_null:
            out.add(EPS)
        return out

    def first_after(self, beta, lookahead: str) -> set[str]:
        """FIRST(beta a): LR(1) closure 传播用, 结果必为终结符集合。"""
        out = self._first_seq(list(beta) + [lookahead])
        out.discard(EPS)  # lookahead 是终结符, 理论上不会残留
        return out


# ---------------------------------------------------------------------------
# 项目集族与分析表
# ---------------------------------------------------------------------------

def _closure_lr0(g: Grammar, kernel):
    items = set(kernel)
    work = list(kernel)
    while work:
        p, dot = work.pop()
        rhs = g.productions[p][1]
        if dot >= len(rhs):
            continue
        b = rhs[dot]
        if b in g.terminal_set:
            continue
        for q in g.by_lhs[b]:
            item = (q, 0)
            if item not in items:
                items.add(item)
                work.append(item)
    return frozenset(items)


def _closure_lr1(g: Grammar, kernel):
    items = set(kernel)
    work = list(kernel)
    while work:
        p, dot, _la = work.pop()
        rhs = g.productions[p][1]
        if dot >= len(rhs):
            continue
        b = rhs[dot]
        if b in g.terminal_set:
            continue
        beta = rhs[dot + 1:]
        # 同一状态内对该 B 只需按各自展望符传播; 逐个项目计算 FIRST(beta a)
        las = g.first_after(beta, _la)
        for q in g.by_lhs[b]:
            for a in las:
                item = (q, 0, a)
                if item not in items:
                    items.add(item)
                    work.append(item)
    return frozenset(items)


def _sorted_items(items, mode):
    if mode == MODE_SLR:
        return sorted(items, key=lambda it: (it[0], it[1]))
    return sorted(items, key=lambda it: (it[0], it[1], it[2]))


def build_table(draft: dict, mode: str) -> dict:
    clean, errors, warnings = validate_grammar(draft)
    if errors:
        raise GrammarError("; ".join(errors))
    if mode not in MODES:
        raise GrammarError(f"未知分析模式 {mode!r}")
    g = Grammar(clean)
    g.compute_attributes()

    if mode == MODE_SLR:
        closure = lambda kernel: _closure_lr0(g, kernel)
        start_kernel = frozenset({(0, 0)})
    else:
        closure = lambda kernel: _closure_lr1(g, kernel)
        start_kernel = frozenset({(0, 0, END)})

    # BFS 构造项目集族, 状态从 0 开始按发现顺序编号
    states_items: list[frozenset] = []
    index: dict[frozenset, int] = {}
    transitions: list[dict[str, int]] = []
    queue: deque[frozenset] = deque()

    first = closure(start_kernel)
    index[first] = 0
    states_items.append(first)
    transitions.append({})
    queue.append(first)

    while queue:
        items = queue.popleft()
        sid = index[items]
        symbols = set()
        for it in items:
            p, dot = it[0], it[1]
            rhs = g.productions[p][1]
            if dot < len(rhs):
                symbols.add(rhs[dot])
        for x in cp_sorted(symbols):  # 待转移符号按 Unicode 码点排序
            moved = set()
            for it in items:
                p, dot = it[0], it[1]
                rhs = g.productions[p][1]
                if dot < len(rhs) and rhs[dot] == x:
                    if mode == MODE_SLR:
                        moved.add((p, dot + 1))
                    else:
                        moved.add((p, dot + 1, it[2]))
            target = closure(frozenset(moved))
            if target not in index:
                new_id = len(states_items)
                if new_id >= MAX_STATES:
                    raise GrammarError(
                        f"项目集数量已达到 {MAX_STATES} 个状态的上限, "
                        "为避免返回被截断的分析表已停止生成, 请简化文法后重试"
                    )
                index[target] = new_id
                states_items.append(target)
                transitions.append({})
                queue.append(target)
            transitions[sid][x] = index[target]

    # ---- ACTION / GOTO ----
    state_actions: list[dict[str, list[dict]]] = []
    state_gotos: list[dict[str, int]] = []

    for sid, items in enumerate(states_items):
        actions: dict[str, list[tuple]] = {}

        def add(term: str, act: tuple):
            bucket = actions.setdefault(term, [])
            if act not in bucket:
                bucket.append(act)

        for it in items:
            p, dot = it[0], it[1]
            lhs, rhs = g.productions[p]
            if dot < len(rhs):
                sym = rhs[dot]
                if sym in g.terminal_set and sym in transitions[sid]:
                    add(sym, ("shift", transitions[sid][sym]))
                continue
            # 点在末尾: 归约或接受
            if p == 0:
                # 只有增广开始项目完成才可能接受
                if mode == MODE_SLR:
                    add(END, ("accept",))
                elif it[2] == END:
                    add(END, ("accept",))
            else:
                if mode == MODE_SLR:
                    for t in g.follow[lhs]:
                        add(t, ("reduce", p))
                else:
                    add(it[2], ("reduce", p))

        ordered_actions: dict[str, list[dict]] = {}
        for t in cp_sorted(actions):
            acts = sorted(actions[t],
                          key=lambda a: ({"shift": 0, "reduce": 1, "accept": 2}[a[0]],
                                         a[1] if len(a) > 1 else 0))
            ordered_actions[t] = [_action_to_json(a) for a in acts]
        state_actions.append(ordered_actions)

        gts = {sym: dst for sym, dst in transitions[sid].items()
               if sym not in g.terminal_set and sym != AUG}
        state_gotos.append({sym: gts[sym] for sym in cp_sorted(gts)})

    conflicts = _build_conflicts(g, states_items, state_actions, mode)

    table = {
        "version": VERSION,
        "mode": mode,
        "grammar": clean,
        "nullable": [a for a in g.nonterminals if g.nullable[a]],
        "first": {a: cp_sorted(g.first[a]) for a in g.nonterminals},
        "follow": {a: cp_sorted(g.follow[a]) for a in g.nonterminals},
        "states": [
            {
                "id": sid,
                "items": _items_to_json(g, states_items[sid], mode),
                "transitions": {s: transitions[sid][s] for s in cp_sorted(transitions[sid])},
                "action": state_actions[sid],
                "goto": state_gotos[sid],
            }
            for sid in range(len(states_items))
        ],
        "conflicts": conflicts,
    }
    table["_warnings"] = warnings
    return table


def _action_to_json(a: tuple) -> dict:
    if a[0] == "shift":
        return {"type": "shift", "to": a[1]}
    if a[0] == "reduce":
        return {"type": "reduce", "production": a[1]}
    return {"type": "accept"}


def _items_to_json(g: Grammar, items, mode: str) -> list[dict]:
    out = []
    for it in _sorted_items(items, mode):
        row = {"production": it[0], "dot": it[1]}
        if mode == MODE_LR1:
            row["lookahead"] = it[2]
        out.append(row)
    return out


def _build_conflicts(g, states_items, state_actions, mode) -> list[dict]:
    conflicts = []
    for sid, cell_map in enumerate(state_actions):
        for term in cp_sorted(cell_map):
            acts = cell_map[term]
            if len(acts) <= 1:
                continue
            kinds = set()
            has_shift = any(a["type"] == "shift" for a in acts)
            reduces = [a for a in acts if a["type"] == "reduce"]
            has_accept = any(a["type"] == "accept" for a in acts)
            if has_shift and reduces:
                kinds.add("shift/reduce")
            if len(reduces) >= 2:
                kinds.add("reduce/reduce")
            if has_accept and reduces:
                kinds.add("accept/reduce")
            for kind in sorted(kinds):
                conflicts.append({
                    "state": sid,
                    "symbol": term,
                    "kind": kind,
                    "actions": acts,
                })
    conflicts.sort(key=lambda c: (c["state"], c["symbol"], c["kind"]))
    return conflicts


# ---------------------------------------------------------------------------
# 表驱动分析
# ---------------------------------------------------------------------------

def tokenize_input(text: str, g: Grammar) -> list[str]:
    """空白分词; $ 禁止用户输入; 定位未知符号。返回不含 $ 的 token 列表。"""
    tokens = text.split()
    unknown = []
    for i, tok in enumerate(tokens):
        if tok == END:
            unknown.append((i, tok, "结束符 $ 由程序自动追加, 不允许出现在输入中"))
        elif tok not in g.terminal_set:
            unknown.append((i, tok, "不是文法终结符"))
    if unknown:
        msgs = []
        for i, tok, why in unknown:
            msgs.append(f"第 {i + 1} 个 token {tok!r}: {why}")
        raise GrammarError("输入包含非法符号: " + "; ".join(msgs))
    return tokens


def parse(table: dict, text: str):
    """执行移进-归约分析。

    返回 dict:
      status: accepted | error | limit
      steps:  每步执行前后快照
      出错时带 state/symbol/expected/prefix; 超限时带步骤数
    """
    if table["conflicts"]:
        raise GrammarError("分析表存在冲突, 禁止启动分析; 请先消除冲突或切换分析模式")

    # 仅需终结符集合做分词; Grammar 构造不依赖 FIRST/FOLLOW
    g = Grammar(table["grammar"])
    tokens = tokenize_input(text, g)
    if len(tokens) > MAX_INPUT:
        raise GrammarError(f"输入 token 数为 {len(tokens)}, 超过上限 {MAX_INPUT}")

    remaining = tokens + [END]
    states_stack = [0]
    symbol_stack: list[str] = []
    steps = []
    status = "running"
    error_info = None

    for step_no in range(1, MAX_STEPS + 1):
        top = states_stack[-1]
        current = remaining[0]
        cell = table["states"][top]["action"].get(current)

        before = {
            "stateStack": list(states_stack),
            "symbolStack": list(symbol_stack),
            "remaining": list(remaining),
        }

        if not cell:
            expected = cp_sorted(table["states"][top]["action"].keys())
            consumed = tokens[: len(tokens) - (len(remaining) - 1)]
            error_info = {
                "state": top,
                "symbol": current,
                "expected": expected,
                "prefix": consumed,
                "message": (
                    f"状态 {top} 下对终结符 {current!r} 没有 ACTION 表项; "
                    f"此处可以接受: {', '.join(expected) if expected else '(无任何终结符)'}"
                ),
            }
            status = "error"
            break

        action = cell[0]  # 无冲突表每格恰好一个动作
        atype = action["type"]
        after_symbol = list(symbol_stack)
        after_state = list(states_stack)
        after_remaining = list(remaining)

        if atype == "shift":
            after_symbol.append(current)
            after_state.append(action["to"])
            after_remaining = remaining[1:]
            record_action = {"type": "shift", "to": action["to"], "symbol": current}
        elif atype == "reduce":
            pid = action["production"]
            prod = table["grammar"]["productions"][pid - 1]
            lhs, rhs = prod["lhs"], prod["rhs"]
            for _ in rhs:  # ε 归约弹 0 项
                after_state.pop()
                after_symbol.pop()
            goto_state = table["states"][after_state[-1]]["goto"].get(lhs)
            if goto_state is None:
                consumed = tokens[: len(tokens) - (len(remaining) - 1)]
                error_info = {
                    "state": after_state[-1],
                    "symbol": lhs,
                    "expected": [],
                    "prefix": consumed,
                    "message": f"归约 {lhs} 后在状态 {after_state[-1]} 找不到 GOTO 表项(分析表构造异常)",
                }
                status = "error"
                steps.append({
                    "index": step_no,
                    "before": before,
                    "action": {"type": "reduce", "production": pid,
                               "productionId": prod["id"], "lhs": lhs, "rhs": list(rhs)},
                    "after": {"stateStack": after_state, "symbolStack": after_symbol,
                              "remaining": after_remaining},
                })
                break
            after_symbol.append(lhs)
            after_state.append(goto_state)
            record_action = {"type": "reduce", "production": pid,
                             "productionId": prod["id"], "lhs": lhs, "rhs": list(rhs),
                             "popped": len(rhs), "goto": goto_state}
        else:  # accept: 仅增广项目在 $ 上产生
            record_action = {"type": "accept"}
            steps.append({
                "index": step_no,
                "before": before,
                "action": record_action,
                "after": {"stateStack": list(states_stack),
                          "symbolStack": list(symbol_stack),
                          "remaining": list(remaining)},
            })
            status = "accepted"
            break

        steps.append({
            "index": step_no,
            "before": before,
            "action": record_action,
            "after": {"stateStack": after_state,
                      "symbolStack": after_symbol,
                      "remaining": after_remaining},
        })
        states_stack = after_state
        symbol_stack = after_symbol
        remaining = after_remaining
    else:
        status = "limit"
        error_info = {
            "state": states_stack[-1],
            "symbol": remaining[0],
            "message": f"已执行 {MAX_STEPS} 步仍未接受, 达到步数上限, 分析终止(并非接受)",
        }

    return {
        "status": status,
        "steps": steps,
        "tokens": tokens,
        "error": error_info,
        "final": {
            "stateStack": states_stack,
            "symbolStack": symbol_stack,
            "remaining": remaining,
        },
    }


def public_table(table: dict) -> dict:
    """去掉内部字段, 返回严格符合导出格式的表对象。"""
    return {k: v for k, v in table.items() if not k.startswith("_")}
