# WorkBuddy 完整技能 3.2.0

一个入口交付整套八类图、可运行系统或两者全套。系统改造以真实业务分析确定目标菜单、页面与布局，再由脚本固定为「角色 × 目标菜单 × 业务页面」任务；按钮、接口、权限、主从、异常、修复和复测均属于该页。

本版本对应主合同 v15，内置加固方法 3.1.0。当前仓库的独立加固技能 2.4.0 保留原安装方式，不能用其安装器安装本包。

## 下载与安装

固定版本：[workbuddy-v3.2.0](https://github.com/zzc52440565/generated-admin-hardening/releases/tag/workbuddy-v3.2.0)。下载 `jiema-workbuddy-3.2.0.zip`、同名 `.manifest.json` 与 `SHA256SUMS-workbuddy-3.2.0.txt`，核对 ZIP 的 SHA256，再按当前 WorkBuddy 客户端支持的本地技能安装方式导入。ZIP 根目录是 SKILL.md、references 和 scripts；手动安装时目标为技能目录下的 `jiema-workbuddy/`，已有安装先备份并保留用户元数据。

这次发布是 GitHub 分发包；不代表已经上架或通过 WorkBuddy 技能市场审核。模型、终端、浏览器、账号与权限来自宿主，技能文件不能替代运行时。

## 关键行为

- 业务合同与当前源码分开：不把生成器的 CRUD 菜单或现有错误权限当作业务预期。
- 页面合同要求真实来源、需求覆盖、目标布局、允许/拒绝权限样本；主从明细与主单同页处理。
- 同一任务和检查有稳定身份；源码、业务事实、数据或对象版本变化使旧验收失效。
- 在途请求先回读再决定恢复；失败、返工和复测留在原页，三次同因无进展明确 blocked。
- 静态扫描无法识别的入口保留缺口；不以空清单声明完整覆盖。布局通过需要真实浏览器或原生客户端证据。
- HARD.PAGES 和 HARD.FREEZE 执行正式脚本门禁；原 H8 继续映射 DIA.SAVE，历史成果只保留 legacy/unverified。

唯一字段及执行说明：[页面任务合同](../skills/jiema-workbuddy/references/generated-admin-hardening/references/page-task-contract.md)。

## 验证边界

发布前在 macOS 实际执行：主仓库 78 项 Python 和 77 项 Node 回归；包构建、文档/机器合同一致性、链接、格式与安全检查通过。发布包 87 文件逐字节核对；24 项静态待判断项已人工复核，主要为禁止性文案、隔离开发口令约定和验收前提。

公开包可独立复跑页面任务 17 项行为回归：

```bash
python3 -B -m unittest discover -s tests -p 'test_workbuddy_page_tasks.py'
```

合成证据测试只证明验证器行为；扫描校园源码快照不等于业务通过。纯 JavaScript 订单样本未识别入口时明确阻断，不能以零观察宣称完整覆盖。Windows 真机、完整系统业务验收及默认全路径仍需各自真实证据。

公开内容只含通用技能、合同示例及测试；不包含用户工程、真实数据库、凭据、安装备份或本机原始日志。
