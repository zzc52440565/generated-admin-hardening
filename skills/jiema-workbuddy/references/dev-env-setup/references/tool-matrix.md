# 原生安装对照表（不使用容器）

本页是 ENV.PLAN 的取材表：每个组件在 macOS / Windows 上的**官方来源、推荐安装位置、复验命令**。它描述「怎么做」，是否执行由 ENV.AUTHORIZE 授权与 ENV.APPLY 决定。

## 通用规则（先读这一节，再看具体组件）

1. **优先用户级前缀**：本项目一律装在 `<独立前缀>`（例如用户主目录下的 `jiema-env/`）里，不写系统目录、不注册系统服务、不改全局 PATH 顺序。
2. **下载必须校验**：官方 `.sha256` / `.sha512` sidecar 或安装器自带签名；拿不到摘要就把该动作列为阻塞，不装。
3. **不用 `curl | bash`**：包括 Homebrew 安装器。macOS 上由用户在自己的终端执行官方安装命令，技能只给出命令与影响说明。
4. **项目包装器优先**：项目自带 `mvnw` / `gradlew` / `.nvmrc` 时先用它，不要先装全局工具。
5. **服务类组件优先「按需前台启动」**，不注册开机自启；必须注册服务时归入 `needs-elevation`，由用户执行。
6. 一次只做一个组件；同一组件多版本共存合法，不卸载旧版本。

## 1. 包管理器 / 基础

| 平台 | 官方入口 | 备注 |
| --- | --- | --- |
| macOS | https://brew.sh （安装命令由用户执行） | 需要 Xcode 命令行工具；老系统多为源码编译 |
| Windows | `winget`（系统自带「应用安装器」） | 1809 (17763)+；没有就用官方安装包 |

包管理器本身不是必需项：用户级前缀 + 官方压缩包可以完全替代它。

## 2. 运行时

### JDK（Temurin）

| 平台 | 来源 | 安装方式 | 复验 |
| --- | --- | --- | --- |
| macOS | `https://api.adoptium.net/v3/binary/latest/<版本>/ga/mac/<arch>/jdk/hotspot/normal/eclipse` | 解压到 `<前缀>/jdk-<版本>`，项目级环境脚本设 `JAVA_HOME` | `<前缀>/jdk-<版本>/Contents/Home/bin/java -version` + 真实 `javac`/`mvn compile` |
| Windows | `https://api.adoptium.net/v3/binary/latest/<版本>/ga/windows/x64/jdk/hotspot/normal/eclipse` | 解压 zip 到 `<前缀>\jdk-<版本>` | 同上 |

摘要：Adoptium 提供 `.sha256.txt`，随下载一并校验。

### Maven

| 平台 | 来源 | 安装方式 | 复验 |
| --- | --- | --- | --- |
| 全平台 | `https://dlcdn.apache.org/maven/maven-3/<版本>/binaries/apache-maven-<版本>-bin.<zip|tar.gz>` | 解压到 `<前缀>/apache-maven-<版本>`，项目内包装器或项目级 PATH 指向 `bin` | `mvn -v` + 在项目目录 `mvn -B -DskipTests package` |

Maven 需要先有 JDK；`JAVA_HOME` 必须指向真实 JDK（不是转发壳、不是 JRE）。

### Node.js

| 平台 | 来源 | 安装方式 | 复验 |
| --- | --- | --- | --- |
| 全平台 | 官方 `nodejs.org/dist/<版本>/` 归档，或 `fnm`/`nvm` 用户级版本管理器 | 解压到 `<前缀>/node-<版本>` | `node -v`、`npm -v`，再在项目里 `npm ci` + 构建 |

### Python

| 平台 | 来源 | 安装方式 | 复验 |
| --- | --- | --- | --- |
| macOS | 官方 pkg 或 `python-build-standalone` | 用户级前缀 | `python3 -V` + 项目虚拟环境创建 |
| Windows | 官方 embeddable/安装器，或 `python-build-standalone` | 用户级前缀 | 同上；注意 `python3` 可能指向 0 字节商店占位 |

### Go

| 平台 | 来源 | 安装方式 | 复验 |
| --- | --- | --- | --- |
| macOS | `https://go.dev/dl/go<版本>.<os>-<arch>.tar.gz` | 解压到 `<前缀>/go` | `go version`、`go env GOPROXY` |
| Windows | 官方 MSI 或 zip | 解压到 `<前缀>\go` | `go version`；`go get` 失败先查代理 |

## 3. 数据库

### MySQL（本机开发实例）

| 平台 | 来源 | 说明 |
| --- | --- | --- |
| macOS | 官方 tar.gz / Homebrew | 新建实例用 `scripts/provision-mysql-dev.mjs`：独立 datadir、独立端口、只绑 `127.0.0.1` |
| Windows | 官方 `mysql-<版本>-winx64.zip` | 解压到 `<前缀>\mysql-<版本>`，用 `assets/mysql-my.ini` 渲染配置 |

硬约束：

- 只允许 `bind-address=127.0.0.1`；配置模板同时设 `mysqlx-bind-address=127.0.0.1`。
- **不得修改已有实例的管理员口令**，**不得覆盖已有 datadir**；已有实例优先复用。
- 口令只经 `0600` 选项文件或 stdin 进入数据库，**不进命令行参数、不进日志**。
- 本机开发新建实例的约定口令是 `conventions.localDemo.password`，执行前必须向用户展示读取到的实际约定值，且仅限本机开发。
- 初始化后 `lower_case_table_names` 不可改，Windows 常规取 `1`。

### PostgreSQL

| 平台 | 来源 | 说明 |
| --- | --- | --- |
| macOS | Homebrew `postgresql@<大版本>`（keg-only） | `psql` 需显式 `PATH`；超级用户是当前 macOS 用户 |
| Windows | 官方安装器（EnterpriseDB） | 必须 `--override` 透传无人值守参数，见 `assets/postgres-unattend.txt` |

- 程序目录与数据目录分开（升级程序保留数据）。
- 大版本升级不能原地替换：`pg_dumpall` → 新集群 → 导入。
- 超级用户口令**必须由用户提供**，技能不设默认弱口令；`listen_addresses=localhost`。

### SQL Server（仅 Windows）

- 来源：官方 ISO / 安装器；无人值守参数见 `assets/sqlserver-install.ini`。
- `SAPWD` 有复杂度策略（≥8 位、三类字符），由用户提供。
- macOS 无原生版本：VM / 远程实例 / 换 PostgreSQL，由用户选。
- ARM64 Windows 无官方支持，不承诺能装。

### SQLite

- 无服务、无安装：由项目驱动真实打开数据文件验证（建表、写中文、读回）。

## 4. 应用服务器

### Tomcat（仅外部 WAR 部署需要）

| 平台 | 来源 | 说明 |
| --- | --- | --- |
| 全平台 | `https://dlcdn.apache.org/tomcat/tomcat-<大版本>/` 当前补丁版 | 解压即用；不注册服务，按需 `bin/startup.sh` / `startup.bat` |
| Windows | 必须 `-windows-x64.zip` | 只有它含 `service.bat`；注册服务需管理员 |

- 包命名空间：`javax.servlet` → 9.0；`jakarta.servlet` → 10.1 / 11.0。
- `setenv.bat` 必须同时写 `JAVA_HOME` 与 `JRE_HOME`（`service.bat` 优先读 `JRE_HOME` 且不加载 setenv），模板见 `assets/tomcat-setenv.bat`。
- 端口冲突先查占用进程，再改 `server.xml` 的首个非 AJP Connector（改前备份）。

### 微信开发者工具

- 官方下载安装；**真实编译必须人工在图形界面完成**，脚本无法代替。
- 只有小程序交付目标才需要。

## 5. 连接与凭据

- 连接串写在项目配置或 `0600` 的选项文件里，不进命令行、不进日志、不进报告。
- 复验连接一律用**应用身份**，不是管理员身份；建表、插入中文、读回并按需核对 `CHAR_LENGTH`/`LENGTH`。
- 报告里所有口令、令牌统一 `<redacted>`。

## 6. 常见「看似装好其实不可用」

| 现象 | 真因 | 处理 |
| --- | --- | --- |
| `java -version` 有输出但 `mvn` 报找不到 JDK | `JAVA_HOME` 指向 JRE 或转发壳 | 指向真实 JDK 根目录，重新 `mvn -v` |
| `mvn -v` 正常但 `mvn compile` 报 release 版本不支持 | 生效 JDK 低于项目 `release` | 装匹配版本，用项目级 `JAVA_HOME` 指向它 |
| `node -v` 正常但 `npm ci` 失败 | 项目要求更高主版本或私有源不可达 | 按 `engines.node` 装对应版本；私有源需用户提供凭据 |
| `psql` 找不到 | keg-only 未进 PATH | 把 Homebrew 的 `bin` 加进项目级环境脚本 |
| MySQL 服务 Running 但连接被拒 | 只绑 `127.0.0.1` 却用外部地址连；或认证插件不匹配 | 用回环地址；按驱动版本确认认证插件 |
| Tomcat 服务 Running 但页面 404 | WAR 未部署或 context path 不对 | 查 `webapps` 与 `server.xml`，请求真实业务 URL |
