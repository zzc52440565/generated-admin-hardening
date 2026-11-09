# 组件 × 平台 × 操作系统支持矩阵

只列捷码项目会用到的组件。表里的「诊断键」就是 `--components` / `-Components` 里可用的名字。

## 1. 运行时与构建工具

| 诊断键 | 组件 | macOS | Windows | 说明 |
| --- | --- | --- | --- | --- |
| `java` | JDK | 原生 | 原生 | 版本按项目 `release`/`source`/`target`；多版本共存合法 |
| `maven` | Apache Maven | 原生（压缩包/brew） | 原生（压缩包/winget） | 项目有 `mvnw` 时优先用包装器 |
| `gradle` | Gradle | 原生 | 原生 | 项目有 `gradlew` 时优先用包装器 |
| `node` | Node.js | 原生 | 原生 | 版本看 `engines.node` 或构建器要求 |
| `npm` | npm | 随 Node | 随 Node | 还有 `yarn` / `pnpm` 两个诊断键 |
| `git` | Git | 原生 | 原生 | 只在需要拉依赖/版本管理时算必需 |
| `python` | Python 3 | 原生 | 原生 | Windows 上注意 `python3` 的 0 字节占位陷阱 |
| `go` | Go | 原生 | 原生 | 捷码生成器默认不用；真实产物需要才装 |
| `dotnet` | .NET SDK | 原生（仅 SDK，非 Framework） | 原生 | `net5.0+` 可用 `dotnet` CLI |
| `dotnet-framework` | .NET Framework | **不支持** | 原生 | 目标框架是 `net48`/`v4.x` 时只能在 Windows |
| `msbuild` | MSBuild | **不支持** | 需 Visual Studio / Build Tools | 构建 .NET Framework 桌面程序必需 |
| `windows-desktop-runtime` | WinForms/WPF 运行时 | **不支持** | 原生 | 桌面程序只能在 Windows 上跑 |

## 2. 数据库

| 诊断键 | macOS | Windows | 备注 |
| --- | --- | --- | --- |
| `mysql` | 原生 | 原生 | 本机开发实例优先复用；新建实例见 `provision-mysql-dev.mjs` |
| `postgresql` | 原生 | 原生（官方安装器/服务） | macOS 上 Homebrew 的 keg-only 目录默认不在 PATH（典型 `path-invisible`） |
| `sqlite` | 原生（无服务） | 原生（无服务） | 不需要服务端；必须由项目驱动真实打开数据文件验证 |
| `sqlserver` | **不支持服务端** | 原生 | macOS 没有原生 SQL Server，也不能用容器顶替：用 Windows/远程实例 |
| `redis` | 原生 | **无官方原生构建** | Windows 只能用第三方兼容实现或 WSL，属需用户确认的替代方案 |
| `oracle` | 需官方介质 | 需官方介质 | 必须用户提供安装包，技能不代办 |

## 3. 应用服务器与前端工具

| 诊断键 | 组件 | macOS | Windows | 说明 |
| --- | --- | --- | --- | --- |
| `tomcat` | Apache Tomcat | 原生（解压即用） | 原生（解压即用） | **只有外部 WAR 部署才需要**；可执行 JAR 不需要 |
| `wxdevtools` | 微信开发者工具 | 原生（需图形界面登录） | 原生（需图形界面登录） | 有小程序交付目标才需要；编译必须人工 |

## 4. 明确不支持或不能自动化的项

| 项 | 结论 | 正确处理 |
| --- | --- | --- |
| macOS 上安装 SQL Server 服务端 | **不支持**（无原生版本，也不引入容器） | 用用户确认的 Windows/远程实例；或与用户确认换 PostgreSQL |
| Windows 上安装官方 Redis | **不支持**（无官方原生构建） | Memurai/WSL 等第三方方案必须先和用户确认，不能静默安装 |
| 非 Windows 上构建 .NET Framework 桌面程序 | **不支持** | 换 Windows 机器或远程构建机 |
| 微信小程序真实编译 | **无法自动化** | 用户在开发者工具里导入、编译、预览 |
| Oracle 数据库 | **无法自动下载** | 用户提供官方介质与实例信息 |
| 需要 `sudo` / 管理员 / 系统服务的安装 | **不由技能代跑** | 输出准确命令，由用户亲自提权执行 |
| 修改已有数据库管理员口令、重建已有 datadir | **禁止** | 交用户选择备份/迁移/专门恢复方案 |

## 5. 平台 → 组件（以真实产物为准，本节只是起点）

| 捷码平台 | 建项前重点分诊 | 下载后按产物追加 |
| --- | --- | --- |
| `SPRING_BOOT`、`SPRING_BOOT3`、`BOOT`、`BOOT2` | Java、Maven、所选数据库 | 实际 `pom.xml`；可执行 JAR 不需要外部 Tomcat |
| `SSM`、`SSM3`、`JAVA_WEB`、`JAVA_WEB3` | Java、Maven、所选数据库 | `packaging=war` → 按 servlet 命名空间选 Tomcat 9/10.1/11 |
| `VUE`、`VUE_WXAPP` | Java、Maven、Node、npm、所选数据库 | 真实 `package.json` 的 Node 版本；小程序目标还需微信开发者工具 |
| `JAVA_SWING` | Java、Maven、所选数据库 | 桌面启动与 JDBC 连接，无需浏览器/Tomcat |
| `C_SHARP`、`C_SHARP2` | Windows、.NET Framework/MSBuild、所选数据库 | 实际 `.csproj` 的 `TargetFrameworkVersion` |

判定原则：**项目声明优先于"装最新"**；平台能力与本文不一致时以捷码 `platform_catalog` 的实时结果为准。
