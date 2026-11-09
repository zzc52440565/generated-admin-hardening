# 页面任务合同 v1（业务计划 schemaVersion=2）

调度单位固定为 **角色 × 目标菜单 × 业务页面**。同一页的主从区域、详情/弹窗、按钮、接口、权限、状态、异常与返工属于页内检查；不能为了填任务数量拆成按钮任务。一个角色的多个验收账号是数据样本，不新增角色任务。无菜单入口用有业务含义的稳定menuId（如account/public），不要求给产品新增菜单。

## 输入与责任

- `docs/page-business-plan.json`：模型根据真实业务事实编写的目标页面合同。不能直接复制生成器的现有菜单、表或权限当预期。独立业务来源、当前实现、存在冲突分开记录。
- `docs/page-task-plan.json`：`page_tasks.py compile`唯一生成。脚本复用既有页面审计器扫描视图、操作键/事件、路由字面量和Spring映射；业务含义不能由扫描器发明。重复ID、漏需求、孤立角色、主从拆散、循环依赖会拒绝编译；未分配源码入口与无法解析的表达式保留gaps。
- `<项目外检查点>/page-task-state.json`：脚本唯一写入的页内状态。与主检查点并存但职责不同：主检查点控制阶段/付费身份；本状态仅控制当前页面、检查、原请求和返工。两者都不能认证模型确实执行过操作。
- `docs/page-task-results.json`：冻结前由report生成。之后可变状态与图稿回执保持在项目外；不得再改项目内文件污染源码绑定。

`scan`是静态候选发现，不等于完整框架解析：动态路由/菜单、程序化事件、非Spring后端需模型结合源文件、真实界面与现有审计器查漏。源码文件指纹覆盖当前支持后缀；未知能力必须记录为缺口，不能以“扫描没有返回”解释为业务不存在。最终审计/运行复审继续强制反向枚举及逐角色真实页面验证。

项目存在源码但扫描未识别任何入口时，脚本产生`unresolved-capability`缺口。必须提交框架、路由与程序化事件的具体核对依据并登记dispositions；不能把零观察当作完整覆盖。即使计划结构校验通过，尚未实际执行的页面业务仍为unverified。

## 合同字段

- `sources[] {id,kind,path,sha256}`：项目内相对文件与真实摘要。kind为business/design/code，至少一个business来源（如保存的用户要求、已确认业务事实）；事实文件变化而摘要没更新即阻断。
- `roles[] {id,purpose,sourceRefs}`：独立业务角色，必须全部有任务。`requirements[] {id,description,sourceRefs}`：按业务目标登记，全部归属至少一个页面，且引用business来源。
- `pages[]`：稳定role/menuId/pageId仅用字母、数字、下划线和连字符。title/menuLabel为显示名；businessGoal/rationale/scaffoldGap解释用户目标、目标形态与脚手架差距。layout必须具体；合理列表可用list并说明依据，不能直接写generic-crud。
- `sections`是同页业务区域；`states`包含真实状态和适用空错态；`sourceFiles`登记页面、菜单/路由、共享组件、服务和权限调用依据。新增页面实现前可先引用将替换的真实源码；实现后更新来源并重新编译。
- `requirementIds`引用业务需求；`auditPageIds`映射现有`page-redesign-audit.json`的页面ID。一个任务可覆盖同页的详情/弹窗审计条目，所有审计条目必须且只能归属一个任务，角色一致。
- `permissions[] {id,actor,operation,outcome,scope,expected,sourceRefs}`：独立预期与实际探针分开；outcome=allow/deny，每页至少一个真实无权/跨用户/字段/直达拒绝样本，不能仅检查按钮隐藏。
- `actions[] {id,description,expected,implementationFiles}`：页面内完整业务操作链与实现文件。每个动作变成内部检查，绝不单独派任务。
- `masterDetail[] {id,parent,child,rationale,writeOwner,strategy,detailSection}`：真正主从用strategy=embedded且detailSection在sections中。脚本追加归属、原子写入、服务端关键值与状态保护检查；不从外键或表名机械判主从。
- `dependsOn`引用其他完整page任务ID，仅表达实施依赖。跨页业务测试往返留页内，不能创建页面依赖环。
- `dispositions[] {observationId,decision,reason,sourceRefs,evidence:{path,sha256}}`：对静态未解析/已退役/片段记录具体依据，decision为resolved/retired/fragment；证据须实际存在并匹配字节。不能用它绕过实际业务页或未验证能力。最终页面审计仍反查。

独立业务冲突未解决时不能编造预期。记录原页面问题与unverified，推进无依赖工作；仅关键业务事实/高风险歧义向用户合并询问。

## 具体示例：订单办理

这是结构示例，不能直接复制为项目验收。将`<...>`替换为实际事实、源码和计算所得摘要。其他真实角色/菜单/页面必须同样纳入，不可只登记示例一页。

```json
{
  "schemaVersion": 2,
  "sources": [{"id":"order-facts","kind":"business","path":"docs/business-facts.md","sha256":"<BUSINESS_FILE_SHA256>"}],
  "roles": [{"id":"customer","purpose":"本人办理订单","sourceRefs":["order-facts"]}],
  "requirements": [{"id":"place-order","description":"客户同页填写收件信息和明细，由服务端整单提交并返回可信合计","sourceRefs":["order-facts"]}],
  "pages": [{
    "role":"customer","menuId":"purchase","pageId":"order-workspace",
    "menuLabel":"下单","title":"订单办理","businessGoal":"客户一次完成主单和商品明细提交",
    "rationale":"明细依附订单生命周期，不应独立创建或跨菜单拼单",
    "scaffoldGap":"现有订单与明细是两个列表，需改为表头、可编辑明细、合计和提交结果同页",
    "layout":"master-detail-form","sections":["收件信息","商品明细","金额与提交"],
    "sourceRefs":["order-facts"],"sourceFiles":["src/views/Order.vue","src/order-service.js"],
    "requirementIds":["place-order"],"auditPageIds":["customer.order","customer.order-confirm"],
    "states":["empty","editing","submitting","submitted","error"],"dependsOn":[],
    "permissions":[
      {"id":"create-own","actor":"customer","operation":"create","outcome":"allow","scope":"self","expected":"owner由服务端会话确定","sourceRefs":["order-facts"]},
      {"id":"other-order","actor":"other-customer","operation":"read","outcome":"deny","scope":"self","expected":"其他客户读取返回404且不泄露收件信息","sourceRefs":["order-facts"]}
    ],
    "actions":[{"id":"submit-order","description":"填写表头、编辑明细并整单提交","expected":"主单和全部明细同时创建，金额由服务端计算","implementationFiles":["src/views/Order.vue","src/order-service.js"]}],
    "masterDetail":[{"id":"order-lines","parent":"order","child":"order_line","rationale":"明细必须归属订单且随主单保存","writeOwner":"OrderService","strategy":"embedded","detailSection":"商品明细"}]
  }],
  "dispositions":[]
}
```

预约应根据时间/资源/冲突组织工作页；审批应根据已有待办、上下文和受控流转组织；基础字典适合列表时优化检索/编辑即可。不照搬订单布局，也不添加业务事实不存在的审批、支付或库存功能。

## 执行与续跑

以下路径占位符需换成当前项目与项目外检查点。参数文件由Agent写入，不让用户搬文件。

```bash
python3 <技能目录>/scripts/page_tasks.py scan --project-root <项目> --output <检查点>/source-inventory.json
python3 <技能目录>/scripts/page_tasks.py compile --project-root <项目>
python3 <技能目录>/scripts/page_tasks.py init --project-root <项目> --state <检查点>/page-task-state.json
python3 <技能目录>/scripts/page_tasks.py next --project-root <项目> --state <检查点>/page-task-state.json
```

已有状态只status/next，不init。HARD.GAPS形成初始目标，HARD.DATABASE/PERMISSIONS的变化后更新合同。HARD.PAGES逐页实施；`implemented --args <JSON>`登记`taskId/note/evidence:{path,sha256}`，不等于验收通过。所有实施后按仓库规范集中构建与验收，仍使用同一页任务，不新建“按钮验收任务”。

`begin --args`使用`taskId/checkId`领取页内检查，返回`fingerprint/operationKey/attempt`。真实执行后，`result --args`提交`taskId/checkId/status/evidence`（evidence是项目内JSON路径）；status仅passed/failed/unverified。失败还需code/progress/recovery，同页同检查同因三次无进展blocked。

证据JSON必须绑定上述ticket，含schemaVersion=1、taskId、checkId、fingerprint、operationKey、attempt、testedAt（带时区且晚于源码和本次begin）、method、status、expected（与检查合同完全一致）、actual和artifacts[{path,sha256}]。method可browser/native-client/http/database/test-run/static/simulation，后两者禁止passed；布局只能browser/native-client。真实日志/响应/截图作为artifacts，静态脚本不能证明执行发生。现有页面审计/运行复审仍验证操作键、状态、截图和角色覆盖。

- `issue`：args含taskId和issue{id,checkId,description,evidence:{path,sha256}}，问题留原页；`repair`含taskId/issueId/note/changeDigest。源码变更先compile→sync，再登记修复并begin→result复测，不能登记repair后直接finish。
- `recover`：在途cursor转pending并保留原operationKey；没有在途请求的blocked恢复须note说明真实进展。恢复不重建项目、不重发收费动作。
- `reconcile`：args含taskId、原operationKey、outcome=applied/not-applied及evidence{path,sha256}；引用JSON必须回读同一operationKey，包含outcome和真实method=http/database/browser/native-client。applied后只回读与核对，**不能再执行业务写入**；脚本不替业务接口实现幂等。
- `sync`：先更新真实来源/代码/数据并compile，再sync。保留页面ID、原请求身份和未解决问题；当前保守失效受影响版本的页面检查。未决页面退役或未解决检查被移除会阻断，必须先处置。新事实不能靠改状态为通过掩盖。
- `finish`：当前页面已实施、全部检查passed、问题复测解决、无pending才允许。之后立即next，不等待用户发“继续”。
- `.lock`残留时报QUEUE_BUSY：核对锁内PID及进程归属；进程在运行就等待，已死亡且明确本任务归属才恢复锁。不得删除共享锁；此版本不提供跨主机分布式租约。

```bash
python3 <技能目录>/scripts/page_tasks.py verify --project-root <项目> --state <检查点>/page-task-state.json --phase implemented
python3 <技能目录>/scripts/page_tasks.py report --project-root <项目> --state <检查点>/page-task-state.json
python3 <技能目录>/scripts/page_tasks.py verify --project-root <项目>
```

report在所有页面通过且与最终审计双向一致后生成。verify输出`evidenceConsistency=passed`仅表示证据校验；业务真实性仍由实际执行日志与人看图判断，不把`businessStatus=unverified-by-validator`改成全流程通过。

播报示例：“当前：客户／下单／订单办理；已完成主从表单和服务端合计，正在核对跨客户访问；证据已保存到本页，下一步复测取消状态，无需你操作。”

旧检查点：已经到DIA/交付的历史HARD成果保留legacy/unverified，不要求回头建项或重扣费。仍在HARD的任务从当前源码和真实事实生成新页面合同，旧报告保留为证据来源；旧passed不直接迁成新检查passed。
