# 安装配方：官方来源、校验方式、装到哪里、怎么复验

所有配方都遵守三条：**只装到独立前缀**、**只从官方域名下载并校验官方摘要**、**只装当前项目真正需要的组件**。
需要管理员权限的方式（Homebrew 全局安装、winget 全局安装、系统服务、`.dmg`/`.msi` 安装器）一律标为**由用户亲自执行**，技能不代跑提权。

## 0. 版本必须先查官方目录，不能凭记忆写死

**本机实测（2026-11-06）**：Apache 的 `dlcdn` 只保留近期版本。计划里写 `maven=3.9.9` 时归档与摘要都返回 **404**；当时目录里可用的是 `3.9.16` 与 `3.10.0`，Tomcat 10 线是 `10.1.61`。

因此：

```bash
# 现场解析官方目录里最新的稳定补丁版，而不是用记忆中的版本号
node scripts/plan.mjs ... --resolve-versions
```

`plan.mjs --resolve-versions` 只读官方目录 HTML，解析失败就退回显式 `--versions`，不会静默换成第三方镜像。

## 1. Apache Maven

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://dlcdn.apache.org/maven/maven-3/<版本>/binaries/apache-maven-<版本>-bin.tar.gz`（Windows 用 `-bin.zip`） |
| 校验材料 | 同目录同名 `.sha512` 文件（**本机实测存在**：3.9.16 的 sha512 为 `831a8591…b6f6`） |
| 安装位置 | 独立前缀，如 `<独立前缀>/apache-maven-<版本>/`（解压即用） |
| 复验 | `<前缀>/apache-maven-<版本>/bin/mvn -v`；再在项目里跑 `mvn -B -DskipTests package` |
| 备注 | 项目带 `mvnw` 时优先用包装器，不必全局安装 |

可用动作：`apply.mjs` 的 `download-verified-archive`（下载 → sha512 → 解压 → `mvn -v`）。

## 2. JDK（Temurin / Adoptium）

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://adoptium.net/temurin/releases/`（API：`https://api.adoptium.net/v3/info/available_releases`，本机实测可达） |
| 校验材料 | 官方 releases 页提供 SHA256 清单 |
| 安装位置 | macOS `<独立前缀>` 下解压；或用户自行安装 `.pkg`（需管理员） |
| 复验 | `java -version` + 用项目源码真实编译一次 |

版本按项目 `maven-compiler-plugin` 的 `release`/`source`/`target` 定；项目没写时按 Spring / servlet 命名空间推断，并标注「推断」。

## 3. Node.js / npm

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://nodejs.org/dist/`（索引 `https://nodejs.org/dist/index.json`，本机实测可达） |
| 校验材料 | 同目录 `SHASUMS256.txt` |
| 安装位置 | `<独立前缀>/node-v<版本>-<平台>/` |
| 复验 | `node -v`、`npm -v`，再在项目里真实 `npm ci` + 构建 |

Windows 注意：`WindowsApps\python.exe` 式的 0 字节占位同样出现在别处；Node 若通过商店别名安装，`node -v` 可能指向占位符。

## 4. Apache Tomcat（只在外部 WAR 部署时需要）

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://dlcdn.apache.org/tomcat/tomcat-<大版本>/v<版本>/bin/apache-tomcat-<版本>.tar.gz`（本机实测目录可达） |
| 校验材料 | 同目录 `.sha512` |
| 版本选择 | `jakarta.servlet` 6.0/6.1 → Tomcat 10.1/11；`javax.servlet` 4.0 → Tomcat 9 |
| 安装位置 | `<独立前缀>/apache-tomcat-<版本>/`，按需 `bin/startup.sh`，**不注册开机自启** |
| 复验 | 部署真实 WAR → 请求业务 URL → HTTP 200 且页面内容正确 |

Windows 补充（**未在 Windows 实测，属官方文档结论**）：要用服务方式运行必须下载 `-windows-x64.zip`，基础 zip 不含 `service.bat`/`tomcat<major>.exe`；`service.bat install` 注册的服务以 `LocalService` 运行，需要对安装目录的写权限；`JRE_HOME` 的优先级高于 `JAVA_HOME`。这些都需要管理员权限，属 `needs-elevation`。

## 5. MySQL

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://dev.mysql.com/downloads/mysql/`（社区版压缩包，Windows 有 ZIP） |
| 校验材料 | 官方下载页提供 MD5/SHA256 |
| macOS | `brew install mysql` 属**用户亲自执行**的全局安装；本技能默认走"独立前缀 + 独立 datadir + 独立端口" |
| 复验 | `select @@version, @@bind_address, @@port`；建表插入中文读回 |

本机开发实例只允许：

```bash
node scripts/provision-mysql-dev.mjs --datadir <全新空目录> --port 3307            # 先打印计划与口令约定
node scripts/provision-mysql-dev.mjs --datadir <全新空目录> --port 3307 --apply --confirm <planDigest>
```

硬规则：`bind-address=127.0.0.1`；不得改已有实例管理员口令；不得覆盖已有 datadir；已有实例优先复用。
**实测发现的一种现场**：实例在跑，但它的安装目录已经被删（进程仍持有已删除的可执行文件）——此时只能复用"运行中的实例"，不能复用二进制，也不该新建第二个。

## 6. PostgreSQL

| 项 | 值 |
| --- | --- |
| 官方来源 | `https://www.postgresql.org/download/`（Windows 安装器 / macOS 用 Homebrew） |
| 校验材料 | 官方下载页提供校验和 |
| macOS 注意 | Homebrew 的 `postgresql@<版本>` 是 keg-only：`psql` 不在默认 PATH（典型 `path-invisible`，**不是没装**） |
| 大版本升级 | 必须 `pg_dumpall` + 新集群导入，**禁止原地覆盖** |
| 复验 | `pg_isready` + `psql -w` 免交互登录 + 建表插中文读回，并确认 `listen_addresses=localhost` |

## 7. 明确不自动做的

| 项 | 原因 |
| --- | --- |
| Homebrew / winget 全局安装 | 改动系统级目录，属 `needs-elevation`，交用户执行 |
| 系统服务注册（`brew services`、`sc create`、`mysqld --install`） | 系统级副作用，需单独授权 |
| `.pkg` / `.msi` / SQL Server 安装器 | 图形/无人值守安装器会写系统目录，交用户 |
| 任何 `curl … \| bash`、`irm … \| iex` | 无法校验、不可回滚 |
| 无摘要的下载 | 无法证明来源与完整性 |
| 修改已有数据库管理员口令、重建已有 datadir | 破坏性、不可逆 |

## 8. 复验命令模板（技能自带的 `verify.mjs` 用的就是这些）

```bash
mvn -B -DskipTests package          # Java 项目真实编译打包
node -v && npm -v && npm ci          # 前端
mysql --defaults-extra-file=<0600 文件> -h 127.0.0.1 -P <端口> -e "select 1"
psql "service=<0600 文件>"           # PostgreSQL 同理
curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:<端口>/<业务路径>   # Tomcat
```

口令只经 `0600` 选项文件或 stdin，**不出现在 argv 与日志里**。
