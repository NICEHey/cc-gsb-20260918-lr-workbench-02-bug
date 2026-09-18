# 文法文件 v1

草稿恰有 `version`（固定 1）、`name`（1～80 字符）、`start`、`terminals`（1～30 个唯一字符串）、`productions`（1～40 项）。每个产生式恰有 `id`（1～40 字符，唯一）、`lhs`（一个符号）、`rhs`（0～8 个符号的数组）。符号用 `[A-Za-z_][A-Za-z0-9_]*` 或单个 `+ * = ( ) - /`；符号 `$`、`ε`、`@START` 保留，禁止出现在输入草稿。非终结符为所有 lhs 的集合，必须与 terminals 不相交，start 必须是其中之一；rhs 的每个符号都属于这两组之一。相同 lhs/rhs 的重复产生式拒绝，即使 ID 不同。符号区分大小写。未知字段、类型错误、缺失字段整体拒绝；不可达/不生成句子的非终结符允许保留，可以警告，不自动改写文法。

样例目录 grammars.json 的 cases 项为 `{key,label,grammar,input}`，input 是用空白分隔的终结符字符串，实际草稿导入的是 grammar。

内部增广产生式编号 0 为 @START → start，原始产生式按文件顺序编号 1…N。状态编号必须按提示词约定的 BFS 分配。SLR 项目是 `(production,dot)`，LR(1) 项目是 `(production,dot,lookahead)`。

分析表导出 JSON 顶层至少含 `version:1`、`mode`（SLR 或 LR1）、`grammar`（完整原始草稿）、`nullable`（非终结符数组）、`first`、`follow`、`states`、`conflicts`。FIRST 空串用 ε，FOLLOW 结束符用 $；这些集合数组按 Unicode 码点排序。

每个 state 有 `id`、`items`、`transitions`、`action`、`goto`。items 项有 production、dot，LR1 另有 lookahead（单个字符串）；SLR 不带 lookahead。transitions 为符号到状态 ID 的映射；action 为终结符（含 $）到候选动作数组的映射。动作格式 `{"type":"shift","to":4}`、`{"type":"reduce","production":3}`、`{"type":"accept"}`。即使无冲突也用数组。goto 为非终结符到状态 ID 的映射，不含 @START。不存空 ACTION 单元。

conflicts 每项至少含 `state`、`symbol`、`kind`（shift/reduce、reduce/reduce 或 accept/reduce，多种同时存在分别记录）、`actions`（该格的全部候选动作）。任何含多个不同动作的单元格均为冲突，禁止启动输入分析，不得让 accept 覆盖 reduce。例如合法文法 S→S | a 在 $ 上可同时有 accept 和 S→S 的 reduce，必须保留。表有冲突依然允许导出，不能把有冲突和生成失败混为一谈。
