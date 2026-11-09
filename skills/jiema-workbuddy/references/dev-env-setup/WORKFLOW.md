---
name: dev-env-setup
display_name: 捷码项目环境阶段
display_name_en: Jiema Project Environment Stage
description: 捷码技能的环境阶段 ENV.REQUIREMENTS–ENV.VERIFY：按最终产物算出本项目真正需要的组件，只读诊断 macOS/Windows 现状，按项目约束选版本，分清全新安装/增量补齐/损坏修复，逐项授权后由 WorkBuddy 实际执行并重新复诊、真实构建、数据库鉴权与启动验证。
description_zh: 环境阶段 ENV.REQUIREMENTS–ENV.VERIFY：按最终产物算组件，诊断、选版本、出计划、逐项授权、真实安装或修复、新终端复验。
description_en: Mandatory environment stage ENV.REQUIREMENTS–ENV.VERIFY — derive required components from the real deliverable, diagnose macOS/Windows, pick compatible versions, plan, get per-action approval, actually install or repair, then re-verify with real builds and database logins.
version: 3.0.0
author: 捷码
---

# 项目环境方法库

按可读项目的真实依赖准备环境。独立请求“把这个项目在本机跑起来”使用 `env-only`；其他路由仅在交付需要本地运行时进入。源码 documentation、纯设计或仅下载源码不安装环境。已安装且可用的组件直接复验；无系统动作时不弹权限选择卡。阶段真值来自主合同，下表仅是生成视图。

<!-- BEGIN GENERATED STAGES ENV -->
| 阶段 ID | 名称 | 必需产物 |
| --- | --- | --- |
| ENV.REQUIREMENTS | 读取最终产物并计算本项目所需组件 | `requirements.json` |
| ENV.DIAGNOSE | 检测操作系统、架构、现有安装、版本、PATH、服务与连接状态 | `diagnose-before.ndjson`、`platform-facts.json` |
| ENV.VERSIONS | 按项目约束与机器条件选择兼容版本 | `version-selection.md` |
| ENV.PLAN | 分清新装、增量补齐与损坏修复并生成逐组件执行计划 | `plan.json` |
| ENV.AUTHORIZE | 对具体系统改动取得用户授权 | `decisions/environment.json` |
| ENV.APPLY | 执行安装或修复并保留备份与恢复点 | `apply-checkpoint.json` |
| ENV.VERIFY | 新终端复诊并用最终项目真实构建、鉴权连接与启动 | `diagnose-after.ndjson`、`verify.json` |
<!-- END GENERATED STAGES ENV -->

## 环境方法

### ENV.REQUIREMENTS 读取最终产物，计算本项目所需组件

读取输入项目的真实构建文件与依赖，项目可以来自下载或既有目录：

| 读什么 | 用来定什么 |
| --- | --- |
| `pom.xml` / `build.gradle` / gradle wrapper | JDK 目标版本、构建工具、打包类型（jar/war）、servlet 命名空间 |
| `package.json` / lockfile / `.nvmrc` | Node 主版本、包管理器、前端框架与构建器 |
| `*.csproj` / `*.sln` | .NET Framework 还是 .NET SDK、WinForms/WPF、是否需要 MSBuild |
| `db.properties` / `application*.yml` / XML 数据源 | 数据库类型、主机、端口、库名、驱动版本 |
| 小程序配置、桌面入口、交付类型 | 是否需要微信开发者工具、是否需要外部 Tomcat |

```bash
node scripts/detect-requirements.mjs --project <项目目录> --out requirements.json
```

判定要点（易错项）：

- **`packaging=war` + `jakarta.servlet` 6.x → 外部 Tomcat 10.1；`javax.servlet` → Tomcat 9**。可执行 JAR / Spring Boot 内嵌容器**不需要**外部 Tomcat。
- **配置里被注释掉的连接串不算需求**；pom 里声明了驱动但配置里没有生效连接串，只记为「备用驱动」。
- **项目自带 `mvnw`/`gradlew` 时优先用包装器**，不要先装全局 Maven/Gradle。
- 版本取向「项目说了算」：`maven-compiler-plugin release=21` 就按 21 诊断，**不静默换成顺手的那版**。
- 输出里的 `password` 类字段统一是 `<redacted>`；凭据值只用于判断「是否存在」，不进计划、日志、聊天。

产出字段以主合同生成表为准；方法说明：`requirements.json`（阶段证据）。

### ENV.DIAGNOSE 检测机器现状（只读）

```bash
bash scripts/diagnose-macos.sh --components java,maven,mysql --java-major 17 --json
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-windows.ps1 -Components java,maven,mysql -JavaMajor 17 -Json
```

两个脚本都是**只读**：不安装、不修复、不启动服务、不读真实口令；输出 NDJSON（`type=platform` / `type=component` / `type=summary`），两端字段同构，可直接喂给 `plan.mjs` / `repair.mjs`。

诊断只输出十种状态之一，**状态决定下一步动作，也决定哪些事绝对不许做**：

| 状态 | 判定依据 | 对应动作 | 禁止动作 |
| --- | --- | --- | --- |
| `ok` | 命令可执行、版本满足、服务在跑、端口可连 | 进入复验 | 把「能打印版本」当成「可用」 |
| `missing` | 命令与安装目录都不存在 | 确认确实需要后装到独立前缀 | 因为缺一个组件就批量装全套 |
| `path-invisible` | 装了但持久化 PATH 看不到 | 写项目级环境脚本或调整项目内 PATH 顺序 | 重装；把宿主注入的 PATH 当用户环境 |
| `version-incompatible` | 生效版本低于项目要求 | 并行装满足要求的版本到独立前缀 | 卸载/覆盖旧版本；静默换版本 |
| `service-stopped` | 二进制在，端口没监听 | 先看日志与状态，再按需前台启动 | 重建数据目录；改管理员口令 |
| `connect-failed` | 端口在监听但客户端连不上 | 查监听地址/认证插件/端口占用/防火墙 | 用改密或重建数据来「试试看」 |
| `data-corrupt` | 数据或安装目录不可用、权限坏、缺系统库 | 先备份→取证→按用户选择恢复 | `rm -rf` 数据目录；在可疑目录上重新 `--initialize` |
| `unsupported-on-this-os` | 本 OS 无原生方案 | 给远程/目标机器实例或等价组件选项 | 偷偷用容器；假装装上；静默换技术栈 |
| `needs-elevation` | 修复必须管理员权限 | 把**准确命令**交给用户亲自执行 | 代跑 `sudo`；关 UAC/SIP；改 `ExecutionPolicy` 绕过 |
| `needs-user-input` | 缺信息或缺选择 | 用受控方式问一次 | 猜口令；用弱口令顶替；把口令写进命令行 |

配套语义：

- **多版本共存 ≠ 冲突**：生效版本满足要求就是 `ok`，其余记「备用」，不要删。
- **转发壳不算第二份**：`/usr/bin/java`（macOS 转发壳）、`javapath`（Oracle 转发壳）、`WindowsApps\python.exe`（0 字节商店占位）都不是第二份安装。
- **宿主注入的 PATH 不算用户环境**：必须拿**持久化 PATH**（macOS 读 `/etc/paths`、`/etc/paths.d/*` 与 shell 配置；Windows 读注册表 `Machine`+`User`）复核。

产出字段以主合同生成表为准；方法说明：`diagnose-before.ndjson`、`platform-facts.json`。

### ENV.VERSIONS 按项目约束与机器条件选版本

按 [版本选型矩阵](references/version-matrix.md) 的三条铁律与判定算法执行：项目约束优先 → 机器上限过滤 → 取最新 LTS → 写选型报告。有网络时至少核对一个官方页面；**没联网必须写「未联网核对，按基线矩阵选定」**。

产出字段以主合同生成表为准；方法说明：`version-selection.md`（逐组件：候选、硬约束、淘汰原因、选定版本、依据；最后一行写清本次不装什么与为什么）。

### ENV.PLAN 分清新装 / 增量补齐 / 损坏修复，生成逐组件计划

三类现场对应三条路径，**不要用一种手段处理三种现场**：

| 现场 | 判定 | 走哪个脚本 |
| --- | --- | --- |
| 全新电脑 | 多个组件 `missing` | `plan.mjs` 生成安装动作 |
| 部分安装 | `path-invisible` / `version-incompatible` / 只有包装器 | `repair.mjs` 生成 PATH 修复或并行版本动作 |
| 环境损坏 | `service-stopped` / `connect-failed` / `data-corrupt` / `needs-elevation` | `repair.mjs` + [排障手册](references/troubleshooting.md) |

```bash
node scripts/plan.mjs --requirements requirements.json --diagnose diagnose-before.ndjson \
  --out plan.json --versions maven=3.9.9 --install-root <独立前缀>

node scripts/repair.mjs --diagnose diagnose-before.ndjson --requirements requirements.json \
  --project <项目目录> --out repair-plan.json
```

计划里每个动作必须写全九项，缺一项就不能拿给用户确认：

`id`、`component`、`current` → `target`、`source{official URL, sha256|sha512}`、`commands`、`installRoot`、`privileges`、`impact`、`backup`、`restore`、`verify`、`reversible`。

`plan.mjs` / `repair.mjs` 会把下列情况自动拦成 `blockers`：本 OS 不支持、缺诊断、需提权、需用户选择、摘要拿不到。**有阻塞项时不要执行任何动作。**

产出字段以主合同生成表为准；方法说明：`plan.json` / `repair-plan.json`。

### ENV.AUTHORIZE 对具体系统改动取得用户授权

- **按权限等级处理**：系统级安装和授予权限由用户本人确认；已授权的普通可逆操作直接执行；空计划记录 no-op。用户同意「装 Maven」不等于同意「顺便装 JDK/Tomcat」，更不等于同意改口令、重装或重建数据目录。
- 授权文本里必须出现：组件、版本、官方来源、写入位置、影响、回滚方式、复验命令。
- 新建**本机开发**数据库实例前，把「默认口令（读取 `conventions.localDemo.password` 的实际值）、只绑回环地址、只用于本机开发」这条约定**原样展示**并记录；用户拒绝该作用域就先不新建，继续不依赖此实例的工作；不得暗改统一口令。
- 需要 `sudo`/管理员/改系统 PATH 的动作：把准确命令交用户本人执行，标「需用户操作」。

产出字段以主合同生成表为准；方法说明：`decisions/environment.json`（planDigest、被授权动作清单、用户原话、口令约定记录）。

### ENV.APPLY 执行安装或修复并保留备份与恢复点

```bash
node scripts/apply.mjs --plan plan.json --action maven-install-3.9.9 --confirm <planDigest>
node scripts/apply.mjs --plan repair-plan.json --action mysql-repair-path --confirm <planDigest>
```

执行纪律：

1. **一次一个组件、一个动作**（脚本显式拒绝 `--all`/`--batch`/`--actions`）。
2. **可逆优先**：独立前缀 + 项目级环境脚本，而不是全局安装、系统服务、全局 PATH。
3. **先写备份与检查点再动手**：检查点在 `<独立前缀>/checkpoints/<planDigest>/<actionId>.json`，失败后可续跑。
4. **摘要先于解压**：只接受 https 官方地址；没有摘要、也没有官方摘要文件时**拒绝安装**；校验失败即失败。
5. **失败即停**：回滚这一项、保留日志与备份、给出可执行恢复步骤，不自动连锁重试、不换第三方镜像掩盖问题。
6. `install-via-plan` / `provision-dev-database` / `user-manual-step` 这几类本脚本只做交接并给出准确指令（属提权或专门脚本）。

产出字段以主合同生成表为准；方法说明：`apply-checkpoint.json`（逐动作检查点、备份位置、日志路径、结果）。

### ENV.VERIFY 新终端复诊并用最终项目真实验证

```bash
node scripts/verify.mjs --project <项目目录> --components java,maven --build --out verify.json
```

复验输出分三类，只有第二类清零、第一类全部通过才能说「环境就绪」：

| 类别 | 含义 |
| --- | --- |
| `passed` | 真实命令跑过并成功（含重建持久化 PATH 后的二次诊断） |
| `failed` | 跑过但失败；**必须回到 ENV.PLAN 修计划**，不得宣布完成 |
| `needsHuman` | 历史字段名，表示此脚本未执行；Agent 自动补齐业务查询、页面或编译证据，仅本人登录/系统授权才打断用户 |

「命令能打印版本」不等于可用，最小实证口径：

| 组件 | 最小实证 |
| --- | --- |
| JDK | 用项目源码真实编译一次（`mvn -B -DskipTests compile` 或 `javac`） |
| Maven | 在项目目录 `mvn -B -DskipTests package`，能定位 JDK、能读本地仓库 |
| Node/npm | 项目目录真实 `npm ci` 后构建一次 |
| MySQL/PostgreSQL | 用**应用身份**鉴权连接目标库，建表、插入中文、读回 |
| Tomcat | 部署真实 WAR 后请求业务 URL，HTTP 200 且内容正确 |
| 小程序 | 微信开发者工具里真实打开、编译、预览一次 |
| .NET 桌面 | Windows 上真实构建并启动窗体程序 |

产出字段以主合同生成表为准；方法说明：`diagnose-after.ndjson`、`verify.json`。

## 数据库凭据与本机开发实例

- 本机开发 MySQL **新建**实例默认口令（读取 `conventions.localDemo.password` 的实际值）；该字段的实际值必须在**执行前展示**给用户并记录在计划里。
- 只允许 `bind-address=127.0.0.1`；只用于本机开发，**禁止用于远程或生产**。
- **不得修改已有实例的管理员口令**；**不得覆盖已有 datadir**；已有实例**优先复用**，无法安全复用就输出具体阻塞。
- 口令只经 `0600` 选项文件或 stdin 进入数据库，**不进命令行参数、不进日志、不进报告**；日志里一律 `<redacted>`。

```bash
node scripts/provision-mysql-dev.mjs --datadir <全新的空目录> --port 3307            # 只打印计划与约定
node scripts/provision-mysql-dev.mjs --datadir <全新的空目录> --port 3307 --apply --confirm <planDigest>
```

不加 `--apply --confirm` 时它**只打印**计划与口令约定，一个字节都不写。

## 与业务加固的边界

- ENV.VERIFY 通过只代表「这台机器能跑这个项目」，**不代表业务验收通过**。
- 逐角色、逐页面、逐接口的业务验收属 HARD.GAPS–DIA.SAVE，见 [加固技能](../generated-admin-hardening/WORKFLOW.md)。
- 环境阶段产生的任何「为了跑起来」的改动（放宽权限、改端口、跳校验）都要写进交付说明，不能悄悄留坑。

## 源码文档模式的只读识别

源码文档模式默认不装环境。只做必要识别：语言与构建工具、数据库类型、是否需要图形工具；结果写进 CREATE.C1/CREATE.C2 的事实清单。用户要求本地运行时，按该项目真实依赖进入 ENV；可直接使用 env-only，并说明「这次装的是原项目依赖，不是捷码生成器开发环境」。

## 能力分级（不要把本机验证说成通用能力）

| 能力 | 级别 | 说明 |
| --- | --- | --- |
| macOS 诊断、需求识别、计划、单项执行、复验 | **本地已实测** | 在 macOS 真机跑过，含真实安装→复验→回滚、故障注入、检查点续跑 |
| 修复计划（PATH / 版本 / 服务 / 损坏分类） | **本地已实测（只读与计划模式）** | `repair.mjs` 的真实执行依赖现场；未遇到的现场按 `needsHuman` 记录 |
| Windows 诊断脚本 | **仅静态验证** | 本机无 PowerShell，只做过语法/引号/PS5.1 语法/字段同构检查 |
| WorkBuddy 宿主是否允许自动执行安装命令 | **待真机确认** | 宿主若限制下载或子进程执行，就把计划与准确命令交给用户执行，并如实标注「未执行」 |
| 公开技能包里的「能装」 | **不等于** | 本机 `sudo` 能装 ≠ 别人机器上能装；默认路径一律是 `needs-elevation` 交人执行 |

## 硬约束

1. 不修改用户现有数据库；不安装系统级服务；不 `sudo`；除写入项目级环境脚本外不动系统文件。
2. 不重建、不删除任何已有 datadir；不修改已有实例管理员口令。
3. 不全局改 PATH 顺序；不清空用户环境变量；不卸载用户已有版本。
4. 不用 `curl | bash` 一类远程脚本管道；不做无摘要校验的下载；不关系统安全策略。
5. 下载只认官方域名 + 官方摘要文件；摘要失败即失败。
6. 日志与报告不得出现真实口令/令牌，统一 `<redacted>`。
7. 脚本里不写死用户路径与机器信息，一律用参数或环境变量；技能内部一律用相对路径。
8. 失败要留证据（日志、备份、检查点），并给出可执行恢复步骤。

## 脚本与参考资料

| 文件 | 用途 | 对应阶段 |
| --- | --- | --- |
| [scripts/detect-requirements.mjs](scripts/detect-requirements.mjs) | 扫项目产物 → 本项目所需组件 JSON（凭据 `<redacted>`） | ENV.REQUIREMENTS |
| [scripts/diagnose-macos.sh](scripts/diagnose-macos.sh) | macOS 只读诊断，NDJSON | ENV.DIAGNOSE |
| [scripts/diagnose-windows.ps1](scripts/diagnose-windows.ps1) | Windows 只读诊断（PowerShell 5.1，字段与 macOS 同构） | ENV.DIAGNOSE |
| [scripts/plan.mjs](scripts/plan.mjs) | 需求 + 诊断 → 逐项可授权安装计划 | ENV.PLAN |
| [scripts/repair.mjs](scripts/repair.mjs) | 诊断 → 修复计划（PATH／并行版本／服务／连接／数据损坏分类） | ENV.PLAN |
| [scripts/apply.mjs](scripts/apply.mjs) | 执行**单个**动作：备份 → 下载校验 → 安装/恢复 → 复验 → 失败回滚，检查点可续跑 | ENV.APPLY |
| [scripts/verify.mjs](scripts/verify.mjs) | 新进程复检 + 真实构建 + 数据库鉴权，输出 passed/failed/needsHuman | ENV.VERIFY |
| [scripts/provision-mysql-dev.mjs](scripts/provision-mysql-dev.mjs) | 新建本机开发 MySQL 实例（回环、独立 datadir/端口/账号，先展示约定再执行） | ENV.AUTHORIZE–ENV.APPLY |
| [scripts/check-scripts.mjs](scripts/check-scripts.mjs) | 技能包静态自检（语法、PS5.1 语法、状态词表、字段同构、路径与凭据泄漏、Markdown 链接与 frontmatter） | 发布前 |
| [references/components.md](references/components.md) | 组件 × 平台 × OS 支持矩阵（含明确不支持的项） | ENV.REQUIREMENTS–ENV.PLAN |
| [references/version-matrix.md](references/version-matrix.md) | 版本选型矩阵与官方核对入口 | ENV.VERSIONS |
| [references/tool-matrix.md](references/tool-matrix.md) | 每组件官方来源、安装位置与复验命令 | ENV.PLAN–ENV.APPLY |
| [references/troubleshooting.md](references/troubleshooting.md) | BROKEN / CONFLICT / 部分安装的排障与恢复 | ENV.PLAN、ENV.APPLY |
| [references/install-recipes.md](references/install-recipes.md) | 引用来源与校验方式摘要 | ENV.PLAN |
| [references/failure-recovery.md](references/failure-recovery.md) | 六类故障 → 动作 → 回滚 → 检查点 | ENV.APPLY |
| [references/project-environment.md](references/project-environment.md) | 阶段口径、平台到组件映射、完成定义 | 全阶段 |
| [assets/](assets/mise.toml) | 配置模板：`mise.toml`、`mysql-my.ini`、`postgres-unattend.txt`、`sqlserver-install.ini`、`tomcat-setenv.bat` | ENV.PLAN–ENV.APPLY |
| [SOURCE.md](SOURCE.md) | 素材来源与审查取舍 | 维护 |
