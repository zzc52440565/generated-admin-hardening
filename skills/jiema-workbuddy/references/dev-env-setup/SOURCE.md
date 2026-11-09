# 来源与审查取舍

## 素材

- 用户提供的一份待审查环境部署素材包（本地审查日期 2026-11-06），文件名 `dev-env-setup.zip`：15 项、298,318 字节，含 macOS/Windows 的 doctor/install/repair 脚本、`version-matrix.md`、`tool-matrix.md`、`troubleshooting.md` 与 5 个配置 asset。
- 已完整吸收的能力：十态判定与 doctor 覆盖面、版本选型算法与官方核对入口、原生安装对照（含包命名空间、keg-only、`JRE_HOME` 优先级等易错项）、18 类故障排障、配置模板（`mise.toml`、`mysql-my.ini`、`postgres-unattend.txt`、`sqlserver-install.ini`、`tomcat-setenv.bat`）、以及「新装 / 增量 / 损坏修复」三类现场的分流。
- **不随包携带原包的 install/repair 脚本本体**，也不执行它们：其风险动作与「逐项授权 + 最小动作」冲突，原因见下表。能力以本技能自己的 `plan.mjs` / `repair.mjs` / `apply.mjs` / `verify.mjs` 重新实现。

## 原包的问题与处置

| 原包做法 | 问题 | 本技能处置 |
| --- | --- | --- |
| 默认一次性装完 JDK/Maven/Python/Node/MySQL/PostgreSQL/SQL Server/Redis/Go/Tomcat | 与「只装当前项目需要的组件」冲突 | 改为：按实际产物算组件，逐项授权，一次一个 |
| 数据库管理员口令被写成固定弱口令，并可能出现在命令行、进程参数与输出里 | 凭据泄漏 | 口令一律不进命令行与日志：只经 `0600` 选项文件或 stdin 传递，日志统一 `<redacted>`；**禁止改已有实例管理员口令** |
| 可重建数据库数据目录 | 破坏性、不可逆 | 禁止重建/删除已有 datadir，只允许新目录 + 复用已有实例 |
| 改全局 PATH、注册系统服务 | 影响面大、难回滚 | 默认独立前缀 + 项目级环境脚本；系统级动作一律 `needs-elevation` 交用户 |
| 部分归档下载无摘要校验、`curl` 管道安装 | 供应链风险 | 只允许 https 官方域名 + 官方 sha256/sha512（含官方 sidecar），无摘要即拒绝 |
| 「跳过兼容性检查」开关 | 绕过风险判断 | 不提供该开关；版本按项目产物与官方目录现场确定 |
| `--reset-db` 重命名现有数据目录 | 高影响且不可逆 | 不提供；已有实例优先复用，无法安全复用只输出阻塞 |
| 用远程脚本管道安装 Homebrew（下载后直接交给 shell 执行） | 供应链风险 | 只给官方安装命令，由用户在自己的终端执行 |
| 把管理员口令直接拼进 `mysql -u root -p...` 之类的命令行 | 口令进命令行与进程列表 | 口令只经 `0600` 选项文件或 stdin；日志与报告一律 `<redacted>` |
| install 脚本把 11 类组件一次装完 | 与最小动作冲突 | 按项目产物算组件，一次一个动作，`apply.mjs` 拒绝批量 |
| 修复脚本直接改系统 PATH / 注册服务 | 影响面大 | 修复计划把这类动作定为 `needs-elevation`，命令交用户；技能只自动执行用户级可逆修复 |

## 新增能力（对应阶段 ENV.PLAN–ENV.VERIFY）

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 修复计划 | [scripts/repair.mjs](scripts/repair.mjs) | 把诊断状态映射成可执行修复动作：PATH 修复（写项目级环境脚本）、并行版本（交 `plan.mjs`）、服务/连接/数据损坏（`user-manual-step` + 排障条目） |
| 配置回滚 | `apply.mjs` 的 `restore-config-backup` | 从记录的备份文件恢复配置，恢复后自动复验，失败自动回滚 |
| 安装委派 | `apply.mjs` 的 `install-via-plan` | 修复计划不自己造安装动作，统一由 `plan.mjs` 生成带官方摘要的安装动作 |
| 版本选型 | [references/version-matrix.md](references/version-matrix.md) | 选型算法、组件矩阵、磁盘内存预算、官方核对入口、选型报告模板 |
| 原生安装对照 | [references/tool-matrix.md](references/tool-matrix.md) | 每组件官方来源、安装位置、复验命令与「看似装好其实不可用」清单 |
| 排障手册 | [references/troubleshooting.md](references/troubleshooting.md) | 20 类症状：判定、取证、动作、反例 |
| 配置模板 | [assets/](assets/mise.toml) | 口令一律占位符，无默认弱口令；MySQL 模板固定回环绑定 |

## 与旧草稿的关系

- 旧的只读分诊脚本已替换为 [diagnose-macos.sh](scripts/diagnose-macos.sh) 与 [diagnose-windows.ps1](scripts/diagnose-windows.ps1)：输出 NDJSON、两端字段同构、覆盖十种状态、可选组件、能区分宿主注入 PATH 与转发壳。
- 旧草稿「只诊断、不修复」的边界已按新验收要求扩展：取得对**具体动作**的授权后，由 `apply.mjs` 真正执行安装/修复并复验；未授权时仍然只读。

## 版本与命令的可信度

- 所有下载地址、摘要方式在 [install-recipes.md](references/install-recipes.md) 里注明官方入口；`plan.mjs --resolve-versions` 现场解析官方目录，避免写死版本（实测：`dlcdn` 上 `3.9.9` 已 404，当前可用 `3.9.16`/`3.10.0`）。
- 原包中关于 Tomcat Windows 服务、`JRE_HOME` 优先级、`LocalService` 权限等经验性结论**未在 Windows 上实测**，写入文档时明确标注为官方文档/社区结论，不作为已验证事实。

## 能力分级（不要升级表述）

| 能力 | 级别 |
| --- | --- |
| macOS 诊断 / 需求识别 / 计划 / 单项执行 / 复验 / 回滚 | 本地已实测 |
| Windows 诊断脚本 | 仅静态验证（本机无 PowerShell） |
| WorkBuddy 宿主是否允许自动执行安装命令 | 待真机确认 |

本机 `sudo` 能装，不等于公开分发的技能在别人机器上能装；默认路径永远是"独立前缀 + 用户可回滚"。
