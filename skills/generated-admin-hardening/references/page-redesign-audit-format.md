# 页面审查记录格式 v1

项目交付 `docs/page-redesign-audit.json`，记录业务判断与真实验收。以下是语法示例，**不代表已测项目**；所有源码路径、角色、动作、哈希和证据必须替换成项目事实，不能直接复制“通过”状态。

## 字段约定

- `schemaVersion`：整数1。`targetRevision`：本轮最终代码/构建的可辨识版本，不必额外创建Git提交。
- `sourceDigests`：相对项目路径→验收时文件SHA256小写十六进制。纳入路由/动态菜单来源、每页源码、改动文件、业务动作实现及受影响的共享组件/样式/权限/配置依赖；所有登记的摘要均会比对当前字节。不是仅记录一个组件来代表整条链路。
- `inventory.sourceFiles`：枚举页面/菜单使用的真实源码；`menus`成员含唯一`id`、`role`、`pageIds`；`pages`成员含唯一`id`、`role`、`entry`、`originalForm`、`menuIds`、`sourceFiles`。菜单映射双向一致，父目录菜单指向后代页面；无菜单页面`menuIds: []`，无菜单应用`menus: []`。同一入口不同角色用不同页面ID。
- `originalForm`：`generic-crud`通用CRUD、`purpose-built`已有业务页、`mixed`混合形态。
- `reviews`：每页恰好一项，以`pageId`关联。`businessGoal`是真实用户目标，`needsWorkflow`说明通用CRUD是否不足以支撑它；`decision`三选一，判据见 [业务改造协议](page-business-redesign.md)。`targetForm`用可理解的页面形态名，保留列表时固定`list`；`rationale`写事实与选择理由。
- `changedFiles`：实际改进文件，可引用复用的共享文件；`changeAreas`取`visual/information/interaction/workflow/integration`。业务重做至少有workflow和interaction，已有业务页完善至少有information、interaction或workflow；不能仅标改色。
- `businessActions`：动作`name`唯一；`implementationFiles`追踪实际实现，前后端/桌面方法均可；有服务端的动作须包含真实服务与权限依据，不能仅引用按钮。`expectedResult`写实际业务结果。列表查询、导航、下载也可作为合法操作，不强求写数据库。
- `requiredStates`：该页适用的正常、空、错误、加载、无权、锁定等状态名。状态不适用的依据写在rationale/证据说明，不能省掉真实存在但未测状态来凑通过。
- `rounds`：按递增正整数轮次记历史，`revision`标识当时代码，`status`为passed/rework/blocked，`issues`只登记本轮新发现的问题，含唯一id与具体description，尚未关闭的旧问题自动延续、不重复添加；`resolvedIssueIds`仅关闭此前未解决的问题。passed轮次不能带未解决问题。问题可在修复后重新出现，需重新登记。
- 最终页轮次必须对应targetRevision，无未解决问题；`businessFitAssessment`写最终业务形态的复审结论及依据，与实施前rationale分开；`checks`的businessFit/actions/states/layout/permissions均明确true，`actionsTested/statesTested`覆盖所有声明项。证据`evidence`至少有screenshot、interaction、layout三种，每项含kind/path/summary，文件存在且非空；交互证据写预期/实际/结果，尺寸证据写真实视口与关键区域。不同角色可复用截图，但要各有授权与能力的实测依据。
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
    "needsWorkflow": true,
    "decision": "redesign-business",
    "targetForm": "document-workspace",
    "rationale": "现有服务定义了主从一次提交，但页面要求分别跨菜单编辑",
    "changedFiles": ["src/order.ts", "src/order-service.ts"],
    "changeAreas": ["information", "interaction", "workflow", "integration"],
    "businessActions": [{"name": "提交单据", "implementationFiles": ["src/order.ts", "src/order-service.ts"], "expectedResult": "服务校验归属、一次事务保存并返回状态及重算合计"}],
    "requiredStates": ["ready", "empty", "failure"],
    "rounds": [
      {"round": 1, "revision": "r1", "status": "rework", "issues": [{"id": "missing-context", "description": "仍需跨菜单处理明细"}], "resolvedIssueIds": []},
      {"round": 2, "revision": "final-r2", "status": "passed", "issues": [], "resolvedIssueIds": ["missing-context"],
       "businessFitAssessment": "表头/明细/合计同页，提交后显示真实服务返回的单据状态；正常及失败恢复已复审",
       "checks": {"businessFit": true, "actions": true, "states": true, "layout": true, "permissions": true},
       "actionsTested": ["提交单据"], "statesTested": ["ready", "empty", "failure"],
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
