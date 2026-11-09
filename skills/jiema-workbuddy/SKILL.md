---
name: jiema-workbuddy
display_name: 计算机毕设课设助手
display_name_en: CS Project Assistant
description: 从需求、SQL或已有源码交付整套八类图、可运行系统或两者全套；按用户目标自动分析、建项或复用、实施和验证。Use for project diagrams, runnable systems, or both from requirements, SQL, or existing source.
description_zh: 一个入口三种交付：只要图、只要系统、要全套。默认整套八类图；系统包含源码、本地运行与数据库业务验收；已有源码不默认重建。
description_en: Choose eight diagrams, a verified runnable system with source, or both. Reuse existing code unless rebuilding is explicitly requested.
version: 3.2.0
author: 捷码
examples_zh:
  - "这是预约系统需求，只要整套八类图。请分析业务和权限，按现有权益创建在线项目并保存图稿，不生成下载代码。"
  - "按这份 SQL 创建项目，只要系统和完整源码，不需要手工图稿；请在本机跑起来，完成数据库重设计和逐角色验收。"
  - "我要全套：分析需求、创建并生成系统、本机完成业务改造和验证，再按最终实现保存整套图。"
  - "这是已有项目源码，要系统和图全套。继续完善原项目，不重新生成；完成验收后将实际实现整理为在线图稿。"
examples_en:
  - "From these requirements, create an online project and all eight diagrams using my existing entitlement. Do not generate code."
  - "Import this SQL and deliver only the complete runnable system with source and business verification, without manual diagrams."
  - "Deliver both a verified runnable system and all eight diagrams matching the final implementation."
---

# 计算机毕设课设助手

一次请求在同一个 WorkBuddy 任务推进到所选成果。阶段结束立即继续，不要求另一条“继续”。只在本人登录/网页授权、真实付款、系统级安装或权限、关键业务事实及高风险歧义四类场景打断。默认最多三张原生选择卡，同一问题不重复问。

## 唯一合同与目标

实际读取 [机器合同](references/mode-routing.json)。阶段ID/名称/产物/工具/依赖/恢复只在合同定义，Markdown视图由同步器生成。输入路由与交付目标分开：需求、SQL、源码决定分析方式；target决定交付范围。以下是生成视图，不手改：

<!-- BEGIN GENERATED TARGETS -->
| 交付目标 | 执行能力 | 完成含义 |
| --- | --- | --- |
| 只要图（diagrams） | diagrams | 整套八类图；需求/SQL绑定设计事实，已有源码绑定真实实现，不生成下载或配置环境 |
| 只要系统（system） | generate、localRuntime、hardening | 完整源码、本地运行、数据库与业务改造及真实验收；不要求手工图稿 |
| 要全套（full） | generate、localRuntime、hardening、diagrams | 系统完整交付后，以最终实现制作八类图并核对在线ER一致 |
<!-- END GENERATED TARGETS -->

用户已说“只要图/只要系统/全套”就记录原话。未明确时只用一张原生三选一卡；不默认全套、不问图种，图稿默认八类。选择目标不等于获得未展示的收费范围或重建授权。仅请求只读分析采用preview；“只要图，不生成代码”仍是diagrams，不能误当preview。已有明确仅下载源码的范围可保留source-only，但不能说系统已验收。

## 输入与连续执行

先复用检查点：status，不重新init。补充说明、纠错和进度询问都保留原目标；回复后继续原计划。结束前执行 [连续执行协议的终点核验](references/automation-loop.md#结束前核验)，不能把补充事项完成当作整任务完成。多输入已有明确基线就沿用，仅高风险矛盾合并询问。普通选型用实时platform_catalog推荐并告知，不重复问已回答的事实。所有用户问题按questionKey＋scopeDigest去重，原生控件答复后自动接续。

需求/SQL先做业务、结构、权限及生命周期分析，按 [结构与权限](references/structure-and-permissions.md) 建立来源明确的设计。不要按表复制CRUD或放宽ALL来凑闭环。拒绝权限同样解释；真实RELATED路径、字段及服务端状态赋值须核对。登录面须confirmed/configuredSurfaces；READ只列必要readableFieldIds。SQL按 [SQL方法](references/sql-import-and-permissions.md) 两次正式预览、真实ID、有序全量decisions、同一fingerprint提交，不改计费入口。

需求/manual-structure只用entryMode=manual、design.source=manual、config.features.aiSqlData=false。WorkBuddy模型承担分析和图稿编写；不调用站内AI建项/优化/候选采纳，不新增MCP工具。

已有源码按 [源码方法](references/source-mode.md)：diagrams只分析；system/full使用reuse完善原项目；只有明确重建才rebuild，不能把“改造”解释为重新生成。已有明确在线身份用projectMode=reuse，只回读匹配与版本，不再创建。源码system不要求在线项目；源码full先验收冻结，再创建或复用图稿项目。

独立env-only/harden-only/diagram-only继续可用，复用同一方法，不增加第四个产品选项。diagram-only必须有原projectId，可按设计事实或原源码补图。

## 决定与计费

原始明确创建/生成且范围可知时复用原话，不再问创建。模糊“继续/好的/按推荐”不构成收费或重建授权。目标与关键事实尽量合并一张卡；创建/费用范围缺失才问；系统动作只有实际需要时才问，默认不超过三张。每批最多四题、每题二到四个互斥选项，推荐项说明依据，使用控件自带自由输入。

先connect_status复用授权，必要时按 [浏览器交接](references/browser-handoff.md) 自动打开本次授权页，由本人确认并回读。账户授权、业务决定和系统权限分别记录，不能互相替代。余额足够按已同意口径直接结算；只有402 insufficientCredits才本人充值/会员后复用原业务ID重试，不重复逐笔确认。

## 三种交付执行

只要图：业务设计/预检→授权及创建或复用→回读结构→DIA.DRAFT→DIA.SAVE→交付。需求/SQL使用design依据，已有源码使用source依据。七类手工正文与派生ER逐类核对；不生成下载、不进入ENV/HARD，不为满足检查器虚构源码。

只要系统：需要新源码时生成下载；已有源码直接进入ENV及HARD。读 [环境方法](references/dev-env-setup/WORKFLOW.md) 的实际依赖、诊断、兼容版本、计划和真实复验，已满足组件不重复安装。初次启动只表示基础工程可运行。读 [加固方法](references/generated-admin-hardening/WORKFLOW.md) 完成差距、数据库、权限、页面、验收、返工与冻结；最终源码、数据库安装脚本、账号及证据齐全才交付，不要求手工图稿。

要全套：系统完成并冻结后，用最终实现制作整套图。用户明确要求先看设计图才提前保存设计版，不能冒充最终实现图。七图绑定最终源码；ER逐项对比最终表/字段/关系。结构发生变化，使用既有受支持的原生在线编辑并回读；能力不足保留已完成系统并准确阻塞，不能另建收费项目或拿相同源码摘要冒充ER一致。

数据库优先于页面美化。按 [数据库合同](references/generated-admin-hardening/references/database-contract.md) 结构逐项复核、对象查询重设计、演示/测试数据全部重新生成；先实现必要业务接口再通过它产生状态，不靠SQL改状态冒充动作。数据未重建不得验收；重建使受影响截图、接口/页面证据和绑定失效。公开本机口令与actionKeys只引用 [conventions.json](references/conventions.json)，不复制默认值、不改既有实例管理员口令、不操作未知库。

页面任务以角色×目标菜单×业务页面为单位，调用随包页面任务脚本持久化派发；按钮/主从明细/返工均留页内，不能依赖上下文记忆临时补任务。

按 [页面方法](references/generated-admin-hardening/references/page-business-redesign.md) 和 [运行复审](references/generated-admin-hardening/references/runtime-review.md) 真正逐角色登录、状态操作、边界/冲突/空态/越权测试；安装、编译或文件存在均不代替业务验收。

图稿统一按 [DIA协议](references/diagram-subsystem.md) 与 [事实合同](references/generated-admin-hardening/references/diagram-facts-contract.md)。冻结前写完项目内交付文件；冻结后正文、回执、浏览器记录、最终报告都在项目外。图稿失败不撤销HARD成果，但全套不能标完成。

## 播报、恢复与证据

每阶段开始/结束一句：当前阶段·目标·已完成·产出物/证据·下一步·是否需要你。无用户动作写“无需你操作，我继续下一阶段”。不说“你点头我就继续”“未回读却已在右侧打开”“SQL写好了所以数据库通过”“还有unverified却全流程完成”。

执行计划与原始明确目标一起存入检查点。不手改target；明确范围变更使用retarget，保留原身份及历史成果。旧H8继续映射DIA.SAVE，缺新证据标legacy/unverified，不追认通过。已安装或已登录的最新反馈不可被旧检查点文字覆盖。

```bash
node scripts/checkpoint.mjs init --dir <项目外目录> --route requirement --target diagrams --note <用户明确原话>
node scripts/checkpoint.mjs init --dir <项目外目录> --route source --target full --branch reuse --note <用户明确原话>
node scripts/checkpoint.mjs status --dir <检查点目录>
node scripts/checkpoint.mjs retarget --dir <检查点目录> --target full --note <用户明确扩大范围的原话>
```

已有项目init同时传--project-id和--design-revision；独立补图可传--diagram-basis design。目标来自原生选择卡时传--target-source card，计入三卡预算。续跑不init，按 [连续执行](references/automation-loop.md) 的fail/resume/invalidate/migrate执行。原projectId、previewId、requestNonce、jobId、downloadRequestId、commandBatchId和planDigest保留；同因三次无进展blocked，给具体恢复动作，不换号重试。

证据适用性与执行结果分开；不适用不伪标passed，适用未运行记unverified。静态/合成检查仅一致性；真实接口与原生页面分别证明对应行为，原生缺失不能用外部浏览器或HTTP200冒充。检查点无法拦截未记录调用、不能认证实际执行；计费幂等以真实服务回执为准。

## 阶段生成视图

<!-- BEGIN GENERATED STAGES ALL -->
| 阶段 ID | 名称 | 必需产物 |
| --- | --- | --- |
| CREATE.GENERATE | 按已确认设计生成与计费 | `generation-receipt.json` |
| CREATE.DOWNLOAD | 下载源码基线并冻结本地摘要 | `local-snapshot.json` |
| ENV.REQUIREMENTS | 读取最终产物并计算本项目所需组件 | `requirements.json` |
| ENV.DIAGNOSE | 检测操作系统、架构、现有安装、版本、PATH、服务与连接状态 | `diagnose-before.ndjson`、`platform-facts.json` |
| ENV.VERSIONS | 按项目约束与机器条件选择兼容版本 | `version-selection.md` |
| ENV.PLAN | 分清新装、增量补齐与损坏修复并生成逐组件执行计划 | `plan.json` |
| ENV.AUTHORIZE | 对具体系统改动取得用户授权 | `decisions/environment.json` |
| ENV.APPLY | 执行安装或修复并保留备份与恢复点 | `apply-checkpoint.json` |
| ENV.VERIFY | 新终端复诊并用最终项目真实构建、鉴权连接与启动 | `diagnose-after.ndjson`、`verify.json` |
| HARD.GAPS | 盘点生成物、原需求与现有测试并建立差距清单 | `docs/business-gap-list.json` |
| HARD.DATABASE | 复核结构、重设计对象与查询并全量重建业务数据 | `docs/db-redesign.md`、`docs/sql-object-inventory.json`、`docs/seed-data-spec.json`、`database.sql`、`docs/db-verification.json` |
| HARD.PERMISSIONS | 按角色、实体、行范围、字段与入口修复真实权限 | `docs/permission-matrix-diff.json` |
| HARD.PAGES | 按角色、目标菜单与业务页面任务完成业务适配 | `docs/page-business-plan.json`、`docs/page-task-plan.json`、`page-task-state.json` |
| HARD.ACCEPTANCE | 构建、启动并逐角色执行真实业务与越权测试 | `docs/role-test-results.json` |
| HARD.REWORK | 失败项记录问题、修复、复验并循环到必需项全过 | `docs/rework-log.json` |
| HARD.FREEZE | 运行随包审计脚本、反向枚举漏页并冻结最终代码事实 | `docs/page-redesign-audit.json`、`docs/final-code-facts.json`、`docs/runtime-review.json`、`docs/page-task-results.json` |
| DIA.SAVE | 保存七类手工图、回读派生 ER 与来源绑定 | `diagram-saved.json` |
| DELIVERY.FINAL | 交付与如实报告 | `docs/delivery-report.md` |
| CREATE.A1 | 输入解析 | `facts.md` |
| CREATE.A2 | 免费需求与权限预览 | `preview.md` |
| CREATE.A3 | 用户确定技术栈与关键业务选项 | `stack-choice.json` |
| CREATE.A4 | 结构/关系/角色/权限设计与免费预检 | `design.json` |
| CREATE.A5 | 用户决定创建 | `decisions/business.json` |
| CREATE.A6 | 授权与权益检查 | `access/account.json` |
| CREATE.A7 | 按需求设计创建或复用项目 | `project-created.json` |
| CREATE.A8 | 回读项目与逻辑图并给出在线编辑链接 | `edit-link.md` |
| CREATE.B1 | 方言识别与逐表结构分析 | `sql-facts.json` |
| CREATE.B2 | 增强版 SQL 工作副本与推荐权限矩阵预演 | `sql-enhanced.sql`、`permission-matrix.md` |
| CREATE.B3 | 用户确认平台、数据库与关键业务选项 | `stack-choice.json` |
| CREATE.B4 | 用户决定创建并完成授权 | `decisions/business.json` |
| CREATE.B5 | 以增强版 SQL 取得捷码正式解析基线 | `sql-baseline.json` |
| CREATE.B6 | 写入有序登录与全量权限 decisions | `decisions.json` |
| CREATE.B7 | 二次预览并逐格回读比对 | `sql-readback-diff.json` |
| CREATE.B8 | 按同一 SQL 指纹提交或核对既有项目 | `project-created.json` |
| CREATE.C1 | 确认源码版本与交付面 | `source-profile.json` |
| CREATE.C2 | 只读分析建表 SQL、迁移、ORM、实体、路由、服务、权限与真实调用链 | `source-analysis.json` |
| CREATE.C3 | 建立图元素到源码的证据索引 | `source-evidence-index.json` |
| CREATE.C4 | 创建或复用源码文档项目并登记来源 | `source-doc-project.json`、`decisions/business.json` |
| DIA.DRAFT | 生成并复核七类手工图及派生 E-R 图 | `diagram-drafts.json` |
| CREATE.C7 | 编写五份项目文档并核对产品可用导出 | `project-implementation.md`、`data-dictionary.md`、`role-permissions.md`、`business-flows-and-interfaces.md`、`diagram-source-index.md`、`document-export.json` |
| CREATE.C9 | 重建确认与结构化设计 | `rebuild-confirmation.json` |
| CREATE.C10 | 运行原项目验证行为的申请 | `run-verification-request.json` |
| CREATE.D1 | 模板身份与解锁状态 | `template-facts.json` |
| CREATE.D2 | 按模板身份创建或复用项目 | `project-created.json`、`decisions/business.json` |
| CREATE.M1 | 结构核对与权限补全 | `design.json` |
<!-- END GENERATED STAGES ALL -->

## 交付

项目身份、目录、安装/运行方式、原需求覆盖、数据库版本和回读、逐角色/页面真实结果、图稿 revision/sourceMatch、浏览器四处交接与未覆盖项逐项交付。工程师独立证据和 WorkBuddy 原生证据分开列 passed/failed/unverified；只要有必需项未验证就不说全流程完成。交付清单放项目外，避免污染图稿绑定摘要。原生右侧导航只认宿主 builtin 证据，外部浏览器、系统 open、HTTP 200 都不替代。发布和权限边界按 [发布边界](references/publication-boundary.md)。
