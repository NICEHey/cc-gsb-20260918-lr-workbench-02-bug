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
python3 selftest.py        # Python 核心算法 100+ 项断言; 检测到 node 时追加前端纯逻辑测试
node tests/frontend.test.js   # 只跑前端纯逻辑(项目合并/动作解释/回放/失效规则)
```

自测覆盖：两种算法的差异、nullable 多层传播、冲突单元格多动作保留、
规范 LR(1) 不把同 LR(0) 核心状态合并成 LALR、错误串定位与成功前缀、
空串接受与 ε 归约弹 0 项、草稿校验失败不改原对象、256 状态 / 2000 步上限、导出格式合规。

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
- **失效规则**：文法或模式一经修改，旧表立即标为过期并锁定单步 / 自动 / 导出，必须重新生成；
  输入修改只重置运行、保留有效表；自动执行中锁定文法与输入，暂停后可改；刷新页面不恢复旧表与旧运行。
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
selftest.py               可执行自测(含前端 node 测试)
tests/frontend.test.js    前端纯逻辑断言
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
