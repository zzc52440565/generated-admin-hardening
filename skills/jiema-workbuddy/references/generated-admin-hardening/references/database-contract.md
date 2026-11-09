# 数据库重设计与证据合同

本页是数据库方法的唯一正文。阶段身份、顺序、产物由主技能 `mode-routing.json` 维护；公开开发口令与操作键约定只读取主技能 `conventions.json`。不得把脚手架随机数据当作验收载体。

## 设计与执行顺序

差距盘点后、页面改造前完成结构复核、对象与查询设计、数据规格及全量重新生成。结构可以保留，但表、列、键、基础约束须逐项给出与真实业务一致的依据；索引按真实过滤、连接、排序、唯一性和执行计划重评。演示和测试数据全部重新生成，禁止沿用 autoData、仅补几行或批量 UPDATE 状态冒充业务动作。

先实现数据生产所需的业务接口/事务及调用方，再用这些接口产生状态覆盖数据，导出唯一完整安装脚本。这属于数据库阶段的必要依赖，不等待页面美化。应用尚不能产生某个状态时先修业务实现，不能伪造状态来通过门禁。

对象清单 `docs/sql-object-inventory.json`：`schemaVersion:1`、`objectsVersion`、`objects[]`，每项含 `id/type/name/decision/reason/source`。类型覆盖 table、column、key、constraint、index、view、procedure、function、trigger、query；处置为 retain/refactor/remove/add。每个类别必须有对象或 `absentTypes[{type,reason}]`。高级对象另含 `databaseReason`、`responsibility{writer,reader,doubleWrite,locking,deadlock,test,rollback}`；没有数据库承担的理由就不建。触发器不得做外部通知、HTTP、支付、长事务；引擎不支持时给明确替代方案。

query 项必须有 `sql`、`pageEntry`、`indexes[]` 和 `evidence`：覆盖检索、详情、统计、报表、联表、分页与导出，每条登记实际调用方。无索引合理时给 `scanReason`，不强迫小表使用索引、不用 FORCE INDEX 制造优化证据。每条实跑 EXPLAIN 与结果样例，明确实际 usedIndexes，不能用 possible_keys 代替实际 key。

## 数据规格

`docs/seed-data-spec.json` 使用 `schemaVersion:1`、`dataVersion`、`rebuiltAt`、`origin: business-redesign`、`scaffoldRowsRetained:0`、`accounts[]`、`stateMachines[]`、`samples[]`、`fixtures[]`、`coverage[]`、`sourceDigests`。

- accounts：`role/username/passwordPolicy`（固定引用 `localDemo.password`）、`encoderSource`、`evidence`。每个登录角色至少一账号。用应用真实 PasswordEncoder/Hasher 编码；不改算法、不写明文、不加认证后门。配置、种子、测试、交付四处读取同一约定并真实核对。已有数据库管理员密码不在本合同改写范围。
- stateMachines：`entity/states[]/source`；枚举来自实际业务状态机。每状态至少一条记录，`samples` 中对应 `category:state/entity/state/recordId/purpose/producer/evidence`。`purpose` 为 demo 或 acceptance，同一实体+记录 ID 不得跨用途复用。
- samples 五类必须覆盖 state、boundary、conflict、empty、isolation。每项均有 `id/purpose/producer/evidence`；边界覆盖上下限、唯一冲突、长文本、空与零；冲突覆盖重叠、并发审批、重复提交与占用后取消；空态覆盖新用户、角色无数据与筛选无结果；隔离用 A 用户数据给 B 用户访问并期待 4xx/空集。不适用的具体子场景给业务依据。
- coverage：细分场景以检查器导出的 requiredCoverage 为唯一列表；每项 category/case/status，tested 关联 sampleIds（真实验收样本），not-applicable 必须 reason/source 业务依据。只有五类标签而缺具体冲突/边界不能通过。
- producer：`method:business-api|browser|seed|fixture`、`action`。状态证据必须 business-api/browser，保留接口/页面前后状态、实际响应与记录 ID。纯展示/历史可用 fixture，必须 `fixture:true/reason/scope`，不得计入提交、审批、拒绝、取消、完成的动作通过数。
- fixtures 逐条登记 `entity/recordId/fixture:true/reason/scope/countsAsActionEvidence:false`；多条记录逐条列出。SQL 布置的历史记录即使后来调用真实接口，也不能计入状态覆盖或动作验收；检查器按记录身份与 samples、回执交叉核对，不能靠省略后续回执的 fixture 标记洗白。需要时间推进的真实状态链，可在独占本地验收配置中注入应用时钟，默认配置仍使用系统时间；从创建开始全程走业务接口，记录时钟配置、进程重启与前后状态，明确受控时间验证范围，不改操作系统时间、不放宽规则、不增加 HTTP 后门。
- 列表足以翻页、统计有意义即可；不追求随机大数据。`boundary/pagination` 用独立验收样本在真实页面切换第一页、第二页；回执含 `pagination{queryId,pageEntry,pageSize,total,pages:[{page:1,recordIds:[...]},{page:2,recordIds:[...]}]}`，关联对象清单中的实际查询及同一页面入口。两页在相同筛选/排序与稳定数据下读取，记录身份不重复，行数与总数/页大小一致；前端切片须明确，不能假称服务端分页。没有分页控件不属于已验证，不得以「数据少」跳过本要求；纯非列表交付才能给可核对的不适用依据。统计回读真实结果，不为非零造数。原脚手架记录特征/主键与新记录对照保存在重建回读中，不能只扫描字符串 autoData 就宣称无残留。

## 交付和回读

`docs/db-redesign.md` 记录保留依据、对象责任、数据与查询决策、安装/恢复方式。`database.sql` 是唯一完整空库安装入口：文件头标 dialect/server-version/client/empty-database，结构、重新生成的数据及必要对象按实际依赖排序。清除原硬编码库名、DEFINER、路径、演示账号；不要写 DROP DATABASE 或无条件全表清空来掩盖升级。已有 migration 保留正式职责，不作为第二份安装入口。

`docs/db-verification.json`：`schemaVersion:1/dataVersion/objectsVersion/sqlSha256/sourceDigests/testedAt`，以及 `checks[]`、`tableReadbacks[]`、`objectReadbacks[]`、`queryReadbacks[]`、`accountReadbacks[]`、`scaffoldComparison`。每份证据含 `status:passed|failed|unverified/method/testedAt/dataVersion/expected/actual` 与非空命令或请求回执；不得含 token、Cookie 或真实密码。

- checks 必须覆盖 structure、objects、data、queries、passwords、empty-install。structure 回执必须提供真实系统目录查询得到的完整 `columns[{table,column}]`（含框架保留表）；对象清单列名统一 `表名.列名`，逐项登记保留依据，两者双向一致。仅列总数或选取少数重要字段不能通过。空库导入回执先确认目标确为空；禁止操作未知已有库。
- tableReadbacks：各表 count、状态分布及 SQL 输出引用。objectReadbacks：对象存在性、签名、实际调用或触发回执；remove 对象核对确已不存在。
- queryReadbacks：queryId、SQL 对应摘要、实际 EXPLAIN、usedIndexes、结果样例，引用有界执行回执。无运行能力标 unverified。
- accountReadbacks：每个账号的应用编码器 matches 校验与真实登录分别有证据，期望身份/角色正确；浏览器与接口分别标 method。
- scaffoldComparison：来源清单与重建前/后的数据摘要、残留数量、判定 SQL 与回执，残留必须为零。不能仅手写零。

`scripts/check_database_redesign.mjs --project-root <目录>` 仅校验证据一致性，返回 `consistency:valid` 不表示真实数据库通过。真实通过须由执行者运行目标数据库、应用编码器和真实接口/页面取证。

## 版本与失效

任何重建更新 dataVersion；对象变化更新 objectsVersion；database.sql/业务数据生产与查询代码摘要绑定报告。进入业务验收前必须通过数据库门禁。角色结果、页面审计、运行复审、最终事实均保存 databaseBinding（两版本、sqlSha256）；重建后旧绑定、截图和操作记录立即失效，回到受影响验收重跑。冻结后所有回读放项目外；不得通过重写摘要来继承旧验收。

旧检查点迁移保留原项目、费用身份和图稿阶段，可从失败图种续跑；旧数据库证据只按原版本保留，v13 数据库闭环标 unverified，补做新门禁前不能宣布新合同全通过。
