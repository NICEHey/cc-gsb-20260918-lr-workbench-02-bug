"""LR 工作台可执行自测: python3 selftest.py

覆盖:
  两种算法差异 / nullable 传播 / 多个冲突动作保留 / 规范 LR(1) 不合并同核心状态 /
  错误串定位 / 空串接受(ε 归约) / 校验规则与失败不改草稿 / 状态与步数上限 /
  导出格式合规 / 前端失效规则(若环境有 node)
"""

import copy
import json
import os
import shutil
import subprocess
import sys
import traceback

import lr_core as L

CASES = {c["key"]: c for c in json.load(
    open(os.path.join(os.path.dirname(__file__), "fixtures", "grammars.json"),
         encoding="utf-8"))["cases"]}

_passed = 0
_failures = []


def check(name, cond, detail=""):
    global _passed
    if cond:
        _passed += 1
    else:
        _failures.append((name, detail))


def section(title):
    print(f"== {title}")


def grammar(key):
    return copy.deepcopy(CASES[key]["grammar"])


def cell(table, state, sym):
    return table["states"][state]["action"].get(sym)


# ---------------------------------------------------------------------------
# 1. 两种算法的差异
# ---------------------------------------------------------------------------
section("SLR 与规范 LR(1) 差异")

expr_s = L.build_table(grammar("expression"), L.MODE_SLR)
expr_l = L.build_table(grammar("expression"), L.MODE_LR1)
check("表达式文法两种模式均无冲突",
      not expr_s["conflicts"] and not expr_l["conflicts"])
check("规范 LR(1) 状态数通常多于 LR(0)",
      len(expr_l["states"]) == 22 and len(expr_s["states"]) == 12,
      f"{len(expr_l['states'])} vs {len(expr_s['states'])}")

rs = L.parse(expr_s, "id + id * id")
rl = L.parse(expr_l, "id + id * id")
check("id + id * id 两种模式均接受",
      rs["status"] == "accepted" and rl["status"] == "accepted")

bad_s = L.parse(expr_s, "id + * id")
bad_l = L.parse(expr_l, "id + * id")
check("id + * id 两种模式均在 * 处报错",
      bad_s["status"] == "error" and bad_s["error"]["symbol"] == "*"
      and bad_l["status"] == "error" and bad_l["error"]["symbol"] == "*")
check("错误保留成功前缀 id +",
      bad_s["error"]["prefix"] == ["id", "+"],
      str(bad_s["error"]["prefix"]))
check("错误列出当前状态可接受的终结符",
      set(bad_s["error"]["expected"]) == {"id", "("},
      str(bad_s["error"]["expected"]))

asn_s = L.build_table(grammar("assignment"), L.MODE_SLR)
asn_l = L.build_table(grammar("assignment"), L.MODE_LR1)
check("赋值文法 SLR 有冲突", len(asn_s["conflicts"]) == 1
      and asn_s["conflicts"][0]["kind"] == "shift/reduce")
check("赋值文法 LR1 无冲突", not asn_l["conflicts"])
ar = L.parse(asn_l, "id = id")
check("LR1 下 id = id 接受", ar["status"] == "accepted", ar["status"])
try:
    L.parse(asn_s, "id = id")
    check("有冲突的表禁止启动分析", False)
except L.GrammarError:
    check("有冲突的表禁止启动分析", True)

# 规范 LR1 不做 LALR 合并: 同 (production,dot) 核心因展望符不同而分属多状态
def split_cores(table):
    from collections import defaultdict
    cores = defaultdict(set)
    for st in table["states"]:
        for it in {(i["production"], i["dot"]) for i in st["items"]}:
            cores[it].add(st["id"])
    return {k: v for k, v in cores.items() if len(v) > 1}

unm_l = L.build_table(grammar("unmerged"), L.MODE_LR1)
split = split_cores(unm_l)
check("LR1 同 LR0 核心状态未被偷偷合并",
      any(v >= {2, 3} or v >= {6, 9} for v in split.values()),
      str({f"P{k[0]}.{k[1]}": sorted(v) for k, v in split.items()}))
check("该文法 LR1 无冲突且 a c d 接受",
      not unm_l["conflicts"]
      and L.parse(unm_l, "a c d")["status"] == "accepted")

# SLR 项目不带 lookahead, LR1 每项必带
check("SLR 项目无 lookahead 字段",
      all("lookahead" not in it for st in expr_s["states"] for it in st["items"]))
check("LR1 项目逐个导出 lookahead",
      all(all("lookahead" in it for it in st["items"]) for st in expr_l["states"]))


# ---------------------------------------------------------------------------
# 2. nullable / FIRST / FOLLOW 传播
# ---------------------------------------------------------------------------
section("nullable / FIRST / FOLLOW 传播")

nul = L.build_table(grammar("nullable"), L.MODE_SLR)
check("A、B 均可空(S 也随之可空)",
      {"A", "B"} <= set(nul["nullable"]), str(nul["nullable"]))
check("FIRST(A) 同时含终结符与 ε",
      set(nul["first"]["A"]) == {"a", L.EPS} and set(nul["first"]["B"]) == {"b", L.EPS},
      f"{nul['first']['A']} {nul['first']['B']}")
check("FIRST(S) 合流 A、B 的首符",
      set(nul["first"]["S"]) == {"a", "b", L.EPS}, str(nul["first"]["S"]))
check("FOLLOW 含结束符 $",
      L.END in nul["follow"]["S"] and L.END in nul["follow"]["A"]
      and L.END in nul["follow"]["B"])

# 多层可空链: S -> A b C, A -> a | ε, C -> c | ε  (非 fixture, 现场构造)
chain = {"version": 1, "name": "链", "start": "S", "terminals": ["a", "b", "c"],
         "productions": [
             {"id": "p1", "lhs": "S", "rhs": ["A", "b", "C"]},
             {"id": "p2", "lhs": "A", "rhs": ["a"]},
             {"id": "p3", "lhs": "A", "rhs": []},
             {"id": "p4", "lhs": "C", "rhs": ["c"]},
             {"id": "p5", "lhs": "C", "rhs": []}]}
ct = L.build_table(chain, L.MODE_SLR)
check("链中 C 可空", "C" in ct["nullable"] and "A" in ct["nullable"])
check("FIRST(S) 为 a,b", set(ct["first"]["S"]) == {"a", "b"}, str(ct["first"]["S"]))
check("FOLLOW(A) 含 b", "b" in ct["follow"]["A"])
check("C 可空 → FOLLOW(C) 含 $", L.END in ct["follow"]["C"])

# 回归: 报告中的"无空产生式却报 reduce/reduce"文法。
# 旧缺陷把终结符当作可空, 导致 A、B 误判可空、FIRST(S) 混入 b/ε、状态 3 的 $ 格伪冲突。
pc = L.build_table(grammar("pseudo-conflict"), L.MODE_SLR)
pc_l = L.build_table(grammar("pseudo-conflict"), L.MODE_LR1)
check("无空产生式文法 nullable 必须为空(SLR)", pc["nullable"] == [], str(pc["nullable"]))
check("无空产生式文法 nullable 必须为空(LR1)", pc_l["nullable"] == [])
check("FIRST(S) 仅 {a}, 不含 b/ε/*/+",
      set(pc["first"]["S"]) == {"a"}, str(pc["first"]["S"]))
check("FIRST(A)={a}, FIRST(B)={b}",
      set(pc["first"]["A"]) == {"a"} and set(pc["first"]["B"]) == {"b"})
check("FOLLOW(A)={b}, 终结符 b 阻断后不继承 $",
      set(pc["follow"]["A"]) == {"b"}, str(pc["follow"]["A"]))
check("FOLLOW(B)={$}", set(pc["follow"]["B"]) == {L.END})
check("两种模式状态 3 的 $ 格均无 reduce2/reduce3 伪冲突",
      not pc["conflicts"] and not pc_l["conflicts"],
      f"{pc['conflicts']} {pc_l['conflicts']}")
check("合法输入 a 两种模式均接受",
      L.parse(pc, "a")["status"] == "accepted"
      and L.parse(pc_l, "a")["status"] == "accepted")
check("合法输入 a b 两种模式均接受",
      L.parse(pc, "a b")["status"] == "accepted"
      and L.parse(pc_l, "a b")["status"] == "accepted")
check("非法输入 a a 报错而非接受(无伪归约路径)",
      L.parse(pc, "a a")["status"] == "error")

# 表达式文法: E/T/F 都不可空, FIRST(E) 绝不能含 +/*/ε
check("表达式 E/T/F 均不可空",
      set(expr_s["nullable"]) == set(), str(expr_s["nullable"]))
check("FIRST(E) = {id, (}, 不含 + * ε",
      set(expr_s["first"]["E"]) == {"id", "("}, str(expr_s["first"]["E"]))
check("FIRST(F) = {id, (}",
      set(expr_s["first"]["F"]) == {"id", "("}, str(expr_s["first"]["F"]))

# 间接可空 + 多层依赖 + 含终结符的非空链
deep = {"version": 1, "name": "deep", "start": "S", "terminals": ["a", "b", "c"],
        "productions": [
            {"id": "s", "lhs": "S", "rhs": ["P", "Q", "R", "c"]},
            {"id": "p", "lhs": "P", "rhs": ["U"]},
            {"id": "u", "lhs": "U", "rhs": []},          # U 可空 → P 间接可空
            {"id": "q1", "lhs": "Q", "rhs": ["V", "b"]},  # 含终结符 b, Q 不可空
            {"id": "q2", "lhs": "Q", "rhs": []},
            {"id": "v", "lhs": "V", "rhs": []},
            {"id": "r1", "lhs": "R", "rhs": ["a"]},       # R 不可空
        ]}
dt = L.build_table(deep, L.MODE_SLR)
check("间接可空: U、P、V、Q 可空, R/S 不可空",
      set(dt["nullable"]) == {"P", "Q", "U", "V"}, str(dt["nullable"]))
check("FIRST 越过可空 P、Q(贡献 b), 止于不可空 R(贡献 a), 到不了末尾 c",
      set(dt["first"]["S"]) == {"a", "b"}, str(dt["first"]["S"]))
check("末尾 c 出现在 FOLLOW(R) 而非 FIRST(S)",
      "c" in dt["follow"]["R"] and "c" not in dt["first"]["S"])

# 不生成句子的自循环: 非终结符 X -> X 永不可空, 也不污染 FIRST
cyc = {"version": 1, "name": "cyc", "start": "S", "terminals": ["a"],
       "productions": [{"id": "s", "lhs": "S", "rhs": ["a"]},
                       {"id": "x", "lhs": "X", "rhs": ["X"]}]}
xt = L.build_table(cyc, L.MODE_SLR)
check("不生成句子的循环 X 不可空、FIRST 为空",
      "X" not in xt["nullable"] and xt["first"]["X"] == [], str(xt["nullable"]))


# ---------------------------------------------------------------------------
# 3. 多冲突动作保留
# ---------------------------------------------------------------------------
section("冲突候选动作全部保留")

amb = L.build_table(grammar("ambiguous"), L.MODE_SLR)
c = amb["conflicts"]
check("S→SS|a 报 shift/reduce",
      len(c) == 1 and c[0]["kind"] == "shift/reduce" and c[0]["symbol"] == "a")
s2_a = cell(amb, 3, "a")
check("冲突格同时保留 shift 与 reduce 两个候选",
      s2_a and {a["type"] for a in s2_a} == {"shift", "reduce"}, str(s2_a))

rr = L.build_table(grammar("reduce-reduce"), L.MODE_SLR)
rr_cells = [a for st in rr["states"] for a in st["action"].values()
            if {x["type"] for x in a} == {"reduce"} and len(a) == 2]
check("归约/归约同格保留两个不同 reduce",
      any({x["production"] for x in cell0} == {3, 4} for cell0 in rr_cells),
      str(rr_cells))
check("reduce/reduce 冲突被记录",
      any(x["kind"] == "reduce/reduce" for x in rr["conflicts"]))

ar_t = L.build_table(grammar("accept-reduce"), L.MODE_SLR)
dollar = cell(ar_t, 1, "$")
check("accept 与 reduce 同在 $ 格且不互相覆盖",
      dollar and {a["type"] for a in dollar} == {"accept", "reduce"}, str(dollar))
check("accept/reduce 冲突被记录",
      any(x["kind"] == "accept/reduce" and x["state"] == 1
          for x in ar_t["conflicts"]))
check("普通产生式完成不会产生 accept",
      all(a["type"] != "accept"
          for st in ar_t["states"] for sym, acts in st["action"].items()
          if sym != "$" for a in acts))


# ---------------------------------------------------------------------------
# 4. 空串与 ε 归约
# ---------------------------------------------------------------------------
section("空串接受与 ε 归约")

empty_run = L.parse(nul, "")
check("可空文法真正接受空串", empty_run["status"] == "accepted")
eps_steps = [s for s in empty_run["steps"] if s["action"]["type"] == "reduce"
             and s["action"]["rhs"] == []]
check("空串轨迹包含 ε 归约", len(eps_steps) >= 2)
check("ε 归约弹 0 项(popped=0)随后因 GOTO 状态栈净增 1",
      all(s["action"]["popped"] == 0
          and len(s["after"]["stateStack"]) == len(s["before"]["stateStack"]) + 1
          for s in eps_steps))
check("ε 归约后仍查 GOTO 并入栈左部",
      all(s["action"]["goto"] is not None
          and len(s["after"]["symbolStack"]) == len(s["before"]["symbolStack"]) + 1
          for s in eps_steps))
check("每步都有完整前后快照(供单步/后退)",
      all({"stateStack", "symbolStack", "remaining"} <= set(s["before"])
          and {"stateStack", "symbolStack", "remaining"} <= set(s["after"])
          for s in empty_run["steps"]))


# ---------------------------------------------------------------------------
# 5. 输入校验与错误定位
# ---------------------------------------------------------------------------
section("输入处理")

try:
    L.parse(expr_s, "id + id $")
    check("用户输入 $ 被拒绝", False)
except L.GrammarError as e:
    check("用户输入 $ 被拒绝", "$" in str(e))

try:
    L.parse(expr_s, "id + nope")
    check("未知符号开始前定位报错", False)
except L.GrammarError as e:
    check("未知符号开始前定位报错(指出第 3 个 token)",
          "nope" in str(e) and "第 3" in str(e))

g_for_tokens = L.Grammar(expr_s["grammar"])
check("空白分词, 空输入为 0 token", L.tokenize_input("   ", g_for_tokens) == [])
check("$ 由程序追加: 用户 token 不含 $", "$" not in L.tokenize_input("id", g_for_tokens))

big = " ".join(["id"] * (L.MAX_INPUT + 1))
try:
    L.parse(expr_s, big)
    check(f"输入超过 {L.MAX_INPUT} token 被拒绝", False)
except L.GrammarError:
    check(f"输入超过 {L.MAX_INPUT} token 被拒绝", True)


# ---------------------------------------------------------------------------
# 6. 草稿校验: 失败不改变原草稿
# ---------------------------------------------------------------------------
section("文法校验规则")

def expect_errors(draft, needles=()):
    snap = copy.deepcopy(draft)
    clean, errs, _ = L.validate_grammar(draft)
    check("校验失败返回 None", clean is None and bool(errs))
    check("校验过程不修改原草稿", draft == snap)
    for needle in needles:
        check(f"报错包含 {needle!r}", any(needle in e for e in errs), str(errs))
    return errs

base = grammar("expression")

bad = copy.deepcopy(base); bad["version"] = 2
expect_errors(bad, ["version"])
bad = copy.deepcopy(base); bad["name"] = ""
expect_errors(bad, ["name"])
bad = copy.deepcopy(base); bad["start"] = "E"; bad["terminals"].append("E")
expect_errors(bad, ["终结符"])
bad = copy.deepcopy(base); bad["start"] = "Z"
expect_errors(bad, ["开始符号"])
bad = copy.deepcopy(base); bad["productions"][0]["rhs"].append("Q")
expect_errors(bad, ["未知符号"])
bad = copy.deepcopy(base)
bad["productions"].append({"id": "dup", "lhs": "F", "rhs": ["id"]})
expect_errors(bad, ["重复"])
bad = copy.deepcopy(base); bad["productions"][1]["id"] = "e-add"
expect_errors(bad, ["ID"])
bad = copy.deepcopy(base); bad["terminals"].append("$")
expect_errors(bad, ["保留符号"])
bad = copy.deepcopy(base); bad["terminals"].append("ε")
expect_errors(bad, ["保留符号"])
bad = copy.deepcopy(base)
bad["productions"].append({"id": "aug", "lhs": L.AUG, "rhs": ["E"]})
expect_errors(bad, ["保留符号"])
bad = copy.deepcopy(base); bad["terminals"].append("+")
expect_errors(bad, ["重复"])
bad = copy.deepcopy(base); bad["productions"][0]["rhs"] = ["E", "+", "T", "T", "T",
                                                           "T", "T", "T", "T"]
expect_errors(bad, [str(L.MAX_RHS)])

# 右部恰好 8 合法, 9 拒绝; 拒绝时 9 个符号必须原样保留(后端绝不裁剪)
ok8 = copy.deepcopy(base)
ok8["productions"] = [{"id": "s", "lhs": "E", "rhs": ["id"] * 8}]
c8, e8, _ = L.validate_grammar(ok8)
check("右部恰好 8 个符号合法", c8 is not None and not e8, str(e8))
bad9 = copy.deepcopy(base)
bad9["productions"] = [{"id": "s", "lhs": "E", "rhs": ["id"] * 9}]
c9, e9, _ = L.validate_grammar(bad9)
check("右部 9 个符号被拒", c9 is None and any(str(L.MAX_RHS) in e for e in e9), str(e9))
check("拒绝后右部仍完整保留 9 个(不静默裁剪)",
      len(bad9["productions"][0]["rhs"]) == 9)

# 终结符恰好 30 合法, 31 拒绝且完整保留
def terms_draft(n):
    return {"version": 1, "name": "tn", "start": "S",
            "terminals": [f"t{i:02d}" for i in range(n)],
            "productions": [{"id": "s", "lhs": "S", "rhs": [f"t{n-1:02d}"]}]}
c30, e30, _ = L.validate_grammar(terms_draft(30))
check("终结符恰好 30 个合法", c30 is not None and not e30, str(e30))
d31 = terms_draft(31)
c31, e31, _ = L.validate_grammar(d31)
check("终结符 31 个被拒", c31 is None and any(str(L.MAX_TERMINALS) in e for e in e31), str(e31))
check("拒绝后 31 个终结符仍完整保留(不静默裁剪)", len(d31["terminals"]) == 31)
bad = copy.deepcopy(base)
bad["productions"] = base["productions"] * 7  # 42 > 40
expect_errors(bad, [str(L.MAX_PRODUCTIONS)])
bad = copy.deepcopy(base); bad["extra"] = 1
expect_errors(bad, ["未知字段"])
bad = {"version": 1, "name": "x", "start": "S", "terminals": ["a"],
       "productions": [{"id": "p", "lhs": "S", "rhs": ["a"], "junk": True}]}
expect_errors(bad, ["未知字段"])
expect_errors("not a dict", ["对象"])
expect_errors(None, ["对象"])
expect_errors({"version": 1}, ["缺少"])

clean, errs, warns = L.validate_grammar(base)
check("合法草稿通过校验且被规范化(保持产生式顺序)",
      not errs and [p["id"] for p in clean["productions"]]
      == [p["id"] for p in base["productions"]])

# 左递归与空产生式合法
lr = {"version": 1, "name": "左递归", "start": "A", "terminals": ["a"],
      "productions": [{"id": "x", "lhs": "A", "rhs": ["A", "a"]},
                      {"id": "y", "lhs": "A", "rhs": []}]}
clean2, errs2, _ = L.validate_grammar(lr)
check("左递归与 ε 产生式是合法能力", clean2 is not None and not errs2, str(errs2))

# 不可达/不生成句子只警告
warn_g = {"version": 1, "name": "w", "start": "S", "terminals": ["a"],
          "productions": [{"id": "s", "lhs": "S", "rhs": ["a"]},
                          {"id": "u", "lhs": "U", "rhs": ["U"]}]}
_, errs3, warns3 = L.validate_grammar(warn_g)
check("不可达/不生成非终结符仅警告不报错", not errs3 and bool(warns3), str(warns3))


# ---------------------------------------------------------------------------
# 7. 上限保护
# ---------------------------------------------------------------------------
section("上限保护(不返回截断结果)")

old = L.MAX_STATES
L.MAX_STATES = 5
try:
    try:
        L.build_table(grammar("expression"), L.MODE_LR1)
        check("超状态上限报可理解错误而非截断表", False)
    except L.GrammarError as e:
        check("超状态上限报可理解错误而非截断表", "256" in str(e) or "上限" in str(e), str(e))
finally:
    L.MAX_STATES = old

old_steps = L.MAX_STEPS
L.MAX_STEPS = 3
try:
    lim = L.parse(expr_s, "id + id * id")
    check("步数超限报告 limit 而非接受",
          lim["status"] == "limit" and "上限" in lim["error"]["message"]
          and len(lim["steps"]) == 3,
          f"{lim['status']} {len(lim['steps'])} {lim['error']}")
finally:
    L.MAX_STEPS = old_steps


# ---------------------------------------------------------------------------
# 8. 导出格式合规
# ---------------------------------------------------------------------------
section("导出格式严格遵循 format.md")

exp = L.public_table(expr_l)
top = set(exp)
check("顶层字段齐全",
      {"version", "mode", "grammar", "nullable", "first", "follow",
       "states", "conflicts"} <= top)
check("mode 取值正确", exp["mode"] == "LR1")
check("导出 grammar 不含增广产生式",
      all(p["lhs"] != L.AUG for p in exp["grammar"]["productions"]))
check("产生式编号引用在 0..N 范围(0 为增广)",
      all(0 <= it["production"] <= len(exp["grammar"]["productions"])
          for st in exp["states"] for it in st["items"]))
check("ACTION 一律用数组且无空格",
      all(isinstance(v, list) and v
          for st in exp["states"] for v in st["action"].values()))
check("GOTO 不含 @START",
      all(L.AUG not in st["goto"] for st in exp["states"]))
nul_exp = L.public_table(nul)
check("FIRST 空串用 ε 表示", L.EPS in nul_exp["first"]["A"])
check("FOLLOW 结束符用 $ 表示", L.END in nul_exp["follow"]["S"])
check("nullable 数组按码点排序",
      exp["nullable"] == sorted(exp["nullable"]))
check("FIRST/FOLLOW 数组按码点排序",
      all(v == sorted(v) for v in exp["first"].values())
      and all(v == sorted(v) for v in exp["follow"].values()))
check("状态从 0 开始且连续 BFS 编号",
      [st["id"] for st in exp["states"]] == list(range(len(exp["states"]))))
check("conflicts 含 state/symbol/kind/actions",
      all({"state", "symbol", "kind", "actions"} <= set(c)
          for c in L.public_table(amb)["conflicts"]))
check("有冲突的表仍可导出(生成失败 ≠ 有冲突)",
      len(L.public_table(amb)["states"]) > 0 and L.public_table(amb)["conflicts"])
json.dumps(exp, ensure_ascii=False)  # 可 JSON 序列化
check("导出可序列化为 JSON", True)


# ---------------------------------------------------------------------------
# 9b. HTTP 接口级回归(真实启动 server.py, 验证页面所用三个 API 与导出完整性)
# ---------------------------------------------------------------------------
section("HTTP 接口: /api/validate /api/build /api/parse")

import socket
import urllib.request
import urllib.error


def _free_port():
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


def _api(root, path, payload):
    req = urllib.request.Request(
        root + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


_server = None
try:
    port = _free_port()
    _server = subprocess.Popen(
        [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(port)],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    root = f"http://127.0.0.1:{port}"
    import time as _time
    for _ in range(50):
        try:
            urllib.request.urlopen(root + "/", timeout=1).read()
            break
        except OSError:
            _time.sleep(0.1)

    # validate 合法草稿
    st, v = _api(root, "/api/validate", {"grammar": grammar("pseudo-conflict")})
    check("HTTP validate 合法", st == 200 and v["valid"] is True and v["errors"] == [],
          str(v)[:200])

    # build 伪冲突文法: 页面/接口同源, nullable 空、无冲突、grammar 完整 4 条
    st, t = _api(root, "/api/build",
                 {"grammar": grammar("pseudo-conflict"), "mode": "SLR"})
    check("HTTP build 伪冲突文法 200", st == 200, str(t)[:200])
    check("HTTP 表 nullable 为空", t.get("nullable") == [], str(t.get("nullable")))
    check("HTTP 表无冲突", t.get("conflicts") == [], str(t.get("conflicts")))
    check("HTTP 表带回完整 4 条产生式",
          len(t["grammar"]["productions"]) == 4)

    # parse a 与 a b 接受; 导出的同一张表能解释
    for inp in ("a", "a b"):
        st, r = _api(root, "/api/parse",
                     {"grammar": grammar("pseudo-conflict"), "mode": "SLR",
                      "input": inp})
        check(f"HTTP parse {inp!r} 接受",
              st == 200 and r["status"] == "accepted", f"{st} {str(r)[:200]}")
        check("接受轨迹最后一步为 accept",
              r["steps"][-1]["action"]["type"] == "accept")
        check("0 步预计算不会改变: steps 里 accept 是最后一步而非开局",
              r["status"] == "accepted" and len(r["steps"]) >= 1)

    # 右部 8: 建表成功且导出 grammar 完整保留 8 个符号
    g8 = copy.deepcopy(base)
    g8["productions"] = [{"id": "s", "lhs": "E", "rhs": ["id"] * 8}]
    st, t8 = _api(root, "/api/build", {"grammar": g8, "mode": "SLR"})
    check("HTTP 右部 8 建表成功", st == 200 and len(t8["grammar"]["productions"][0]["rhs"]) == 8,
          f"{st} {str(t8)[:200]}")

    # 右部 9: 建表必须 400 报错, 绝不返回"裁剪后有效"的表
    g9 = copy.deepcopy(base)
    g9["productions"] = [{"id": "s", "lhs": "E", "rhs": ["id"] * 9}]
    st, t9 = _api(root, "/api/build", {"grammar": g9, "mode": "SLR"})
    check("HTTP 右部 9 建表被拒(400)且无表",
          st == 400 and "error" in t9 and "states" not in t9, f"{st} {str(t9)[:200]}")

    # 终结符 31: 建表拒绝; 30: 通过
    st31, r31 = _api(root, "/api/build",
                     {"grammar": terms_draft(31), "mode": "SLR"})
    check("HTTP 终结符 31 建表被拒", st31 == 400 and "30" in r31.get("error", ""),
          f"{st31} {str(r31)[:200]}")
    st30, t30 = _api(root, "/api/build",
                     {"grammar": terms_draft(30), "mode": "SLR"})
    check("HTTP 终结符 30 建表成功且完整保留",
          st30 == 200 and len(t30["grammar"]["terminals"]) == 30,
          f"{st30} {str(t30)[:200]}")

    # 有冲突的表仍可经 API 正常返回(可导出), 但 /api/parse 拒绝
    st, ta = _api(root, "/api/build",
                  {"grammar": grammar("ambiguous"), "mode": "SLR"})
    check("HTTP 冲突表正常返回(可导出)", st == 200 and bool(ta["conflicts"]), f"{st}")
    st, rp = _api(root, "/api/parse",
                  {"grammar": grammar("ambiguous"), "mode": "SLR", "input": "a"})
    check("HTTP 冲突表禁止分析", st == 400 and "冲突" in rp.get("error", ""),
          f"{st} {rp}")

    # 错误串: 保留成功前缀且不接受
    st, rb = _api(root, "/api/parse",
                  {"grammar": grammar("expression"), "mode": "SLR",
                   "input": "id + * id"})
    check("HTTP 错误串 status=error 且前缀 id +",
          st == 200 and rb["status"] == "error"
          and rb["error"]["symbol"] == "*" and rb["error"]["prefix"] == ["id", "+"],
          str(rb)[:200])
finally:
    if _server is not None:
        _server.terminate()
        try:
            _server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _server.kill()


# ---------------------------------------------------------------------------
# 10. 前端失效规则(若存在 node)
# ---------------------------------------------------------------------------
section("前端纯逻辑与失效规则")

node = shutil.which("node")
if node:
    proc = subprocess.run([node, "tests/frontend.test.js"],
                          cwd=os.path.dirname(os.path.abspath(__file__)),
                          capture_output=True, text=True)
    ok = proc.returncode == 0
    check("node 前端自测通过", ok, proc.stdout + proc.stderr)
    if not ok:
        print(proc.stdout)
        print(proc.stderr)
else:
    print("   (跳过 node 前端测试: 未找到 node)")


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
print()
if _failures:
    print(f"失败 {len(_failures)} 项, 通过 {_passed} 项:")
    for name, detail in _failures:
        print(f"  [FAIL] {name}  {detail}")
    sys.exit(1)
print(f"全部通过: {_passed} 项断言")
