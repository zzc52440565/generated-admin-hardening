# 统一演示口令与页面可视复审

这是下载后完整加固的必做合同，保留上游 v2.4.0 要求。先读本技能正文、逐页业务改造和前端运行协议，再执行；不要自行寻找另一个同名技能或只运行检查器。

## 本地账号一致性

1. 新建的本地开发数据库与本轮交付的全部演示／测试账号统一 `conventions.localDemo.password`。MySQL 的实际认证、应用配置、种子 SQL、测试脚本与交付账号表须一致。Admin 登录名为 `admin`；各业务角色给出可用账号。不得只改说明。
2. 使用项目真实密码编码器和足够长度的字段；不得存明文、绕过编码器、放宽认证或添加后门。用户后续正常修改自己的密码仍允许。
3. 归属明确的本轮隔离合成账号口令不一致时，按已授权测试范围修正，并同步种子与测试。不要重置真实／生产账号或接管未知的既有数据库；此时另建隔离开发实例／账号。源码只读模式不执行数据改写。
4. 核验数据库使用 `conventions.localDemo.password` 真正连接成功，再让每个登录角色通过真实页面用 `conventions.localDemo.password` 登录，检查身份、入口与权限。接口测试与浏览器登录分别记录。改密专项结束后把本轮演示账号恢复到统一约定。
SQLite 没有数据库登录密码，不伪造数据库账号：使用 `engine: sqlite`、项目内 `databaseFile`、`passwordConvention: not-applicable`，实际连接证据绑定同一文件；业务演示账号仍遵循统一约定。

5. 用户交付说明列出数据库主机、端口、库、用户及约定口令，各角色的登录名和约定口令。`conventions.localDemo.password` 是本轮新建本地实例及隔离演示账号的公开约定；真实密码、token、Cookie、验证码仍不得写入证据或上传。

## 页面实际改造与看图

1. 代码和真实界面双向枚举全部角色入口，包括登录、注册（即使是弹窗）、公开首页、工作台、列表、详情、增改表单与弹窗。游客首页不能要求先登录。
2. 改造前截图并查看，给每页具体问题与目标。登录页首次执行即改造；统一设计语言，但不以全局换色冒充每页业务优化。仅 PC 的任务不新增移动端工作。
3. 实现后构建运行，按角色打开每页、执行核心动作和适用失败恢复。截图要有可见页面；不能用 HTML、JSON 或空白图片冒充。原生图片的导出与视口降级只遵循[截图保存协议](../../browser-handoff.md#原生截图保存)，由 Agent 按本次工具回执保存。
4. **实际打开最终截图查看**，分别判断信息层级、排版留白、表单与错误反馈、导航、长表操作和业务适配；写具体观察。发现裁切、拥挤、装饰喧宾夺主、通用 CRUD 未改等问题继续返工。截图生成成功、尺寸没溢出和按钮可点不能单独证明完成。
5. 同一页面跨角色分别复审，可复用同一共享画面，但角色能力仍分别实测。最终代码变化后受影响证据失效；不能只改摘要继承旧结论。

## HARD.FREEZE 记录格式

`docs/runtime-review.json` 与 `docs/page-redesign-audit.json` 一起提交检查点。字段如下，实际项目不能复制样例的通过值：

以下 JSON 中 `<resolved-local-demo-password>` 须替换为读取 conventions.json 得到的实际公开约定值；不得把字段名或占位符当作口令。

```json
{
  "schemaVersion": 1,
  "scopeDescription": "本轮新建本地实例及归属明确的隔离演示账号",
  "targetRevision": "与页面审计完全一致",
  "sourceDigests": {"源码相对路径": "与页面审计一致的SHA256"},
  "database": {
    "scope": "local-demo", "host": "127.0.0.1", "port": 3308,
    "passwordConvention": "<resolved-local-demo-password>", "verified": true,
    "evidence": "docs/evidence/database-login.json"
  },
  "loginRoles": ["admin", "student"],
  "publicRoles": ["guest"],
  "accounts": [
    {"role": "admin", "username": "admin", "passwordConvention": "<resolved-local-demo-password>", "verified": true, "evidence": "docs/evidence/admin-login.json"},
    {"role": "student", "username": "stu001", "passwordConvention": "<resolved-local-demo-password>", "verified": true, "evidence": "docs/evidence/student-login.json"}
  ],
  "pages": [{
    "pageId": "与页面审计ID一致",
    "beforeScreenshot": "docs/evidence/login-before.png",
    "afterScreenshot": "docs/evidence/login-after.png",
    "reviewedAt": "ISO日期时间",
    "status": "passed",
    "changes": ["实际改动及业务用途"],
    "observations": ["查看最终图片后对层级、布局和业务操作的具体判断"]
  }]
}
```

本轮新建本地实例及隔离演示账号的鉴权证据 JSON 含 `status: passed`、`testedAt`、`targetRevision`、具体 `expected` 和 `actual`；账号证据另含 `role`、`username`、`method: browser`、`passwordConvention`（读取约定的实际值）。数据库证据含 `host`、`port`、`passwordConvention`（读取约定的实际值）、`method: database-connection`。不要保存会话凭据。

所有路径相对项目根，必须在根内。检查点实际核对角色／页面覆盖、文件类型、版本、摘要与时间；它不能证明图片美观或模型确实看过图，也无法阻止绕过检查点的调用。执行者必须实际看图和实测，如实记录未完成项。
