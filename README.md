# LR 文法冲突定位与逐符号分析工作台

在同一个界面里比较一份文法在 **SLR(1)** 与 **规范 LR(1)（canonical LR(1)）** 下的真实表现：
真实计算 nullable / FIRST / FOLLOW，真实构造 LR(0) / LR(1) 项目集族与 ACTION/GOTO 表，
解释每个表项背后的项目，并对输入串执行逐符号移进-归约分析。

- 纯 Python 标准库服务器 + 原生 HTML/CSS/JavaScript
- **无第三方包、无 CDN、无外部服务、无预置图片**，所有图示均由算法结果实时渲染
- 服务器不保存任何业务数据；草稿/模式/输入只存浏览器 localStorage

## 运行

```bash
python3 server.py                       # 默认 http://127.0.0.1:8080/
python3 server.py --host 0.0.0.0 --port 8000
python3 server.py --help
```

要求 Python 3.8+（开发于 3.11）。打开浏览器访问启动时打印的地址即可。

## 自测

```bash
python3 selftest.py              # Python 核心 150+ 项断言; 有 node 时追加前端纯逻辑测试,
                                 # 另有 node_modules/jsdom 时再追加页面级回归
node tests/frontend.test.js      # 前端纯逻辑: 项目合并/动作解释/回放/失效规则/请求身份/编辑边界
node tests/page.test.js          # 页面级: 真实 index.html+app.js(jsdom), fetch 走 tests/py_bridge.py
                                 #          调真实后端, 返回时机/顺序由测试确定性控制
```

> 页面级测试需要 jsdom：`npm i jsdom --no-save`（仅此一个开发依赖，不影响纯标准库运行时）。

自测覆盖：两种算法的差异、nullable 多层传播、冲突单元格多动作保留、
规范 LR(1) 不把同 LR(0) 核心状态合并成 LALR、错误串定位与成功前缀、
空串接受与 ε 归约弹 0 项、草稿校验失败不改原对象、256 状态 / 2000 步上限、导出格式合规；
前端额外覆盖右部 8/9 与终结符 30/31 编辑边界、建表/分析请求的过期成功·失败·乱序、
前进—回退—再前进、自动暂停后改输入、无效 JSON 导入不破坏既有草稿/表/轨迹。

### 本次修复（界面文法、分析表与执行轨迹一致性）

1. **nullable/FIRST/FOLLOW**：旧实现在判定右部可空时把**终结符也当作可空符号**，
   于是 `E/T/F` 被误判可空、`FIRST(E)` 混入 `+ * ε`，并在无空产生式的
   `S→AB|a, A→a, B→b` 上凭空造出状态 3 的 `$: r2/r3` 伪冲突。现改为：
   从“实际能否推出空串”求不动点；终结符不可空也不可越过；符号串 FIRST 只越过**可空非终结符**前缀；
   FOLLOW 仅当某符号之后的后缀整体可空才继承左部 FOLLOW；规范 LR(1) 的 `FIRST(βa)` 同样处理。
   复现：`python3 -c "import lr_core as L; ..."`（见 `selftest.py` 中“伪冲突回归”一节）。
2. **超限不裁剪**：右部第 9 个符号、第 31 个终结符过去被 `.slice()` 静默截掉，
   导致“界面一份文法、后台另一份”。现完整保留待修正输入，由校验明确报错并锁定生成，
   修正到 8/30 以内即可正常生成；页面显示、接口结果与导出 JSON 恒为同一份完整草稿。
3. **请求生效规则**：为建表与分析各设单调纪元（epoch）台账并中止旧请求；
   文法/模式改动作废旧表与旧运行（并中止两类请求），输入改动只重置运行、保留有效表。
   响应接收端同时核验**票据身份**与**内容身份**（草稿指纹+模式；分析还含输入），
   任何过期成功、过期失败或旧请求的收尾都不落库、不解锁、不覆盖新状态。
4. **回放结论按当前位置**：刚载入轨迹（第 0 步）显示“待执行”，只有真正走到最后一步才显示
   已接受/出错/超步终止；后退离开 accept 步恢复“执行中”，错误串与 2000 步上限绝不显示为接受。

## 页面三部分

1. **文法**：名称、开始符号、终结符列表、有序产生式（唯一 ID / 左部 / 右部，右部留空即 ε）。
   可增删、上下移动产生式；一键载入 `fixtures/grammars.json` 样例；按 `fixtures/format.md`
   导入 / 导出草稿 JSON。校验失败（符号重名、未知符号、重复产生式、保留符号、缺失开始符号、
   未知字段等）时**保留现有草稿、有效表与轨迹不变**。左递归与空产生式是合法能力。
2. **项目集族与分析表**：nullable / FIRST / FOLLOW；状态从 0 起按 BFS 编号、
   待转移符号按 Unicode 码点排序；增广产生式 `0: @START → 开始符号` 自动加入但不写回草稿。
   可滚动、可筛选查看全部状态；转移可点击跳转；ACTION 单元格可点击查看导致该动作的项目——
   SLR 归约明确指出 **`symbol` 属于 FOLLOW(LHS)**，LR(1) 归约明确指出 **项目携带的展望符**。
   同一 LR(0) 核心的多个展望符合并显示，导出 JSON 仍逐个还原。
3. **执行轨迹**：输入为空白分隔的终结符序列（无词法分析；空输入合法；`$` 由程序追加，禁止手输）。
   支持开始 / 前进一步 / 后退一步 / 自动执行（定时器，不阻塞页面）/ 暂停 / 复位，
   每行轨迹展示执行前后的状态栈、符号栈、剩余输入与动作；归约按右部长度弹栈，ε 归约弹 0 项后查 GOTO。

## 关键语义

- **冲突不靠任何规则掩盖**：同一 ACTION 单元格中多个不同动作全部保留并去重，
  分类为 shift/reduce、reduce/reduce、accept/reduce；不按优先级、产生式顺序或“默认移进”消歧。
  只有增广开始项目完成且当前符号是 `$` 才产生 accept，普通产生式完成不会误判成功。
- **有冲突 = 禁止启动分析**，但仍可查看与导出分析表；生成失败（如超 256 状态上限）与“有冲突”严格区分，
  超限时返回明确错误而非截断的“成功”表。
- **失效规则**：文法或模式一经修改，旧表立即标为过期并锁定单步 / 自动 / 导出，必须重新生成，
  同时中止在途的建表/分析请求，旧响应回来也不覆盖；输入修改只重置运行、保留有效表（仅中止分析请求）；
  自动执行中锁定文法与输入，暂停后可改；刷新页面不恢复旧表与旧运行（但会原样保留仍在编辑的超限草稿以便修正）。
- 输入上限 200 token、自动执行上限 2000 步（超限报告终止，不伪装为接受）；
  缺失 ACTION 时停在出错位置，列出当前状态可以接受的终结符并保留成功前缀。

## 内置样例（fixtures/grammars.json）

| key | 用途 |
|---|---|
| `expression` | E→E+T\|T，T→T*F\|F，F→(E)\|id；两种模式均无冲突；`id + id * id` 接受，`id + * id` 报错 |
| `assignment` | S→L=R\|R，L→*R\|id，R→L；**SLR 冲突、LR(1) 无冲突**，LR1 下 `id = id` 接受 |
| `ambiguous` | S→SS\|a：两种模式都必须报 shift/reduce |
| `reduce-reduce` | S→A\|B，A→a，B→a：reduce/reduce |
| `nullable` | A、B 可空：空串真正接受并展示 ε 归约 |
| `unmerged` | 构造出同 LR(0) 核心、不同展望符的不同 LR(1) 状态，验证未被偷偷合并成 LALR |
| `accept-reduce` | S→S\|a：`$` 格同时存在 accept 与 reduce，两者都保留 |

## 目录

```
server.py                 标准库 HTTP 服务 + API(/api/validate /api/build /api/parse)
lr_core.py                校验、nullable/FIRST/FOLLOW、SLR、规范 LR(1)、表驱动分析
index.html app.css app.js 页面三部分与交互
core.js                   前端纯逻辑(无 DOM 依赖), 同时供 node 自测
selftest.py               可执行自测(Python 核心 + 前端 node 测试)
tests/frontend.test.js    前端纯逻辑断言(回放/失效/请求身份/编辑边界)
tests/page.test.js        页面级回归(真实页面 + 可控 fetch 时序)
tests/py_bridge.py        页面测试调用真实 lr_core 的同步桥
fixtures/format.md        草稿与分析表 JSON 格式契约(v1)
fixtures/grammars.json    样例文法
```

## HTTP API

| 接口 | 请求体 | 说明 |
|---|---|---|
| `POST /api/validate` | `{grammar}` | `{valid, errors, warnings, clean}`，失败不改调用方数据 |
| `POST /api/build` | `{grammar, mode}` | `mode` 为 `SLR` / `LR1`；返回完整分析表（有冲突也返回） |
| `POST /api/parse` | `{grammar, mode, input}` | 返回逐步轨迹；冲突表拒绝分析，未知符号开始前报错 |

分析表 / 草稿 JSON 的字段与编号约定严格遵循 `fixtures/format.md`：
增广产生式编号 0、原始产生式 1…N 保持草稿顺序；SLR 项目 `(production,dot)`，
LR(1) 项目 `(production,dot,lookahead)`；ACTION 恒为候选动作数组，不存空单元。
