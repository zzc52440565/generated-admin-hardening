# GitHub公开分发与维护

发布仓库：https://github.com/zzc52440565/generated-admin-hardening

当前发布版本：v2.3.0。完整提示词与技能放在同一目录，固定版本入口为`skills/generated-admin-hardening/PROMPT.md`，安装路径为`skills/generated-admin-hardening`。

## 用户入口

让用户复制[完整提示词](../skills/generated-admin-hardening/PROMPT.md)。它会检测现有安装，缺失时自动使用可用skill-installer或校验后的同版本源码包，默认项目级安装；安装后读取SKILL.md继续工作。已安装不覆盖，缺少新协议时可临时读取固定版本参考，保留旧安装。

只需下载时使用[Release](https://github.com/zzc52440565/generated-admin-hardening/releases/tag/v2.3.0)：

- generated-admin-hardening-2.3.0.zip：完整技能目录。
- generated-admin-hardening-2.3.0-source.zip：同版本源码、提示词、安装器与验证工具。
- generated-admin-hardening-2.3.0-portable.md：无技能目录支持时的参考文本，不含可执行脚本。
- SHA256SUMS-2.3.0.txt：该版本三个下载物的SHA256；校验完整性不替代确认发布来源。
- PUBLICATION-2.3.0.json：发布后公开下载、摘要与隔离安装的独立验收记录，不参与源码包自身摘要。

## 后续版本

1. 修改单一技能源及PROMPT，更新VERSION、默认提示元数据和固定链接；保留旧下载物，不重写既有标签或Release。
2. 运行工具测试、元数据/相对链接/格式检查。协议不变无需重跑无关产品构建；改协议时用接收端真实解析器与对应网站验收。
3. 运行`python3 -B tools/build_release.py`；验证ZIP CRC、与源逐字节一致、SHA256、隔离解压安装与拒绝覆盖。
4. 核对公开文件清单，只提交通用源码、测试与文档。排除dist、private、.env、凭据、客户项目、截图/trace和本地日志；发布资产用Release上传。旧报告的本机证据路径在公开副本中隐藏，旧版本原始下载物仍在本地保留。
5. 将已验证提交推送到此独立公开仓库，创建对应vX.Y.Z标签和Release，上传四份版本资产。公开下载复验后可附加PUBLICATION-X.Y.Z.json报告。

GitHub公开仓库/Release是当前交付渠道。尚未指定通用再许可条款，不替作者选择许可证；需要开源再分发授权时由作者补充其有权授予的LICENSE。不要将技能ZIP宣传成已审核插件。

## 客户端说明与后续插件分发

Codex的项目级技能目录为.agents/skills，可通过skill-installer安装外部仓库。客户端原生发现与当前任务直接读取技能分开处理；安装后不要求用户重发工作请求。[官方技能文档](https://learn.chatgpt.com/docs/build-skills)

若希望在客户端插件目录发现/安装，可在确定真实发布主体后按最新[插件打包](https://developers.openai.com/plugins/build/plugins)和[审核发布](https://developers.openai.com/plugins/deploy/submission)要求另行打包提交；当前没有进行该动作。

技能版本和Studio接收协议是两条版本线。新装技能不自动升级网站。当前格式与来源指纹见技能references，网站不兼容时必须明确标记未适配。
