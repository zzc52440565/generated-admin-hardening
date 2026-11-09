# 排障手册：BROKEN / CONFLICT / 部分安装现场

用于 ENV.PLAN 的「损坏修复」分类与 ENV.APPLY/ENV.VERIFY 的失败恢复。所有命令都是只读诊断优先；有写入或提权的命令必须归入 `needs-elevation` 或 `needs-user-input`，由用户执行。

## 总原则

1. **先取证再动手**：保留错误日志尾部、服务状态、版本输出、`PATH` 解析结果。
2. **先备份再修改**：改配置前把原文件备份到本轮检查点目录（`.bak.<时间戳>`）。
3. **不删除未知数据目录**：datadir 可疑时先复制取证，再让用户选择恢复方式。
4. **一次只修一项**：修完立刻复验该项，再进入下一项。
5. **不靠重装解决一切**：能定位到 PATH、版本、权限、服务状态的，就只修那一处。

## 症状一：命令找不到（装完了但用不了）

- 判定：安装目录存在，`command -v` / `Get-Command` 找不到，或找到的是转发壳。
- 动作：把该目录加进**项目级**环境脚本（`scripts/env/env.sh|env.ps1`），不改全局 PATH 顺序。
- 反例：不要为了让它「看得见」而重装或把整个包管理器目录塞进 PATH。

## 症状二：版本不对 / 同一工具多份安装（CONFLICT）

- 判定：`which -a` / `where.exe` 列出多份；生效版本低于项目要求。
- 动作：把项目所需版本的目录排在项目级 PATH 前面，旧版本保留为「备用」。**多版本共存不是冲突。**
- 反例：不要卸载用户已有版本；不要改系统级 PATH 顺序。

## 症状三：装了新版但不生效

- 判定：持久化配置里的顺序对，但当前进程里仍是旧值（宿主注入 PATH）。
- 动作：用**持久化 PATH**（`/etc/paths`、`/etc/paths.d/*`、shell 配置；Windows 注册表 `Machine`+`User`）复核，再在新的子 shell 里复诊。
- 反例：不要以宿主进程里的 `node`/`java` 作为用户环境结论。

## 症状四：JAVA_HOME 悬空

- 判定：`JAVA_HOME` 指向已删除目录；`mvn`/`catalina` 报 `JAVA_HOME not defined correctly`。
- 动作：改项目级环境脚本指向真实 JDK；不动用户全局变量。
- 反例：不要把 `JAVA_HOME` 指向 JRE 或 macOS 的 `/usr/bin/java` 转发壳。

## 症状五：MySQL 起不来（macOS）

- 取证：错误日志尾部（`<datadir>/*.err`）、端口占用、目录属主与权限。
- 常见真因：datadir 属主不是运行用户；端口被占；未初始化；配置文件残留旧 `datadir`。
- 动作：修正属主/端口；让 `mysqld` 以前台方式启动一次看真实错误；**不要**在可疑目录上重新 `--initialize`。
- 反例：`rm -rf` 数据目录、改 root 口令「试试看」。

## 症状六：MySQL 起不来 / 连不上（Windows）

- 取证：`Get-Service MySQL*`、事件查看器应用日志、`<datadir>\*.err`、`netstat -ano | findstr :<端口>`。
- 常见真因：服务未注册；`my.ini` 路径写错；`lower_case_table_names` 与已有 datadir 不一致（初始化后不可改）；端口冲突。
- 动作：修 `my.ini` 与端口；服务注册属 `needs-elevation`，把准确命令交用户。

## 症状七：SQL Server 起不来 / 连不上（Windows）

- 取证：`Get-Service MSSQL*`、错误日志 `C:\Program Files\Microsoft SQL Server\MSSQL*.MSSQLSERVER\MSSQL\Log\ERRORLOG`、TCP 是否启用。
- 常见真因：TCP/IP 协议未启用；端口未放行；`SAPWD` 不满足复杂度；实例名与连接串不一致。
- 动作：启用 TCP 与固定端口（需管理员，交用户）；构造连接串用 `Server=127.0.0.1,1433`。

## 症状八：PATH 被污染

- 判定：同一路径重复多次；存在已删除目录；用户变量被写成一长串。
- 动作：先备份（`env` 快照 / 注册表导出），再按判据逐条清理失效或重复项，最后回读校验。
- 反例：批量重写整条 PATH；清空用户变量。

## 症状九：卸载残留（重装前必做）

- 判定：旧安装目录、旧服务、旧注册表项、旧 PATH 条目同时存在。
- 动作：先把残留项列成清单（路径、服务名、注册表键），交用户逐项确认删除；技能不自行删。
- 反例：删除不确定归属的目录。

## 症状十：版本与系统不匹配（装完就报错/服务秒退）

- 判定：安装包架构不对（x64 装到 arm64 或反之）、系统版本低于官方要求、缺系统库。
- 动作：按 `version-matrix.md` 重新选版本；**不跳过兼容检查**。
- 反例：用「跳过校验参数」硬装；把失败写成「已安装」。

## 症状十一：已经装了，脚本又要装 / 出现两套实例

- 判定：诊断键与实际安装位置不匹配（例如 keg-only 未进 PATH、或包装器自带）。
- 动作：先确认「生效的那份」是否满足项目要求；满足就记为 `ok`，不再安装。项目有包装器时直接用包装器。
- 反例：看到目录不存在就再装一份。

## 症状十二：明明只有一个 JDK，却被判成两份（误报）

- 判定：`/usr/bin/java`（macOS 转发壳）、`javapath`（Oracle 转发壳）、`WindowsApps\python.exe`（0 字节占位）被误计为第二份安装。
- 动作：解析真实路径后判定；转发壳与占位文件不计入安装数量。

## 症状十三：Python 解析到旧版 / `python3` 打不开（Windows）

- 判定：`python3` 指向 0 字节商店占位；或旧版本在 PATH 前面。
- 动作：用真实安装路径；必要时用 `py -3.x` 启动器；项目级环境脚本固定解释器。

## 症状十四：PATH 超过长度上限被截断（Windows）

- 判定：`PATH` 超过 2047 字符时部分项被截断，表现为随机命令找不到。
- 动作：把长路径改成短前缀或改用项目级环境脚本注入，不把大量目录塞进系统 PATH。

## 症状十五：改了配置文件后中文注释变乱码

- 判定：编辑器以 UTF-8 保存，但工具按 ANSI/GBK 读取（典型：`my.ini`、`setenv.bat`）。
- 动作：从备份恢复，按工具要求编码重写（Windows 批处理用 ANSI/纯 ASCII，MySQL 配置保留 UTF-8 但避免中文注释）。

## 症状十六：重启后数据库连不上（服务被设为手动启动）

- 判定：`Get-Service` 的 `StartType` 为 `Manual`；注册表 `Start` 值为 3。
- 动作：把准确的服务自启命令交用户执行（需管理员）；或改为按需启动并写进运行说明。

## 症状十七：PostgreSQL 起不来 / 连不上

- 取证：`postgresql-*.log`、`pg_hba.conf`、`listen_addresses`、端口占用。
- 常见真因：datadir 非空导致 `initdb` 拒绝；端口冲突；`pg_hba.conf` 未允许 `127.0.0.1`；Homebrew 的 keg-only `psql` 不在 PATH。
- 动作：修配置或换端口；大版本迁移走 `pg_dumpall` + 新集群，不原地替换。

## 症状十八：Tomcat 起不来 / 服务注册失败（Windows 高频三连）

- 判定三条：`JRE_HOME` 悬空；目录不是 `-windows-x64.zip`（缺 `service.bat`）；服务账号对目录无写权限（事件日志 7000）。
- 动作：
  1. 写 `bin\setenv.bat`，同时设 `JAVA_HOME` 与 `JRE_HOME`（模板见 `assets/tomcat-setenv.bat`）。
  2. 确认安装包类型；服务注册前临时覆盖进程级 `JRE_HOME`。
  3. 给服务账号目录写权限（需管理员，交用户）。
- 反例：只改 `setenv.bat` 就期待服务注册成功（`service.bat` 不加载 setenv）。

## 症状十九：Go 装好了但 `go get` / `go install` 全失败

- 判定：`go env GOPROXY` 指向不可达源；或 `GOPATH\bin` 不在 PATH（MSI 不自动加）。
- 动作：先探测可用代理再设置；把 `GOPATH\bin` 加进项目级环境脚本。恢复时用 `go env -w GOPROXY=https://proxy.golang.org,direct`。

## 症状二十：诊断脚本输出为空 / 状态行消失

- 判定：输出被分页或编码吞掉；PowerShell 版本不支持某语法；脚本被安全策略拦。
- 动作：加 `-NoProfile -ExecutionPolicy Bypass`（只作用于本次进程，不改系统策略）；`bash -x` 逐步定位；把原始输出落文件再读。

## 何时判定「必须重装」

同时满足才建议重装：安装目录内容缺失/损坏且无法通过补装修复；官方校验值不匹配；服务与二进制均无法恢复。重装仍走「备份 → 卸载到独立目录留存 → 重新安装到新前缀」，且由用户确认。
