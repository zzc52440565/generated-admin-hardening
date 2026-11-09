# 版本选型矩阵（项目约束 → 机器上限 → 该装哪个版本）

本页回答一个问题：**这台机器上，每个组件最高能装到哪个版本，本次实际该选哪个**。它是 ENV.VERSIONS 阶段的依据表，不是安装脚本。

## 三条铁律

1. **不凭记忆报版本号。** 下表是基线快照；有网络时必须按 §4 的官方入口核对，以官方为准。没联网就在报告里写「未联网核对，按基线矩阵选定」。
2. **只降不升。** 项目或用户指定的版本不满足本机要求时，报告冲突并给出最低可行版本，等用户确认，不静默替换。
3. **先看项目约束，再看系统上限。** 系统只决定「最高能装到哪」，项目决定「应该装哪个」。`maven.compiler.release`、Spring Boot 版本、`.nvmrc`、`engines.node` 都比「装最新版」优先。

## 1. 采集系统事实

**macOS**

```bash
sw_vers -productVersion                 # 10.15.7 / 12.7 / 14.5
uname -m                                # arm64 / x86_64
sysctl -n hw.memsize | awk '{print $1/1073741824" GB"}'
df -Pk "$HOME" | awk 'NR==2{print "可用 "int($4/1048576)" GB"}'
xcode-select -p                         # 无输出＝缺命令行工具，源码编译会失败
```

**Windows**

```powershell
(Get-CimInstance Win32_OperatingSystem).Caption
[System.Environment]::OSVersion.Version.Build        # 只用 build 号判定，不看营销名
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
[math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,1)
[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1GB,1)
winget --version
```

判读要点：

- Windows 只看 **build 号**（`Caption` 在部分版本会误报）。
- `OSArchitecture = Arm64` 的 Windows 上，MySQL / SQL Server 官方二进制都是 x64，靠仿真跑，**不在官方支持范围**。
- Apple 芯片装 SQL Server 服务端无解（无原生版；技能也不引入容器，见 `components.md`）。

## 2. 判定算法（按顺序执行）

```
① 硬约束过滤：OS 大版本 / build 号 / CPU 架构 / 包管理器是否存在
     → 不满足的候选直接淘汰，并记录淘汰原因
② 软约束过滤：内存 < 4GB、磁盘不足、需要源码编译
     → 降级或提示，不淘汰
③ 项目约束覆盖：读项目里的版本声明；与①冲突时报冲突，不装
④ 在剩下的候选里取最新 LTS（不是最新版；避开非 LTS 的 .0 首发）
⑤ 写入选型报告，注明「选它 / 为什么不选更高的」
```

「最新」不等于「最好」：JDK 选 LTS（8/11/17/21/25），Node 选 LTS 偶数版，MySQL 选 LTS（8.4），SQL Server 选 Developer，Tomcat 选当前稳定大版本并把 JDK 要求一起算，Go 只取最近两个大版本，PostgreSQL 没有 LTS 概念、按 5 年支持期从高往低取。

## 3. 组件矩阵（基线：2026 年 11 月，装机前必须核对官方）

### JDK（Eclipse Temurin）

| 版本 | macOS 最低 | Windows 最低 | 备注 |
| --- | --- | --- | --- |
| 25 (LTS) | 11（arm64）/ 10.15（x64） | 10 1809 (17763)+ | 确认构建工具链支持再选 |
| 21 (LTS) | 10.15（arm64 实为 11+） | 10 1809 (17763)+ | **默认推荐**，生态兼容最好 |
| 17 (LTS) | 10.15 | 10 (10240)+ | 老项目、老 macOS 的稳妥选择 |
| 11 / 8 | 10.13 | 7+ | 仅遗留系统 |

Apple 芯片需要 arm64 构建（Temurin 提供）；Intel 机器注意别装成 aarch64 包。

### Maven

| 版本 | 前提 | 备注 |
| --- | --- | --- |
| 4.x | JDK 17+ | 4.0 起要求 Java 17，老项目别升 |
| 3.9.x | JDK 8+ | **默认推荐**，与 JDK 8/11/17/21 都兼容 |

Maven 版本受 JDK 限制，不受 OS 限制。项目自带 `mvnw` 时优先用包装器，不必装全局 Maven。

### Python

| 版本 | macOS 最低 | Windows 最低 | 备注 |
| --- | --- | --- | --- |
| 3.13 | 11 | 10+ | 部分老库无轮子 |
| 3.12 | 10.15 | 8.1+ | **默认推荐** |
| 3.11 | 10.15 | 8.1+ | 兼容性最稳的备选 |
| ≤3.9 | 10.13 | 7+ | 已 EOL，仅维护老项目 |

### Node.js

| 版本 | macOS 最低 | Windows 最低 | 备注 |
| --- | --- | --- | --- |
| 24 (LTS) | 11 | 10+ | 新项目可选 |
| 22 (LTS) | 11 | 10+ | **默认推荐** |
| 20 (LTS) | 10.15 | 10+ | 接近 EOL，新项目不选 |

### MySQL

| 版本 | macOS 支持范围 | Windows 支持范围 | 备注 |
| --- | --- | --- | --- |
| 8.4 LTS | 官方「最近两个大版本」滚动窗口，且以 arm64 为主 | 10/11 最新（1809+，x64）/ Server 2016+ | **默认推荐**；默认认证插件 `caching_sha2_password` |
| 8.0 | 同上 | 同上 | 老驱动（`mysql-connector-java` 5.x）的退路 |
| 5.7 | 已停止构建 | 7+ | 已 EOL，仅遗留系统 |
| 9.x 创新版 | 同 8.4 | 同 8.4 | 非 LTS，生产/团队环境不选 |

- 官方 macOS 支持范围是**滚动窗口**，装机前必须打开官方平台页确认当前窗口，不要照抄本表的版本号。
- Intel Mac 上没有官方 macOS 构建，社区构建出问题官方不兜底。
- Windows 只有 x64 包；ARM64 能装但靠仿真。
- `lower_case_table_names` 初始化后不可改（Windows 常规取 `1`）。

### PostgreSQL

| 版本 | 发布 | EOL（官方） | 备注 |
| --- | --- | --- | --- |
| 18 | 2025-09 | 2030-11 | 最新稳定；注意驱动/扩展兼容 |
| 17 | 2024-09 | 2029-11 | **默认推荐** |
| 16 | 2023-09 | 2028-11 | 稳妥备选 |
| 15 | 2022-10 | 2027-11 | 只剩一年 |
| ≤14 | — | 已 EOL 或临近 | 仅遗留系统 |

版本读法：`PostgreSQL 17.11` 里 **17 是主版本、11 是补丁**。小版本升级直接换二进制；大版本升级必须 `pg_dumpall` + 新集群导入。

平台要求：Windows 10 / Server 2016+（x64）；macOS 走 Homebrew，`postgresql@17` 是 **keg-only**（`psql` 不在默认 PATH，典型 `path-invisible`），且 Homebrew 的超级用户是当前 macOS 用户。

### Tomcat

| 大版本 | 状态 | 所需 JDK | 包命名空间 | 备注 |
| --- | --- | --- | --- | --- |
| 11.0 | 当前稳定，默认推荐 | JDK 17+ | `jakarta.*` | 新项目首选 |
| 10.1 | 维护中 | JDK 11+ | `jakarta.*` | 大量现存项目 |
| 9.0 | 2027-03 EOL | JDK 8+ | `javax.*` | 只在必须跑 `javax.servlet` 时用 |
| 10.0 | 已于 2022-10 EOL | JDK 11+ | `jakarta.*` | 不要选 |

三条硬约束：

1. **包名不兼容**：9 用 `javax.servlet.*`，10/11 用 `jakarta.servlet.*`；升级要改 import 和依赖，不是换个 Tomcat 就能跑。
2. **Windows 必须下 `-windows-x64.zip`**：基础包不含 `service.bat`，注册不了服务。
3. **无包管理器入口**：只能从 `dlcdn.apache.org` 解析当前补丁版再下压缩包。

### Go

只维护**最近两个大版本**（新大版本发布当天最老的立即 EOL）。Windows 需 10+；Homebrew 的 `go` bottle 要求 macOS 12+。

`GOPROXY` 会伪装成版本问题：默认源在国内常返回 502，症状是「`go version` 正常、`go build` 本地代码正常、一 `go get` 就报错」。这不是版本装错。

### SQL Server（仅 Windows 原生）

| 版本 | Windows 最低 | 备注 |
| --- | --- | --- |
| 2025 | 10 1607+ / Server 2016+ | 按官方文档核对 |
| 2022 Developer | 10 1607+ / Server 2016+ | **默认推荐**，免费且功能等同企业版 |
| 2019 | 10 1607+ / Server 2016+ | 老项目兼容 |

- ARM64 Windows 无官方支持。
- macOS 无原生版本 → Windows 虚拟机 / 远程实例 / 换 PostgreSQL，三选一，由用户决定。
- 安装账号密码有策略要求：≥8 位且含大写/小写/数字/符号中三类；常见弱口令会被直接拒绝，口令必须由用户提供。

### Redis

| 平台 | 条件 |
| --- | --- |
| macOS | `brew install redis`；老系统要源码编译 |
| Windows | **无官方原生版**：Memurai 或 WSL，属需用户确认的替代方案 |

### 包管理器自身的前置条件

| 工具 | 前置 | 不满足时 |
| --- | --- | --- |
| Homebrew | macOS 13+ 有预编译瓶 | 老系统多为源码编译，装 MySQL 8.4 常因缺依赖失败 |
| winget | Windows 10 1809 (17763)+ 且已装「应用安装器」 | Win7/8/Server 2016 只能手工安装包 |
| mise | macOS 11+ / Windows 10+ | 更老系统回到手工解压安装 |

## 4. 磁盘与内存预算

| 组件 | 安装后占用 | 运行内存 |
| --- | --- | --- |
| JDK | 0.3 GB | 0.3–1 GB |
| Maven | 0.02 GB（`~/.m2` 通常 1–3 GB） | 0.5–1.5 GB |
| Python | 0.2 GB | 0.1–0.5 GB |
| Node | 0.1 GB（`node_modules` 每项目数百 MB） | 0.2–1 GB |
| Go | 0.6 GB（`GOPATH/pkg/mod` 随项目增长） | 0.3–1 GB |
| Tomcat | 0.03 GB（+ `webapps` 展开） | 0.2–1 GB |
| MySQL | 0.8 GB（+ 数据目录） | 0.5–2 GB |
| PostgreSQL | 0.35 GB（+ 数据目录与 WAL） | 0.3–1 GB |
| SQL Server + SSMS | 8–10 GB | 2–4 GB |

闸门建议：**磁盘可用 < 6 GB 拒绝安装**（含 SQL Server 时 < 15 GB）；**内存 < 4 GB 只装命令行运行时**，不装 SQL Server。

## 5. 官方核对入口（有网络时至少核对一个）

| 组件 | 官方页面 |
| --- | --- |
| Temurin JDK | https://adoptium.net/support/ |
| MySQL | https://www.mysql.com/support/supportedplatforms/database.html |
| PostgreSQL | https://www.postgresql.org/support/versioning/ |
| Tomcat | https://tomcat.apache.org/whichversion.html · https://dlcdn.apache.org/tomcat/ |
| Go | https://go.dev/dl/ · https://go.dev/doc/devel/release |
| SQL Server | https://learn.microsoft.com/sql/sql-server/install/hardware-and-software-requirements-for-installing-sql-server |
| Node.js | https://nodejs.org/en/about/previous-releases |
| Python | https://devguide.python.org/versions/ |
| Maven | https://maven.apache.org/docs/history.html |
| Homebrew 支持范围 | https://docs.brew.sh/Support-Tiers |
| winget 要求 | https://learn.microsoft.com/windows/package-manager/winget/ |

只查「Supported platforms / System requirements」一节，不看博客与第三方教程。没联网就写名未核对。

## 6. 选型报告模板（ENV.VERSIONS 输出，必须给用户看）

```
| 组件 | 候选（高→低） | 本机硬约束 | 淘汰原因 | 选定 | 依据 |
|------|--------------|-----------|---------|------|------|
| java | 25 / 21 / 17 | macOS 12.7 arm64 | 项目用 Spring Boot 3.2 → 需 17+ | 21 | 项目约束 + Temurin 21 支持 macOS 11+ |
| mysql | 8.4 / 8.0 | macOS 12.7 | 8.4 需更新系统 → 淘汰 | 8.0 | 官方平台要求 |
| tomcat | 11.0 / 10.1 / 9.0 | 已有 JDK 21 | 9.0 是 javax，项目用 jakarta → 淘汰 | 11.0 | 项目包名 + 11 需 JDK 17+ |
| sqlserver | 2022 | macOS | 无原生版本 | 不安装 | 交用户选 VM/远程/换 PostgreSQL |
```

最后一行必须写清「本次不装什么、为什么」。Windows 上还要写**端口**与**服务名**（`Tomcat11`、`postgresql-x64-17`），否则用户后续 `Get-Service` 找不到东西。
