# 项目环境：口径、映射与完成定义

本文件是技能主文件（仓库里是 `SKILL.md`，发布包里重命名为 `WORKFLOW.md`）的配套说明：讲清什么时候做、按什么映射、什么算完成。
组件的平台支持请看 [components.md](components.md)，安装与校验方式看 [install-recipes.md](install-recipes.md)，故障处理看 [failure-recovery.md](failure-recovery.md)。

## 一、阶段点（环境阶段 = 状态机阶段组 ENV.REQUIREMENTS–ENV.VERIFY）

| 阶段 | 何时 | 允许做什么 | 明确不做 |
| --- | --- | --- | --- |
| 纯需求预演 | 用户还在看业务/权限/技术栈方案 | 一句话说明后续会检查本机 | 不扫本机、不安装、不要求用户先装环境 |
| ENV.REQUIREMENTS 算组件 | 源码已下载（强制入口） | 读 `pom.xml`/`build.gradle`/`package.json`/`*.csproj`/数据库配置，只提依赖与版本 | 不沿用建项前的猜测；不回显任何口令 |
| ENV.DIAGNOSE 只读诊断 | ENV.REQUIREMENTS 完成 | 查操作系统、架构、安装、版本、持久化 PATH、服务与连接状态（十态） | 不安装、不修复、不启动服务、不读口令 |
| ENV.VERSIONS 选版本 | ENV.DIAGNOSE 完成 | 按项目约束与机器上限选兼容版本，写选型报告 | 不静默换版本；不谎称已核对官方页面 |
| ENV.PLAN 出计划 | 组件清单与版本已定 | 分清全新安装/增量补齐/损坏修复，逐项写清九项要素 | 不把「装全套」当计划；不给没有摘要的下载 |
| ENV.AUTHORIZE 取得授权 | 计划无阻塞项 | 逐项授权；本机开发数据库约定口令原样展示 | 不代勾选完全访问；不把一次授权扩大成全家桶 |
| ENV.APPLY 执行 | 用户对该项动作授权后 | 一次一个 action：备份 → 校验 → 安装/恢复 → 复验；失败回滚并留检查点 | 批量执行、连锁重试、换第三方镜像、代跑提权 |
| ENV.VERIFY 复验 | ENV.APPLY 动作完成 | 新终端复诊 + 真实构建 + 数据库鉴权 + 启动业务页 | 用「服务 Running」代替页面正确 |

ENV.REQUIREMENTS 之前不得进入 HARD.GAPS；ENV.VERIFY 未通过不得交付（见技能主文件与 `mode-routing.json` 的 G10/G11）。

阶段边界：本阶段**不改变**捷码授权、额度与建项结果；**环境通过 ≠ 业务验收通过**。

## 二、平台 → 组件（起点，不是结论）

| 捷码平台 | ENV.REQUIREMENTS 起点 | ENV.REQUIREMENTS 按产物追加 |
| --- | --- | --- |
| `SPRING_BOOT` / `SPRING_BOOT3` / `BOOT` / `BOOT2` | Java、Maven、所选数据库 | 实际 `pom.xml`；可执行 JAR 不需要外部 Tomcat |
| `SSM` / `SSM3` / `JAVA_WEB` / `JAVA_WEB3` | Java、Maven、所选数据库 | `packaging=war` → 按 servlet 命名空间定 Tomcat 9 / 10.1 / 11 |
| `VUE` / `VUE_WXAPP` | Java、Maven、Node、npm、所选数据库 | 真实 `package.json` 的 Node 版本；有小程序目标还要微信开发者工具 |
| `JAVA_SWING` | Java、Maven、所选数据库 | 桌面启动 + JDBC 连接，不用浏览器/Tomcat |
| `C_SHARP` / `C_SHARP2` | Windows、.NET Framework/MSBuild、所选数据库 | `.csproj` 的 `TargetFrameworkVersion`；macOS 不能原生运行 |

> 平台目录版本与本文不一致时，以捷码 `platform_catalog` 的实时结果为准。

## 三、诊断口径

```bash
bash scripts/diagnose-macos.sh --components java,maven,mysql --project <项目目录> --java-major 17 --json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-windows.ps1 -Components java,maven,mysql -JavaMajor 17 -Json
```

判定口径（易错，逐条都要遵守）：

1. **持久化 PATH 才算用户环境**：macOS 读 `/etc/paths`、`/etc/paths.d/*` 与 shell 配置；Windows 读注册表 `Machine`+`User`。宿主/IDE 注入的 PATH 单独标出。
2. **多版本共存不是冲突**：生效版本满足要求即 `ok`，其余记为备用。
3. **转发壳不算第二份**：`/usr/bin/java`、`javapath`、`WindowsApps` 的 0 字节占位都不参与"装了几份"的计数。
4. **能打印版本 ≠ 可用**：`ok` 只代表"可以进入复验"。
5. 十种状态与对应动作见技能主文件的状态词表；诊断脚本只输出这十种。

## 四、完成定义

必须同时成立：

- 每个必需组件在**新子 shell**（按持久化 PATH 重建）里重新诊断仍为 `ok`；
- 项目真实构建通过（Maven/Gradle/前端/桌面各自的入口）；
- 需要的数据库用**应用身份**完成真实鉴权连接 + 一次业务级读写；
- 目标入口真实启动并通过业务操作（WAR 部署后的页面、小程序编译预览、桌面程序窗口）；
- 失败或未验证的项写清当前检查点、阻塞原因与下一步。

以下**都不算**完成：诊断脚本退出 0、`java -version` 能打印、服务 `Running`、端口能连、首页返回 200、只有 `passed` 没有 `needsHuman` 的复核。

Agent 在 `verify.json` 补齐实测项时保留原脚本结果并逐项引用真实回执。文件引用使用 `evidence` 非空数组，路径为绝对路径或相对 `verify.json` 所在目录；登记前核对文件实际存在、非空，区分工程根与其父目录。检查点会拒绝无效文件引用，文件存在仍不能代替真实执行。恢复命令须指向已存在的配置和实例；已有非空数据目录只能按现有配置启动，不能把初始化命令写成重启步骤。

## 五、能力分级（沿用 SKILL.md 的口径）

- **本地已实测**：macOS 上的诊断、需求识别、计划、单项执行（真实安装 + 摘要校验 + 复验 + 回滚）、故障注入、安装失败与检查点续跑。
- **仅静态验证**：Windows 诊断脚本（本机无 PowerShell，只做语法/引号/PS5.1 禁用语法/字段同构检查）。
- **尚待真机**：WorkBuddy 宿主是否允许子进程下载与执行；不允许时把计划与准确命令交用户，并如实标注"未执行"。
