# 路由与执行合同

[mode-routing.json](mode-routing.json) 是唯一阶段、目标、工具与产物真值。下表由同步器生成；实际计划由orchestration.resolveRoute(contract, request)解析，所有checkpoint命令共用。target是用户范围；不另维护delivery开关。

<!-- BEGIN GENERATED TARGETS -->
| 交付目标 | 执行能力 | 完成含义 |
| --- | --- | --- |
| 只要图（diagrams） | diagrams | 整套八类图；需求/SQL绑定设计事实，已有源码绑定真实实现，不生成下载或配置环境 |
| 只要系统（system） | generate、localRuntime、hardening | 完整源码、本地运行、数据库与业务改造及真实验收；不要求手工图稿 |
| 要全套（full） | generate、localRuntime、hardening、diagrams | 系统完整交付后，以最终实现制作八类图并核对在线ER一致 |
<!-- END GENERATED TARGETS -->

目标缺失先识别原话，仍不明确才问一次；不默认完整系统。preview是只读范围，独立env/harden/diagram入口是复用能力。源码diagrams→documentation，system/full→reuse，明确重新生成才rebuild；run-verification保留原来的仅运行范围。

依赖：用户决定先于收费；结构/权限就绪后建项；需要新源码才生成下载；ENV按本地运行目标触发；数据库与业务数据先于页面验收；系统冻结先于最终实现图。源码full在冻结后创建或复用图稿项目，避免依据漂移。只要图的design证据不要求本地系统。

已有身份用projectMode=reuse，建项阶段只核对/回读不重复收费。目标变更用retarget保留原身份，按新必需阶段补做；不擅自给源码文档工程启动生成。并行只限无依赖读取，结构、数据、权限、最终证据串行收口。

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

闸门、播报、续跑按 [主技能](../SKILL.md) 和 [连续执行协议](automation-loop.md)。数据库方法按 [数据重设计合同](generated-admin-hardening/references/database-contract.md)，图稿按 [DIA 子系统](diagram-subsystem.md)，原生页面按 [浏览器交接](browser-handoff.md)。旧检查点的别名迁移仅映射阶段，绝不重建项目或重扣费；新增门槛缺证据时标 unverified。
