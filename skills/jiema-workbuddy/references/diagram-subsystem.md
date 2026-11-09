# DIA：统一图稿子系统

阶段仅引用mode-routing.json的DIA.DRAFT/DIA.SAVE。三目标、源码图文与独立补图共用本方法；七类手工图及派生ER，不再为设计图复制保存流程。

## 依据与准备

1. 读取原projectId/designRevision和实际目标。需求/SQL只要图使用basis=design；已有源码与完整系统使用basis=source。独立diagram-only可以指定design/source，必须原项目身份，不新建。
2. design读取原始需求/SQL、用户真实决定、业务规格及project_show结构快照。来源分provided/derived/proposed/confirmed；模型建议不能标用户确认。只有需求时类/时序/架构表达明确设计，不虚构已存在源码或已运行接口。
3. source先写完全部项目内交付、冻结local_snapshot，读真实结构/调用链/权限与状态；系统目标先完成HARD。原项目外编写图稿和证据。源码文档五份文档也在项目外。
4. 按[事实合同](generated-admin-hardening/references/diagram-facts-contract.md)写schemaVersion 3的diagram-drafts.json；七类非空行引用事实、核心场景覆盖、五项自审与身份差异齐全。运行scripts/diagram-facts.mjs只证明一致性，返回unverified，不证明业务语义/运行。

## 保存与回读

每类先diagram_status。正文新增/变化用diagram_apply；准确的既有source正文可diagram_bind_source。design不传localDirectory、不调用源码绑定；同正文同版本已确认可复用既有真实保存回执。架构figureId从project_show读取。规范角色与用例使用稳定身份，manual扩展不增加权限，不猜同名端点。

每类保存一份完整图族，不循环逐图POST冒充原子应用。整套七类不是一个事务，失败保留成功图种；不为设计分支另外实现bundle循环。若用户明确要求提前设计草稿，可用既有diagram_bundle_apply，最终证据仍逐类核验。

回执diagram-saved.json使用schemaVersion:2，含projectId/designRevision/basis/diagrams/er：
- diagrams恰好七类，各有kind/status/method:diagram_status/revision/sourceFingerprint/commandBatchId/textSha256/savedAt/readAt/saveReceipt{revision,sourceFingerprint}；保存回执与当前回读逐图匹配，不能要求七图指纹相等。可取得availability时必须available=true。
- source另有顶层sourceSha256与finalSnapshot{method:local_snapshot,sha256,readAt}；各图sourceMatch=current且localSourceSha256相同，最后再取快照。源码绑定由客户端报告，不认证运行。
- design另有designSha256，与事实报告中的冻结project_show快照SHA一致。projectReadback.before/after含method:project_show/projectId/designRevision/designSha256/readAt，前后回读覆盖全部保存过程，设计结构/权限不得变化。不填sourceMatch或源码摘要。project_show的稳定设计内容按同一序列化保存快照，不把临时读取时间混入摘要。
- er含status/method:diagram_status/fromDesignRevision/entityCount/fieldCount/relationCount；同时保留project_show实体、字段、关系逐项对照，逐条名称审核复用[事实合同](generated-admin-hardening/references/diagram-facts-contract.md#er-关系审查)。数量相同或画面可见不能代替结构和业务语义一致。
- 原始接口回执在项目外保留并引用；正文hash来自实际提交文本。无回执不可手写passed。

保存用例后再次回读功能结构投影；function-structure.readAt不早于use-case.savedAt。FUNCTION_STRUCTURE_PROJECTION_UNAVAILABLE属于服务端投影问题：已复现manual端点被误当规范授权；与同名快填歧义区分。保留诊断、版本、正文及成功图种，产品修复后仅回读/重试受影响图，不换措辞、不重建收费项目。

ER只从在线结构派生，不提交正文。full必须对照最终数据库/ORM结构；有变化使用既有受支持原生编辑同步后回读；无法同步就该项blocked，不能伪造一致、另建项目或改源码去迁就旧ER。

接口回读后按[browser-handoff](browser-handoff.md)刷新原项目右侧标签页；网页可见与API保存分别取证。缺能力记unverified，不能用外部浏览器替代；图稿失败不撤销HARD结果。

## 失效与恢复

设计事实/设计版本或source摘要变化，重做受影响事实与图稿；数据重建先重跑受影响业务验收。正文变化也必须重新核对事实。冻结后不往项目内补文件。失败记录stage/kind/diagnostic/commandBatchId/expectedRevision/sourceFingerprint/成功图种/精确下一动作；超时同ID先回读，409合并最新人工编辑后新批次；同因三次无进展blocked。

旧H8/C6在原项目原批次续跑。旧schema仅按legacy/unverified保留，不追认新版通过；重做DIA.DRAFT后必须新事实合同。默认目标均按当前证据门禁交付。
