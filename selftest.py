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

# 回归: 曾因"终结符被当作可空符号"导致的伪冲突。
# S→A B | a, A→a, B→b: 没有任何 ε 产生式, nullable 必须为空,
# FIRST(S)={a}, FOLLOW(A)={b}, 两种模式都无冲突, a 与 a b 都应被接受。
pseudo = {"version": 1, "name": "伪冲突回归", "start": "S", "terminals": ["a", "b"],
          "productions": [
              {"id": "p1", "lhs": "S", "rhs": ["A", "B"]},
              {"id": "p2", "lhs": "S", "rhs": ["a"]},
              {"id": "p3", "lhs": "A", "rhs": ["a"]},
              {"id": "p4", "lhs": "B", "rhs": ["b"]}]}
for pseudo_mode in (L.MODE_SLR, L.MODE_LR1):
    pt = L.build_table(pseudo, pseudo_mode)
    check(f"[{pseudo_mode}] 无 ε 产生式时 nullable 为空",
          pt["nullable"] == [], str(pt["nullable"]))
    check(f"[{pseudo_mode}] FIRST(S)={{a}}(不得混入 ε/*/+)",
          pt["first"]["S"] == ["a"], str(pt["first"]["S"]))
    check(f"[{pseudo_mode}] FIRST(A)={{a}}, FIRST(B)={{b}}",
          pt["first"]["A"] == ["a"] and pt["first"]["B"] == ["b"],
          f"{pt['first']['A']} {pt['first']['B']}")
    check(f"[{pseudo_mode}] FOLLOW(A)={{b}}, FOLLOW(B)={{$}}",
          pt["follow"]["A"] == ["b"] and pt["follow"]["B"] == [L.END],
          f"{pt['follow']['A']} {pt['follow']['B']}")
    check(f"[{pseudo_mode}] 状态3 的 $ 格只有 r2(不是 r2/r3 伪冲突)",
          pt["states"][3]["action"].get("$") == [{"type": "reduce", "production": 2}],
          str(pt["states"][3]["action"].get("$")))
    check(f"[{pseudo_mode}] 无任何冲突", pt["conflicts"] == [], str(pt["conflicts"]))
    check(f"[{pseudo_mode}] a 被接受", L.parse(pt, "a")["status"] == "accepted")
    check(f"[{pseudo_mode}] a b 被接受", L.parse(pt, "a b")["status"] == "accepted")
    pa = L.parse(pt, "a a")
    check(f"[{pseudo_mode}] a a 出错但保留成功前缀 ['a']",
          pa["status"] == "error" and pa["error"]["prefix"] == ["a"]
          and set(pa["error"]["expected"]) == {L.END, "b"},
          str(pa.get("error")))

# 回归: 表达式文法终结符绝不能被当成可空符号
check("表达式文法 nullable 为空(E/F/T 都不能推出 ε)",
      expr_s["nullable"] == [], str(expr_s["nullable"]))
check("FIRST(E)=FIRST(T)=FIRST(F)={id,(}(不含 + * ε)",
      expr_s["first"]["E"] == ["(", "id"]
      and expr_s["first"]["T"] == ["(", "id"]
      and expr_s["first"]["F"] == ["(", "id"],
      f"{expr_s['first']['E']} {expr_s['first']['T']} {expr_s['first']['F']}")

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

# 间接可空(多层依赖): S→A B, A→C, C→ε, B→D, D→d
# C/A 可空但 B 链路上有终结符 d → B、S 不可空; 终结符切断可空传播。
ind = {"version": 1, "name": "间接", "start": "S", "terminals": ["d"],
       "productions": [
           {"id": "1", "lhs": "S", "rhs": ["A", "B"]},
           {"id": "2", "lhs": "A", "rhs": ["C"]},
           {"id": "3", "lhs": "C", "rhs": []},
           {"id": "4", "lhs": "B", "rhs": ["D"]},
           {"id": "5", "lhs": "D", "rhs": ["d"]}]}
it2 = L.build_table(ind, L.MODE_SLR)
check("间接可空: 仅 A、C 可空, B/S 不可空",
      set(it2["nullable"]) == {"A", "C"}, str(it2["nullable"]))
check("终结符切断: FIRST(S)={d} 无 ε",
      it2["first"]["S"] == ["d"], str(it2["first"]["S"]))
check("FOLLOW(A)=FOLLOW(C)={d}(A 后是含终结符的不可空 B)",
      it2["follow"]["A"] == ["d"] and it2["follow"]["C"] == ["d"],
      f"{it2['follow']['A']} {it2['follow']['C']}")

# 合法左递归: E→E a | ε
leftrec = {"version": 1, "name": "左递归", "start": "E", "terminals": ["a"],
           "productions": [
               {"id": "1", "lhs": "E", "rhs": ["E", "a"]},
               {"id": "2", "lhs": "E", "rhs": []}]}
lt = L.build_table(leftrec, L.MODE_SLR)
check("左递归可空: nullable={E}", lt["nullable"] == ["E"], str(lt["nullable"]))
check("左递归 FIRST(E)={a,ε}", set(lt["first"]["E"]) == {"a", L.EPS}, str(lt["first"]["E"]))
check("左递归 FOLLOW(E)={$,a}", set(lt["follow"]["E"]) == {"a", L.END}, str(lt["follow"]["E"]))

# 不生成句子的循环 A→A: A 不可空、FIRST(A) 为空, 不动点必须终止
cyc = {"version": 1, "name": "循环", "start": "S", "terminals": ["a"],
       "productions": [
           {"id": "1", "lhs": "S", "rhs": ["a"]},
           {"id": "2", "lhs": "A", "rhs": ["A"]}]}
cyt = L.build_table(cyc, L.MODE_SLR)
check("自循环 A 不可空", "A" not in cyt["nullable"], str(cyt["nullable"]))
check("自循环 FIRST(A) 为空且计算终止", cyt["first"]["A"] == [])

# 计算符号串 FIRST: 只能越过可空的非终结符前缀, 遇终结符即止
cg = L.Grammar(lt["grammar"])
cg.compute_attributes()
check("_first_seq 遇终结符停止",
      cg._first_seq(["a", "E"]) == {"a"})
check("_first_seq 越过可空非终结符但被其后的终结符截断(不残留 ε)",
      cg._first_seq(["E", "a"]) == {"a"}, str(cg._first_seq(["E", "a"])))
check("FIRST(β$) 末尾 $ 作为终结符计入, ε 被丢弃",
      cg.first_after(["E"], L.END) == {"a", L.END},
      str(cg.first_after(["E"], L.END)))

# ---------------------------------------------------------------------------
# 2b. 边界校验: 右部 8/9、终结符 30/31 —— 超限完整保留待修正输入, 禁止生成
# ---------------------------------------------------------------------------
section("右部/终结符边界(不裁剪)")

g8 = copy.deepcopy(grammar("expression"))
g8["productions"][0]["rhs"] = ["id"] * 8
check("右部 8 个符号合法", L.validate_grammar(g8)[1] == [])
g9 = copy.deepcopy(grammar("expression"))
g9["productions"][0]["rhs"] = ["id"] * 9
clean9, errs9, _ = L.validate_grammar(g9)
check("右部 9 个符号被拒", clean9 is None and any("右部最多 8" in e for e in errs9), str(errs9))
check("校验拒绝时原样保留 9 个符号(不裁剪)",
      len(g9["productions"][0]["rhs"]) == 9 and g9["productions"][0]["rhs"] == ["id"] * 9)

t30 = {"version": 1, "name": "t", "start": "S",
       "terminals": [f"t{i}" for i in range(30)],
       "productions": [{"id": "s", "lhs": "S", "rhs": ["t0"]}]}
check("30 个终结符合法", L.validate_grammar(t30)[1] == [])
t31 = copy.deepcopy(t30)
t31["terminals"] = [f"t{i}" for i in range(31)]
clean31, errs31, _ = L.validate_grammar(t31)
check("31 个终结符被拒", clean31 is None and any("1~30" in e for e in errs31), str(errs31))
check("31 个终结符原样保留", len(t31["terminals"]) == 31)
# 超限草稿在 build/parse 阶段同样被拒, 绝不返回"裁剪后有效"的表
try:
    L.build_table(g9, L.MODE_SLR)
    check("右部 9 个符号不能建表", False)
except L.GrammarError:
    check("右部 9 个符号不能建表", True)


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
# 9. 前端失效规则(若存在 node)
# ---------------------------------------------------------------------------
section("前端纯逻辑与失效规则")

node = shutil.which("node")
if node:
    def run_node(test_file, label):
        proc = subprocess.run([node, test_file],
                              cwd=os.path.dirname(os.path.abspath(__file__)),
                              capture_output=True, text=True)
        ok = proc.returncode == 0
        check(label, ok, proc.stdout + proc.stderr)
        if not ok:
            print(proc.stdout)
            print(proc.stderr)

    run_node("tests/frontend.test.js", "node 前端纯逻辑自测通过")
    # 页面级测试(真实 index.html + app.js, 仅注入可控 fetch): 需要本地 jsdom。
    jsdom_present = os.path.isdir(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_modules", "jsdom"))
    if jsdom_present:
        run_node("tests/page.test.js", "node 页面级回归(异步乱序/编辑边界/回放)通过")
    else:
        print("   (跳过页面级测试: 未找到 node_modules/jsdom; 可执行 npm i jsdom --no-save)")
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
