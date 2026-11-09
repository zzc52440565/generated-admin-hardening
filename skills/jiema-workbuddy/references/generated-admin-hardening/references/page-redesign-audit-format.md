# 页面审查记录格式 v1

项目交付 `docs/page-redesign-audit.json`，记录业务判断与真实验收。以下是语法示例，**不代表已测项目**；所有源码路径、角色、动作、哈希和证据必须替换成项目事实，不能直接复制“通过”状态。

审计条目与调度任务分开：一个业务页面的详情/弹窗/步骤可以有多个审计pageId，统一归属 [页面任务合同](page-task-contract.md) 的一个taskId。`page_tasks.py verify`检查所有auditPageIds恰好归属一次且角色一致；本审计器继续验证实际动作、页面形态与证据。

## 字段约定

- `schemaVersion`：整数1。`targetRevision`：本轮最终代码/构建的可辨识版本，不必额外创建Git提交。
- `sourceDigests`：相对项目路径→验收时文件SHA256小写十六进制。纳入路由/动态菜单来源、每页源码、改动文件、业务动作实现及受影响的共享组件/样式/权限/配置依赖；所有登记的摘要均会比对当前字节。不是仅记录一个组件来代表整条链路。
- `inventory.sourceFiles`：枚举页面/菜单使用的真实源码；`menus`成员含唯一`id`、`role`、`pageIds`；`pages`成员含唯一`id`、`role`、`entry`、`originalForm`、`menuIds`、`sourceFiles`。菜单映射双向一致，父目录菜单指向后代页面；无菜单页面`menuIds: []`，无菜单应用`menus: []`。同一入口不同角色用不同页面ID。Spring/JSP 项目会反向扫描控制器返回的视图和非片段 JSP，要求逐页登记、将对应控制器放入页面源码与总清单；确实未使用的非返回视图可在 `inventory.excludedViewFiles` 中填写 `{ "path": "...", "reason": "..." }`，控制器实际返回的视图不得排除。
- `originalForm`：`generic-crud`通用CRUD、`purpose-built`已有业务页、`mixed`混合形态。
- `reviews`：每页恰好一项，以`pageId`关联。`businessGoal`是真实用户目标，`needsWorkflow`说明通用CRUD是否不足以支撑它；`decision`三选一，判据见 [业务改造协议](page-business-redesign.md)。`targetForm`用可理解的页面形态名，保留列表时固定`list`；`rationale`写事实与选择理由。
- `reviews[].businessQuestion`（必填）：回答「谁在什么场景完成什么目标，完成后业务状态/数据/下一步怎么变」。人工业务复审不能接受单纯复述脚手架结构；脚本仅检查字段存在且非空，不理解业务语义。
- `reviews[].scaffoldGap`（必填）：写清目标形态与脚手架当前形态的**具体差异**，例如“脚手架是列表＋弹窗，需要改为表头＋可编辑明细＋后端重算合计的一次提交”。只写“按业务优化”“保留列表”不合格。
- `reviews[].needsWorkflowBasis` / `workflowChain`（`needsWorkflow=false` 时必填）：前者写「为什么列表＋弹窗足以完成该业务」，后者给出该业务在本页的完整操作链（至少两步：谁 → 做什么 → 状态怎么变）。写不出操作链说明这页不是列表页。
- `entityRoles`（发现 DDL 实体时必填；无 DDL 时不作实体覆盖认证）：从 CREATE TABLE（支持反引号、双引号、方括号及 schema 限定名）枚举；REFERENCES/ALTER TABLE 仅提供关系事实；相关 DDL 文件必须纳入摘要。数据库结构里的**每个实体**一条 `{ "entity": "trade_order", "role": "master|detail|independent", "parent": "...", "basis": "..." }`。角色必须按真实操作流程判断：子记录能否独立存在、能否独立创建/检索、主单失效后是否仍有独立生命周期；**不能按表名、字段名或外键直接认定**。`basis` 写业务依据（谁在用、走什么流程），只写角色名不合格。判为 `detail` 的必须写 `parent`，并且该实体必须出现在主单的 `masterDetailGroups` 里；结构里没有对应外键边时，用 `relationEvidence` 说明关系落在哪。判为 `independent` 的必须给 `standaloneEvidence: {"role","scenario","entry","entrySource"}`，其中 `entry` 是入口名称/菜单字面量，`entrySource` 是包含它的源码文件——脚本会核对该字面量确实在该文件里出现；无法举证时保持未验证，由业务审查确认角色，不能反推它必然是明细。入口注释不算证据，文件必须在项目内并进入 sourceDigests。
- 判为 `detail` 的实体还有一道后端门禁：**不能留着自己的写端点**。脚本扫描 `*Controller.java` 里的写方法（`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`，含 `@RequestMapping(method=...)`、多路径/多方法及类级前缀；按控制器名或路由路径段匹配实体；动态路径无法识别时阻断），发现端点即要求二选一：删掉，或用 `keptWriteEndpoints: [{ "endpoint": "POST /tradeOrderLine/save/{action}", "scopeEvidence": { "file": "...", "token": "lineOf(orderId, lineId)" } }]` 登记，文件必须在项目内且纳入源码摘要；`token` 必须出现在对应端点方法的非注释、非字符串、非字面量 false 分支代码中。校验委托到服务文件时还须给 `callSite`，指向当前端点调用服务的代码。静态文本不能证明任意分支可达或服务调用确实执行校验，仍须逐端点运行验证。POST 即使名为 list/detail/page 也纳入潜在写入口，不能用名字证明只读；保留时按真实范围给出调用依据。
- 判为 `detail` 的实体还必须有一次**隔离实测** `isolationTest: { "endpoint", "scenario", "request", "expectedStatus": 403, "actualStatus": 403, "evidence", "testedAt" }`：用另一个用户的主单去写这条明细，期望被拒绝。`expectedStatus` 必须是 4xx，`actualStatus` 必须与之相等——返回 2xx 说明后端仍可脱离主单写入，判双轨未拆；`evidence` 必须是项目内 JSON，含 `entity/endpoint/request/testedAt` 并与审计声明一致、不同的 `actorId/parentOwnerId`、具体 `parentId`、`response: {status, body}`、最终 `revision` 和相关主单/明细控制器与 scope 文件的 `sourceDigests`。响应码须与 actualStatus 相等；testedAt 须带时区、非未来，记录和证据均不能早于后端源码。字段与文件完整仍不能证明身份、主单归属或请求实际发生，必须独立复核执行来源。没做、没证据、或结果是 2xx，一律失败。
- 判为 `independent` 的实体若与其它实体存在外键关系，`basis` 里必须点名相关实体，并说明为什么它不该合并（如独立生命周期、独立审计与高频检索）；这项属于人工业务复核，脚本不检查自然语言是否点名或论证充分，也不设 basis 字数门槛。
- `masterDetailGroups`：每组 `{parent, children, pageId, workspaceFiles, childViewFiles}`；`childViewFiles` 是明细实体名到视图路径数组的显式映射（支持驼峰或任意合理命名），`workspaceFiles` 是主单工作页入口源码。全部文件须在同页 `sourceFiles`；明细视图还须进入工作页的静态引用闭包。组必须对应 master/detail 的一致角色及 parent。页面须 `redesign-business` 且非 list/generic-crud。此检查证明静态引用与登记，是否真实渲染、同一事务和可操作仍须人工/运行验收。
- `inventory.excludedViewFiles`：视图文件没有登记到任何页面时，用它说明不适用理由；会扫描嵌套项目中的 Vue/JSX/TSX、Spring 模板、JSP、小程序 pages 与可识别的 Swing/WinForms 窗体；下划线命名不自动豁免。排除的文件也必须进入摘要，不能同时登记和排除。视图文件既未登记也未排除同样失败（同一业务页可以登记多个视图，合并登记不影响这条）。
- `changedFiles`：实际改进文件，可引用复用的共享文件；`changeAreas`取`visual/information/interaction/workflow/integration`。业务重做至少有workflow和interaction，已有业务页完善至少有information、interaction或workflow；不能仅标改色。
- `businessActions`：动作`name`唯一；`implementationFiles`追踪实际实现，前后端/桌面方法均可；有服务端的动作须包含真实服务与权限依据，不能仅引用按钮。`expectedResult`写实际业务结果。列表查询、导航、下载也可作为合法操作，不强求写数据库。
- `businessActions[].actionKeys`：该动作覆盖的**源码操作键**，必须与该页源码里显式声明的键逐字一致（如 `operationKey`、操作对象里的 `key`、`@PreAuthorize(hasAuthority('x'))`、`@RequiresPermissions('x')`、`v-permission="'x'"`、`perms:[...]`）。脚本会从页面源码（含 `changedFiles`）反向枚举这些键，**没有任何说明时，任何一个未被 `actionKeys` 覆盖的键都会导致检查失败**。这不是新增流程，只是把“页面上真实存在的操作”写成可核对的清单；登记源码中不存在的键、或一个动作超过 conventions.actions.maxKeysPerAction同样失败（多余的要拆成独立动作，逐个实测）。全站 router/routes 文件属于入口清单和源码指纹，其路由目标分别登记页面，不向当前页面递归分配其它页面动作。本页组件/方法的本地静态 import/require/export/include 引用闭包不设深度上限，支持目录 index 与最近 src 下的 @/ 别名；闭包源码必须进入 sourceDigests 和页面指纹。操作键支持单/双引号与无插值模板串；拼接、变量或动态指令无法核对时直接失败，应改成字面量。注释与嵌套列配置不计为操作。Vue/JSP/Thymeleaf 的显式权限、Web/小程序命名事件、WinForms 命名事件使用 event:处理方法名；Swing 监听器使用 event:控件变量名。事件键也需独立登记和实测；这只是已支持语法的静态枚举，不保证任意语言写法都被发现。
- `displacedActions`：`[{ "key": "...", "kind": "otherPage|superseded|noBinding", "targetPageId": "...", "evidence": "..." }]`。用于操作不在本页办理：`otherPage` 要指向承接它的页面（该页必须把同一个键登记为独立动作并实测），`superseded` 必填 `replacementKeys`，指向本页已登记且最终实测的新键；`noBinding` 必填 `bindingEvidence: {"file","token"}`，文件须属于本页引用闭包，片段须出现在非注释源码中。静态片段只支持人工核对未绑定的判断，不证明不可达。不给结构化去向、只写一句“由别处办理”，判失败。
- 动作覆盖与页面切分是两件事：**页面怎么拆（列表/新增/编辑/详情是否合并登记）由模型按业务判断**，脚本不强制；但只要这些页面的源码进了本页 `sourceFiles` 或 `changedFiles`，其操作键就都要被覆盖或排除。
- `requiredStates`：该页适用的正常、空、错误、加载、无权、锁定等状态名。状态不适用的依据写在rationale/证据说明，不能省掉真实存在但未测状态来凑通过。
- `rounds`：按递增正整数轮次记历史，`revision`标识当时代码，`status`为passed/rework/blocked，`issues`只登记本轮新发现的问题，含唯一id与具体description，尚未关闭的旧问题自动延续、不重复添加；`resolvedIssueIds`仅关闭此前未解决的问题。passed轮次不能带未解决问题。问题可在修复后重新出现，需重新登记。
- 最终页轮次必须对应targetRevision，无未解决问题；`sourceFingerprint` 是把该页源码、改动文件、动作实现文件及本地引用闭包的 `路径:SHA256` 按路径排序后用换行拼接所得 SHA256，`verifiedAt` 是带时区的 ISO8601 最终实测时间。脚本会检查实测与证据文件时间不早于相关源码的最后修改。`businessFitAssessment`写最终业务形态的复审结论及依据，与实施前rationale分开；`checks`的businessFit/actions/states/layout/permissions均明确true，`actionsTested/statesTested`覆盖所有声明项；最终轮次的 `testedActionKeys` 必须独自覆盖本页所有动作键，旧轮次不能补齐。证据`evidence`至少有screenshot、interaction、layout三种，每项含kind/path/summary，文件存在且非空；交互证据必须为 JSON 对象，含与最终轮次一致的 `revision`、`sourceFingerprint` 及 `records` 数组；每条含 `actionName`、有键时的 `actionKey`、`expected`、`actual`、`result: "passed"`。所有动作和键都要有对应结果，键必须归属该动作；明确“需人工核对”“未验证”或失败不能标页面通过。不同角色可复用截图，但要各有授权与能力的实测依据。
- `sweeps`：全量复查按递增轮次，最后一项passed，对应最终版本，pageIds覆盖全部清单页面；`inventoryEvidence`是最终从真实菜单/路由/角色重新枚举的证据，轮次不早于任一页面最终轮次。

代码变更后重新复验受影响页，再更新记录和指纹。无影响证据可沿用，但最终轮次需明确记录复用依据和最终版本适用性，不能仅批量替换版本。源码指纹是失效提醒，不是自动认证证据时间或真实性。

## 完整单页语法示例

下例的零值摘要和证据文件用于说明结构，直接运行会被拒绝；不构成业务实现示例。

```json
{
  "schemaVersion": 1,
  "targetRevision": "final-r2",
  "sourceDigests": {
    "src/routes.ts": "0000000000000000000000000000000000000000000000000000000000000000",
    "src/order.ts": "0000000000000000000000000000000000000000000000000000000000000000",
    "src/order-service.ts": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "inventory": {
    "sourceFiles": ["src/routes.ts"],
    "menus": [{"id": "operator.orders", "role": "operator", "pageIds": ["operator.orders.workspace"]}],
    "pages": [{"id": "operator.orders.workspace", "role": "operator", "entry": "/orders", "originalForm": "generic-crud", "menuIds": ["operator.orders"], "sourceFiles": ["src/order.ts"]}]
  },
  "reviews": [{
    "pageId": "operator.orders.workspace",
    "businessGoal": "操作员在一张单据中维护表头和明细并提交",
    "businessQuestion": "操作员录入订单后提交，草稿转为待处理",
    "scaffoldGap": "将分离的表头与明细录入整合为一次提交",
    "needsWorkflow": true,
    "decision": "redesign-business",
    "targetForm": "document-workspace",
    "rationale": "现有服务定义了主从一次提交，但页面要求分别跨菜单编辑",
    "changedFiles": ["src/order.ts", "src/order-service.ts"],
    "changeAreas": ["information", "interaction", "workflow", "integration"],
    "businessActions": [{"name": "提交单据", "actionKeys": ["submit_order"], "implementationFiles": ["src/order.ts", "src/order-service.ts"], "expectedResult": "服务校验归属、一次事务保存并返回状态及重算合计"}],
    "requiredStates": ["ready", "empty", "failure"],
    "rounds": [
      {"round": 1, "revision": "r1", "status": "rework", "issues": [{"id": "missing-context", "description": "仍需跨菜单处理明细"}], "resolvedIssueIds": []},
      {"round": 2, "revision": "final-r2", "status": "passed", "issues": [], "resolvedIssueIds": ["missing-context"],
       "sourceFingerprint": "0000000000000000000000000000000000000000000000000000000000000000", "verifiedAt": "2026-11-05T16:00:00+08:00",
       "businessFitAssessment": "表头/明细/合计同页，提交后显示真实服务返回的单据状态；正常及失败恢复已复审",
       "checks": {"businessFit": true, "actions": true, "states": true, "layout": true, "permissions": true},
       "actionsTested": ["提交单据"], "testedActionKeys": ["submit_order"], "statesTested": ["ready", "empty", "failure"],
       "evidence": [
         {"kind": "screenshot", "path": "docs/audit/order.png", "summary": "桌面和窄屏真实画面及最终形态"},
         {"kind": "interaction", "path": "docs/audit/order-action.json", "summary": "提交结果/状态/权限/失败恢复的预期与实际"},
         {"kind": "layout", "path": "docs/audit/order-layout.json", "summary": "视口、表单、明细、弹窗实际尺寸与可操作性"}
       ]}
    ]
  }],
  "sweeps": [{"round": 2, "revision": "final-r2", "status": "passed", "pageIds": ["operator.orders.workspace"], "inventoryEvidence": "docs/audit/final-inventory.md"}]
}
```

保留列表的页面使用`needsWorkflow: false`、`decision: "optimize-list"`、`targetForm: "list"`，其他覆盖、实测、指纹和复验要求相同。记录未完成页时保留真实失败/阻塞状态，检查器返回失败是正常且应保留的证据，不要删除页面来换取通过。

`excludedActions` 已废弃，出现即失败；使用结构化 `displacedActions`。JSON 中记录预期、实际和通过状态仍可被人工伪造，必须保留真实运行来源供复核；字段完整不等于实际执行。

静态能力边界：自定义构建别名、运行时生成声明、未支持的匿名事件、既不以实体命名也不含实体路由段的控制器，以及通用分支可达性，不能据本脚本的退出 0 判定已覆盖。`noBinding`、主从是否实际同屏、自然语言业务判断须独立复核；无法核实应保持未验证。源码注释、已知 false 分支等可机械识别的伪证会被拒绝，但不能据此宣称任意死代码都会被识别。
