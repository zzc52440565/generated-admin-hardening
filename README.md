# generated-admin-hardening 2.4.0

对脚手架/生成器项目进行业务加固、初始SQL重设计和真实验证，再按最终实现同步Studio七类图表。

**第一次使用：复制[完整提示词](skills/generated-admin-hardening/PROMPT.md)到目标项目的AI编程工具。** 提示词会检查技能，未安装时从本仓库固定版本安装，读取技能后在当前任务继续工作。

- [公开仓库](https://github.com/zzc52440565/generated-admin-hardening)
- [完整提示词原文](https://raw.githubusercontent.com/zzc52440565/generated-admin-hardening/v2.4.0/skills/generated-admin-hardening/PROMPT.md)
- [固定版本下载](https://github.com/zzc52440565/generated-admin-hardening/releases/tag/v2.4.0)
- [技能源入口](skills/generated-admin-hardening/SKILL.md)

## 安装与立即使用

完整提示词已包含项目路径、可选要求、事实分析、实施顺序、保护规则、验收和交付。不需要先发一次安装请求、再发一次工作请求。默认只给当前项目安装，不改全局设置；发现已有同名技能则读取复用，不自动覆盖或升级。

只安装时可发：

```text
请使用 $skill-installer 从 https://github.com/zzc52440565/generated-admin-hardening/tree/v2.4.0/skills/generated-admin-hardening 安装技能到当前项目的 .agents/skills 目录。
```

安装后继续执行项目任务时，使用[完整提示词](skills/generated-admin-hardening/PROMPT.md)。客户端尚未刷新技能列表时，模型可直接读取安装目录的SKILL.md和所需参考，在当前任务按明确请求继续；文件读取与原生技能发现分别说明。Codex支持自动发现技能变更，未显示时可在后续新对话或重启后再原生调用。[官方说明](https://learn.chatgpt.com/docs/build-skills)

没有skill-installer时，完整提示词提供同版本Release源码包、SHA256校验和包内Python安装器的替代路径。手动下载[源码包](https://github.com/zzc52440565/generated-admin-hardening/releases/download/v2.4.0/generated-admin-hardening-2.4.0-source.zip)，核对同版本SHA256并解压后，在目标项目运行：

```bash
python3 /path/to/extracted-release/tools/install_skill.py --dest .agents/skills/generated-admin-hardening
```

安装器不联网、不安装依赖、不读取账号配置，目标已存在则拒绝覆盖。只复制技能的目录也可从[轻量包](https://github.com/zzc52440565/generated-admin-hardening/releases/download/v2.4.0/generated-admin-hardening-2.4.0.zip)提取；最终结构必须是`.agents/skills/generated-admin-hardening/SKILL.md`。客户端目录不同则按其实际能力适配一个位置，避免重复安装。

本地文件、终端和测试能力由使用的AI工具提供。无联网或文件权限时需说明限制；安装提示词不会凭空增加这些能力。非Agent Skills工具可使用[便携参考](https://github.com/zzc52440565/generated-admin-hardening/releases/download/v2.4.0/generated-admin-hardening-2.4.0-portable.md)，但它不是自动安装器。

## 这版提示词包含什么

- 先读真实源码、SQL、配置和测试，给出项目画像、资产、菜单/数据映射、主从判定和依赖账本，然后直接实施。
- 完成主从交互/事务/权限收口；默认保护现有表、字段、账号、数据和有效功能，不以表名后缀判断主从，不清真实业务数据。
- 完整重设计CRUD、视图、存储过程与触发器，逐类交付真实用途、完整定义、调用/权限/事务契约、失败测试与恢复说明；同步应用调用，防止重复副作用。
- 唯一安装.sql包含完整结构、演示数据与必要对象；已有库迁移、恢复与独立验证另以文档/测试程序说明，区分Studio结构导入及对象“已定义/已部署/已使用”。没有安全目标引擎就明确运行未验证。
- 逐菜单逐页面判断是否适合列表：合理列表保留并优化，特殊场景贯通真实业务工作流，首次即改登录；页面清单驱动业务复审、真实操作、失败返工和最终全量核对。
- 实测按钮、筛选、布局、角色与服务端授权；记录通过/失败/未测，不用行数变化或构建成功冒充业务验收。全部实现后集中检查，失败修复复验。
- 最终七类图来自最终代码和SQL；流程/DFD以全部核心业务的完整图族交付，含覆盖清单、代码证据和接收状态。

具体SQL规则见[重设计流程](skills/generated-admin-hardening/references/sql-redesign.md)、[对象设计](skills/generated-admin-hardening/references/sql-object-design.md)和[交付模板](skills/generated-admin-hardening/assets/sql-delivery-template.md)。保表红线约束实际改造；必要视图/过程/触发器及约束/索引在脚本中完整设计，不等于授权对已有库自动执行。

## 七类图怎么填写

| 图种 | 正文与更新范围 |
| --- | --- |
| 功能结构图 | 原生五级缩进树，重建当前图 |
| 领域类图 | 中文类/属性/方法/关系，全文更新当前领域模型 |
| 时序图 | 总图及全部真实业务场景，一份图族文本，一次应用并保存 |
| 系统流程图 | 登录及全部核心流程，一份图族文本，一次应用并保存 |
| 数据流图DFD | 顶层、一层及所需全部二层，一份图族文本，一次应用并保存 |
| 架构图 | 编号节点、JSON名称、形状/显式连接，全文更新当前成员 |
| 用例图 | 参与者和用例树，全角色完整图族全文更新 |

时序、系统流程与DFD各输出一份连续txt，分别复制到网页“快速填写”，各点击一次“应用并保存全部图”。所有需要的成员一次完成，不逐张粘贴、不手工补父子绑定。类图、架构图、用例图及完整图族未包含的对应旧项会移除，应用前备份；格式有误整批拒绝，草稿保留。

数量来自项目事实。此前真实租户案例生成17系统流程、7DFD（顶层/一层/5二层），桌面与DFD手机保存恢复通过；这不是每个项目的固定数量。架构预置排版保留关系数据，但按当前渲染合同不显示箭头。格式来自2026-11-03接收端实现，指纹在[来源清单](skills/generated-admin-hardening/references/studio-format-sources.json)。安装技能不替代网站升级，旧版Studio不能仅靠此安装获得批量入口。

## 下载与发布维护

Release提供技能ZIP、含安装/构建/验证工具的源码ZIP、portable.md和SHA256SUMS-2.4.0.txt。公开内容只包含通用技能与语法示例，不包含客户代码、数据库、账号或本地验收日志。未提交插件目录，也不宣称已通过插件审核。维护发布流程见[PUBLISHING.md](docs/PUBLISHING.md)。

```bash
python3 -B -m unittest discover -s tests -p 'test_*.py'
python3 -B tools/build_release.py
```

真实Studio格式工具在接收端仓库运行，依赖已有tsx，不连接数据库、不执行构建：

```bash
pnpm exec tsx --tsconfig tsconfig.json /path/to/release/tools/verify_studio_examples.mts --repo /path/to/CodeAutoGeneratorSystem --diagrams-only
```

图表验收不替代SQL引擎验证。当前提示词/发布检查见[VALIDATION.md](docs/VALIDATION.md)，此前真实图族验收见[2.2.2记录](docs/VALIDATION-2.2.2.md)，审查修正见[REVIEW.md](docs/REVIEW.md)。

真实项目七图检查可追加 `--input-dir /path/to/docs/diagram-update`。工具要求最终七份txt、时序总图及全部业务、DFD整套聚合平衡，并检查功能三深度与架构无重叠；结果不等于已在用户网站保存。完整加固默认逐页改造、123456演示口令、唯一SQL和最终启动留运行，见技能参考。

逐页业务改造的判据与闭环见[页面业务协议](skills/generated-admin-hardening/references/page-business-redesign.md)，[审查JSON格式](skills/generated-admin-hardening/references/page-redesign-audit-format.md)与只读脚本随完整技能分发。脚本仅检查所给清单、源码指纹和本地证据，不能自动发现漏登菜单或代替真实业务/界面验收。
