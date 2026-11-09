# 平台、输入与通用生成能力

先调用 `platform_catalog` 读当前目录。下表是随技能包提供的 `2026.10.24.1` 能力快照，供模型离线理解，不代替实时目录。平台 `availability.status` 必须是 `AVAILABLE`；真实能力由目录中的 `supportedDatabases`、`deliveryTargets`、`hasWebUI`、`websiteVariants`、`features` 共同决定。`schema_get` 是输入结构的权威合同。

## 技术栈矩阵

数据库代码：`mysql`、`sqlserver`、`sqlite`。

| 平台代码 | 生成目标与主要技术 | 数据库 | 特别限制 |
| --- | --- | --- | --- |
| `VUE` | Vue 3 + Element Plus + Vite；Spring Boot 3 + MyBatis Plus；Web 管理/内容 | mysql、sqlserver | 无目录中特别禁用的可选项 |
| `VUE_WXAPP` | Vue 网页 + 微信原生小程序；Spring Boot 3 + MyBatis Plus | mysql、sqlserver | 小程序需目标平台编译和真机验收 |
| `SPRING_BOOT` | Spring Boot 3 + MyBatis Plus；JSP + jQuery + Bootstrap | mysql、sqlserver | 后端渲染 |
| `SPRING_BOOT3` | 同一 Spring Boot 3 家族的简洁页面变体 | mysql、sqlserver | 页面风格变体，不是 Spring Boot 3.0 精确版本承诺 |
| `BOOT` | Spring Boot 2 模板；Thymeleaf + Bootstrap 4 | mysql、sqlserver | `excel=false` |
| `BOOT2` | 同一 Spring Boot 2 家族的样式 B 变体 | mysql、sqlserver | `excel=false` |
| `SSM` | Spring + SpringMVC + MyBatis；JSP | mysql、sqlserver | 经典三层框架 |
| `SSM3` | 同一 SSM 家族的简洁页面变体 | mysql、sqlserver | 页面风格变体 |
| `JAVA_WEB` | Servlet + JSP + JDBC | mysql、sqlserver、sqlite | 基础 Java Web |
| `JAVA_WEB3` | 同一 JavaWeb 家族的简洁页面变体 | mysql、sqlserver、sqlite | 页面风格变体 |
| `JAVA_SWING` | Java SE + Swing + JDBC 桌面程序 | mysql、sqlserver、sqlite | `chat=false`；无 Web UI |
| `C_SHARP` | .NET Framework + WinForms + ADO.NET | mysql、sqlserver | `chat=false`；仅 Windows 运行 |
| `C_SHARP2` | 同一 WinForms 家族的增强窗体变体 | mysql、sqlserver | `chat=false`；仅 Windows 运行 |

全部 13 项在该版本目录均为 `AVAILABLE`，但不能因此推断任意需求都可生成。目录里的 `fileUpload`、`multiComboBox`、`captcha` 对这些平台均为 true；`excel` 在 `BOOT`/`BOOT2` 为 false；`chat` 在三个桌面平台为 false。目录虽然允许各平台 `aiSqlData`，WorkBuddy 自行设计时必须设为 false，避免再次调用捷码 AI 生成样例数据。

**前台网站不是默认生成物**：目录中的 `websiteVariants` 是主题可选项；只有内容实体配置 `pageType="tw"/"wl"/"bk"` 与 `presentation.publicPage`，或配置有效公告来源，网站生成计划才会启用。桌面平台即使列出内容主题，也不交付浏览器网站。`VUE_WXAPP` 当前目录虽有 `hasWebUI=false`，生成器仍先生成 Vue 网站再加小程序，所以不能只看这个展示属性。Vue / JSP / Thymeleaf 网站及小程序的真实页面与互动边界见 [网站前台、页面与互动能力](website-and-interactions.md)。

交付目标：`WEB_ADMIN` / `WEBSITE_CONTENT` 推荐 `VUE+mysql`；`MINI_PROGRAM` 推荐 `VUE_WXAPP+mysql`；`DESKTOP` 推荐 `JAVA_SWING+sqlite`。`COURSE_FRAMEWORK` 需要按课程指定的实际框架选，不凭推荐覆盖明示要求。用户没有指定技术栈时，显示目标匹配的推荐项与支持项供用户选择；用户选定后才创建。用户只说“Java”“Web”不够确定，应在可支持的具体选项中选择。用户指定 PostgreSQL、React、Next.js、Python、Go、.NET Core、WPF 等未列在目录的目标时，明确“当前生成器暂不支持原样生成”，可介绍支持项但不可静默转换。已有项目使用不支持技术时，可在用户明确同意**重建成支持平台**后提取业务结构。

## 通用代码生成器的真实边界

平台代码决定交付模板；共享结构化设计包含 `config`、`entities`、`relations`、权限和业务规则。生成目标是平台模板源码与数据库脚本，再由本地加固完善核心业务。若服务端实施报告标记 `PLANNED`、`UNSUPPORTED`、`GENERATED`，按每项证据等级报告；静态计划和文件清单都**不等于**编译、运行或业务一致性通过。不能承诺任意流程、任意高级 SQL 对象或任意前端组件都能由基础生成器一次完成。

**脚手架输入门槛**：只读预演先对照实时 `schema_get(kind=design)` 列出所选平台与数据库、`source=manual`、`aiSqlData=false`、每个实体的物理名/主键/字段/登录入口、真实关系与引用键、四动作已确认配置、正向 grant 的角色 ID/范围/字段规则。建项时服务端还会检查执行语义，不能把 JSON 形状合法当作可生成；未通过诊断先修设计，不能移除必需业务或放大权限凑过。完整设计通过建项和生成后，才可说“已生成结构脚手架”；下载并编译后才可说对应平台的产物可构建，业务流程仍需本地实测。只读预演只能标“脚手架候选/合同缺口/待选阻塞”，不能保证尚未产生的源码。

功能诉求与目录 `features` 不符时先说明缺口。可以在用户允许的**本地加固**范围实现具体功能，但要把“基础生成器支持”与“下载后人工/模型开发实现”分开报告。复杂业务规则、支付、外部接口和部署也按同一原则处理。

目录里的 `chat` 是在线聊天模板，不是 AI 客服；`aiSqlData` 是示例记录生成，不是网站大模型能力。收藏和点赞由有效网站内容页的交互模板承接，评论需要单独的实体、绑定和权限；不能用 `features` 中不存在的布尔字段声称开启。

## 输入到五种模式

路由与阶段顺序以 [三模式路由、阶段与检查点](mode-router.md) 为准；下表只说明各输入在捷码侧对应的建项模式与计费口径。模板 ID 与已规范化的结构清单是独立入口，不要硬塞进「需求 / SQL / 源码」三条流程。

| 用户资料 | WorkBuddy 处理 | 捷码建项模式 |
| --- | --- | --- |
| 一段文字或需求文档 | 抽取业务、角色、字段、关系、规则，形成规范设计 | `manual`（先 `project_preflight`，再调用 `project_create`；设计 `source=manual`） |
| 已给出规范结构或表单模型 | 读取可访问资料，保留证据映射，归一为规范设计 | `manual`（调用 `project_create`，设计 `source=manual`） |
| SQL/DDL 正文或文件且用户要求导入 | WorkBuddy 分析原件并给推荐矩阵；授权后先解析，再把登录和权限转成决策、再次预览回读，最后提交；不只凭文件名猜表 | `sql`（按 [SQL 导入与权限写入](sql-import-and-permissions.md)使用两轮 `project_sql_preview` → `project_sql_commit`） |
| 捷码网站真实模板 ID | 保留模板来源与解锁合同 | `template`（`project_template_use`） |
| 已有源码项目（含 Java）且只需图表与文档 | 只读审查源码、归一设计并保留源码证据；用户决定后创建可在线编辑的文档工程 | `manual`（先 `project_preflight`，再 `project_source_doc_create`；按手工设计额度结算） |

SQL 夹在文字需求里时，先判断用户要“导入该 SQL”还是“参考其结构设计”；影响计费与来源，不可自行改模式。附件若不在 WorkBuddy 已授权可读范围内，不能声称已检查；索取可访问的文件或正文。项目源码里可能有凭据和个人数据，设计时只提取必要结构，避免回显或无关上传。

## 运行时依据

- 当前平台与特性：捷码 MCP `platform_catalog`。
- 建项字段与模式：捷码 MCP `schema_get`。
- 语义约束与最终能力：建项/生成接口的校验结果，以及下载产物的真实构建和运行检查。技能包内的规则是可携带快照，不要求 WorkBuddy 登录服务器读代码。
