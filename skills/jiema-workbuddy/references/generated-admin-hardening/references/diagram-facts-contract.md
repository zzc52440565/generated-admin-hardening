# 图稿事实审核合同

此文件负责事实证据；原生语法归各分图指南及其唯一 `.txt` 示例，阶段真值归主技能 mode-routing.json。三目标中需要图稿的路径、源码文档与diagram-only使用同一合同；basis区分design/source。

## 必须先做的分析

design依据读取用户需求/SQL原件、关键决定、业务规格和在线设计快照。逐元素标明原始事实、必然推导、模型建议或用户确认；设计类/消息/架构可表达明确方案，但不能称已在代码实现或运行。相同场景覆盖和五项自审仍必需。

source依据读取最终源码的入口、路由/页面、后端角色及数据范围、实体与关系、状态转换、事务/锁/幂等、查询与导出、依赖与启动配置。登记核心场景清单，包含失败、空态、越权与冲突路径；只读或没有事务时写清不适用依据。不按表自动复制 CRUD，不只画最容易的场景。

每个节点、成员、关联、消息、条件、分支和数据流都要能解释“哪个事实支持这句话”。未知、计划中和仅教学内容不进入实际实现图；源码注释与执行代码冲突时以执行代码为准并记录冲突。不得为图好看增加不存在的类/调用/权限。代码可证明实现，真实接口/页面回执才可证明运行；二者分别记录。

八类审查：功能/用例核对后端权限和稳定身份；类图核对字段类型与关系理由；时序核对真实调用顺序、失败、事务和异步；流程核对分支闭合、状态前置条件和结束；DFD核对真实读写与父子边界；架构核对装配部署与组件职责；ER核对结构版本及实际模型差异。不能把投影失败归咎于正文措辞而反复试。

## 项目外的 diagram-drafts.json（schemaVersion 3）

共有字段：`schemaVersion:3`、`projectId`、`designRevision`、`basis:design|source`。source要求`projectRoot`（绝对路径）与`sourceSha256`（local_snapshot冻结摘要）。design要求`evidenceRoot`与`designSnapshot{file,sha256}`，快照包含projectId/designRevision/design{entities,relations}，来自真实project_show；禁止填源码摘要。JSON 和七份正文都在原项目外同一个交付目录内；冻结后不再往项目内补文档。

| 字段 | 必填结构 | 约束 |
| --- | --- | --- |
| sources | `{id,path,sha256,symbol,startLine,endLine,excerpt}[]` | path为source为项目相对路径；design为evidenceRoot相对路径并含kind:requirement|sql|decision|specification|project-design（不要求symbol）。均拒绝越界/符号链接逃逸，SHA及连续行摘录必须一致；不收集密钥 |
| facts | `{id,claim,sourceIds:[id]}[]` | 明确事实陈述与支持的事实引用，不把整个项目名当依据 |
| diagrams | `{kind,file,sha256,lines:[{line,factIds,reason}]}[]` | 七类恰好各一份；file相对报告目录，逐个非空行恰有映射；标题/分节引用所概括的事实；每条边引用两端及关系事实 |
| scenarios | `{id,name,factIds,coverage,review}[]` | 按真实核心入口登记；每个覆盖时序、系统流程和DFD |
| scenarios.coverage | 三个键：`system-sequence`、`system-flowchart`、`data-flow`，值 `{lines:[正文行号],reason}` | 可以合并表达原子只读场景，必须指向实际正文并解释为何充分 |
| scenarios.review | 五个键：`authorization/success/failure/concurrency/transaction`，值 `{factIds,reason}` | 读写、错误、并发、事务全部检查；不适用必须有所选basis的事实依据，不留空 |
| authorization | `{identityPolicy:"stable-id-only",factIds,designDifferences:[]}` | 差异项 `{description,treatment,factIds}`；确认无差异才用空数组 |
| er | `{basis:"project-design",designRevision,factIds,comparison,relations}`；source另含`projectReadback{file,sha256}` | source回执文件相对报告目录且在项目外；design复用顶层designSnapshot。两者均来自project_show并匹配项目/版本；relations逐条审查，格式见下文 |

举例：某条“强制本人过滤”正文的事实应指向业务查询中 `customerId = session.userId` 的实际方法与摘录；只引用前端菜单配置不够。数据流“订单记录写入”应指向实际INSERT/ORM保存及事务边界；只引用表声明不够。事实门禁验证摘录真实存在，Agent仍须判断它是否充分支持陈述。

主技能命令：`node scripts/diagram-facts.mjs /绝对路径/diagram-drafts.json`。输出 `consistency:valid,status:unverified` 只说明引用/文件/覆盖结构一致，**不是语义正确或运行通过**。禁止改成 passed。正式解析、真实保存、网站回读另写 diagram-saved.json，并按来源标 passed/failed/unverified。语法错误由服务端原生解析器返回，模型按错误位置自修；宿主没有解析能力时不能捏造本地解析通过。

该门禁检查：路径/摘录/哈希、七图逐行事实引用、三类场景覆盖、五项自审、权限身份策略及 ER 版本和逐关系回执，并拒绝直接照搬随包正文。它不能识别所有换词抄例或错误业务解释；Agent必须逐项自审，不以检查器代替业务分析。

## ER 关系审查

关系 `id` 是稳定身份；`name` 是菱形业务谓词，使用 2～12 个汉字，优先简短准确。“提交”“审批”“申请使用”“归属”是有明确事实时的示例；禁止技术键、外键列名、“关联/对应关系”占位词和重复端点的完整句。合法谓词可能与实体同名（如“回复”），不能机械删改。不要为换名字修改关系 ID、权限路径、外键或基数；也不能在不存在的 `nameCh` 字段填中文后保留错误 name。

每条在线关系恰有一项 `er.relations`：`{id,name,sourceEntityId,targetEntityId,sourcePropertyId,cardinality,keyPairs:[{sourcePropertyId,targetPropertyId}],nullability:[{sourcePropertyId,nullable}],readingDirection,meaning,factIds}`。身份、名称、端点、基数、完整外键组与真实快照逐项相同；物理关系的可空性从源字段 `required` 回读。`readingDirection` 为 `source-to-target` 或 `target-to-source`，标明业务句的阅读方向，不改变物理引用方向。meaning写出完整业务句、数量和状态条件，factIds引用真实业务依据。没有物理外键的关系 keyPairs/nullability为空，说明其业务依据，不能为过门禁虚构字段。

校园预约示意：`Booking.roomId → Room.id` 命名“申请使用”（申请可能被拒绝，不能写“占用”）；`Booking.studentId → Student.id` 命名“提交”，业务句为“学生提交预约申请”，阅读方向 target-to-source；`Booking.reviewerId → Admin.id` 命名“审批”，明确待审时审批人为空。“属于同一学生”只说明归属，不能代替提交/审批职责分析。教学完整格式见[ER 示例](../assets/quick-fill-examples/08-er-readback.example.json)，不可复制为其他项目事实。

建项前审查候选关系名，建项后逐条回读。DIA.DRAFT 和交付门禁再次检查；仅图可打开、实体/关系数量相等、sourceMatch=current，都不能证明名称合理。需要修正已有名字时使用现有原生结构编辑，保留修改前后 project_show 及精确差异，刷新 ER 画面核对真实标签。名称变化导致设计版本/指纹变化时，重读受影响图种及证据；不要盲目重建、重生成或重绑全部图。

## 身份、失效与续跑

- 既有规范角色与用例按 stableId/授权关联匹配。新 manual/AI 节点是图稿表达，不增加规范权限；规范端点间未授权关联仍拒绝。游客、登录或新增设计/实现与 ProjectDesign 不一致时明确记录来源差异。
- 完整原样回填应为零命令；同名规范操作的真正修改出现歧义时不猜，不改名试探。保留正文、原 revision、commandBatchId 与诊断，定位需改的身份及产品能力。
- 冻结后源码、数据库对象/数据版本或正文变化：先标受影响证据失效；按影响重新验收，再重做事实索引、正文、local_snapshot、保存与回读。不可沿用旧截图或旧绑定。
- 新任务离开 DIA.DRAFT 和最终交付均重新检查事实。旧schema与H8/C6已完成草稿仅为续跑保留，缺少新合同的项明确 legacy/unverified；原ID和收费身份不变。重新生成草稿会取消旧豁免，必须按新合同完成。
- 同一图连续三次同因无进展记录 blocked；给出原ID、失败图种、错误、已成功图种、修复后首个读取动作。只重试失败图，不反复建项或重存全部图。
