# 故障恢复：六类故障 → 动作 → 回滚 → 检查点

原则：**先取证、再备份、能修不重装、可逆优先、失败即停**。任何"删目录/重建库/改口令"都不在本技能的自动动作里。

## 总表

| # | 故障 | 典型症状 | 首选动作 | 回滚 | 检查点 |
| --- | --- | --- | --- | --- | --- |
| 1 | PATH 看不到（`path-invisible`） | `command not found`，但机器上装了 | 写项目级环境脚本，只把该 bin 目录加进本项目 PATH | 删除/还原项目内脚本（有 `.bak.<时间戳>`） | `checkpoints/<planDigest>/<actionId>.json` 记 `stage=verified` |
| 2 | 版本不符（`version-incompatible`） | 生效版本低于项目要求 | 并行装满足要求的新版本到独立前缀，项目级指向它 | 删除新前缀，旧版本原样不动 | 同上 |
| 3 | 服务没起（`service-stopped`） | 端口不监听、服务 `Stopped` | 先看日志与状态，再前台启动；绑定回环 | 停进程，恢复启动前状态 | 检查点记 `backup` 里的日志尾部证据 |
| 4 | 连不上（`connect-failed`） | 端口在听但鉴权/协议失败 | 查监听地址、socket vs TCP、端口占用进程 | 无写入，无需回滚 | 检查点记 `probe` 原始输出 |
| 5 | 数据/安装目录损坏（`data-corrupt`） | 数据目录不可读、缺 `mysql/`、mvn 执行失败 | 备份 → 取证 → 由用户决定恢复方式 | 只还原备份，不覆盖原目录 | 检查点记 `backup` 与判断依据 |
| 6 | 权限/提权（`needs-elevation`） | 目录属主不是自己、系统服务、安装器 | 输出**准确命令**，由用户亲自提权执行 | 由用户决定 | 仅记录"交人执行"，不写检查点成功态 |

## 1. PATH 看不到

判据：目录里确实有可执行文件，但 `command -v` 找不到；或只在宿主/IDE 注入的进程 PATH 里可见。

```bash
# 诊断会给出 resolvedPath 与 candidates；plan 会生成 write-project-env-script 动作
node scripts/apply.mjs --plan plan.json --action <component>-path-visibility --confirm <planDigest>
# 生成 <项目>/scripts/env/env.sh|env.ps1，只含该组件目录
source <项目>/scripts/env/env.sh && command -v mvn
```

禁止：为了"看得见"而重装、改系统 PATH、改用户 profile、卸载旧版本。

## 2. 版本不符

判据：生效主版本 < 项目要求（例如项目 `release=21`，生效 JDK 8）。

动作：装新版本到独立前缀 → 项目级指向 → 重新诊断 + 真实构建。
禁止：卸载旧版本、覆盖默认版本、跨大版本升级数据库。

## 3. 服务没起

判据：二进制在，端口不监听（`service-stopped`）。

顺序：看错误日志尾部 → 看数据目录是否存在且可读写 → 再启动 → 启动后立刻做一次真实鉴权连接。
禁止：重建 datadir；改管理员口令"试试看"；`--initialize` 指向已有目录。

## 4. 连不上

判据：端口在监听，但客户端/驱动连不上（`connect-failed`）。

检查顺序：监听地址（`127.0.0.1` vs `0.0.0.0`）→ socket 与 TCP → 端口是否被别的进程占用 → 防火墙/代理。
禁止：用改密或重建数据来"解决"连接问题。

宿主限制进程信息时：MySQL 新实例脚本会保留已确认的监听端口，把 `lsof/ps` 的 `EPERM/EACCES` 标为 `inspectionStatus=unverified`，不通过 shell 绕过。已有实例优先复用的保护仍在；只有原任务已明确授权独占新实例、目标端口可确认空闲且目录安全，才按原参数重新生成计划并执行。TCP 探测权限错误或超时会产生 `port-probe-unavailable`，不能当作空闲；恢复宿主回环访问后在同一失败点重试，不停其他实例、不改其口令。

## 5. 数据/安装目录损坏

判据：数据目录不可读/缺系统库（`mysql/`）、mvn/java 可执行文件损坏、解压不完整。

动作：先备份（`cp -a` 到 `.bak.<时间戳>`）→ 取证（错误日志、权限位、属主）→ 由用户决定恢复路径 → 恢复后做真实读写。
禁止：`rm -rf` 数据目录；在可疑目录上重新 `--initialize`；覆盖安装到已有目录。

## 6. 需要提权

判据：目录属主是别人、要注册系统服务、要跑 `.pkg`/`.msi` 安装器。

动作：把**完整命令、目标位置、影响、回滚方式**写给用户，由用户在自己确认后执行；技能侧记录"交人执行"，并继续做不依赖提权的部分。
禁止：代跑 `sudo`；关 UAC/SIP；`Set-ExecutionPolicy` 绕过；静默提权。

## 安装失败与续跑（实测过的路径）

`apply.mjs` 每个动作都有检查点（`checkpoints/<planDigest>/<actionId>.json`），状态机为：

```
init → downloading → downloaded → checksum-ok → extracted → verified → done
                                ↘ failed（记录 lastError / resumeHint / 回滚步骤）
```

三类实测过的失败：

| 失败 | 现象 | 处理 |
| --- | --- | --- |
| 摘要不匹配 | `[error] 摘要不匹配（sha512）…`，`stage=downloaded` | **不重试同一份文件**；换回官方归档或重新下载，再执行同一条命令，从 `stage=downloaded` 续跑 |
| 官方源 404 / 不可达 | `[error] 下载失败：HTTP 404 …`，`stage=downloading` | **不静默换镜像**；用 `--resolve-versions` 重新解析版本，或 `--offline-archive` 指定已核对的本地归档 |
| 复验不通过 | `[error] 复验未通过`，已解压但不可用 | 自动删除本次创建的前缀（回滚），回到 ENV.PLAN 改计划 |

续跑命令与首次完全一致（同一个 `--plan`、`--action`、`--confirm`）；检查点会记录第几次尝试。

## 报告口径

每次失败都要写清：**做了什么 → 失败在哪一步 → 现在的状态（检查点路径）→ 怎么回滚 → 下一步需要谁做什么**。
不要把"回滚成功"写成"问题已解决"；也不要在有 `failed` 项时写"环境就绪"。
