# 业务加固编排引用

本页仅连接编排与方法，不重复维护阶段细则。是否运行环境/业务加固由交付目标决定；下载完成不等于项目完成。system/full需要环境、业务与数据闭环；只有full继续最终图稿。diagrams不进入本段；明确只要源码时保留范围原话。

开始前实际读取 [加固方法](generated-admin-hardening/WORKFLOW.md)、[数据库重设计](generated-admin-hardening/references/database-contract.md)、[逐页方法](generated-admin-hardening/references/page-business-redesign.md)、[运行复审](generated-admin-hardening/references/runtime-review.md)。数据库数据必须全部重新生成并通过门禁后再验收；口令与操作键约定引用 [conventions.json](conventions.json)。

<!-- BEGIN GENERATED STAGES HARD -->
| 阶段 ID | 名称 | 必需产物 |
| --- | --- | --- |
| HARD.GAPS | 盘点生成物、原需求与现有测试并建立差距清单 | `docs/business-gap-list.json` |
| HARD.DATABASE | 复核结构、重设计对象与查询并全量重建业务数据 | `docs/db-redesign.md`、`docs/sql-object-inventory.json`、`docs/seed-data-spec.json`、`database.sql`、`docs/db-verification.json` |
| HARD.PERMISSIONS | 按角色、实体、行范围、字段与入口修复真实权限 | `docs/permission-matrix-diff.json` |
| HARD.PAGES | 按角色、目标菜单与业务页面任务完成业务适配 | `docs/page-business-plan.json`、`docs/page-task-plan.json`、`page-task-state.json` |
| HARD.ACCEPTANCE | 构建、启动并逐角色执行真实业务与越权测试 | `docs/role-test-results.json` |
| HARD.REWORK | 失败项记录问题、修复、复验并循环到必需项全过 | `docs/rework-log.json` |
| HARD.FREEZE | 运行随包审计脚本、反向枚举漏页并冻结最终代码事实 | `docs/page-redesign-audit.json`、`docs/final-code-facts.json`、`docs/runtime-review.json`、`docs/page-task-results.json` |
<!-- END GENERATED STAGES HARD -->

环境初版按 [浏览器交接](browser-handoff.md) 展示后同任务继续；旧任务只补当前展示，不补造历史。加固最终冻结数据/对象版本及代码事实；图稿由 [DIA 子系统](diagram-subsystem.md) 独立执行，保存回执放项目外。实际执行页面审计、数据库一致性检查和运行复审；检查器本身不认证真实操作。
