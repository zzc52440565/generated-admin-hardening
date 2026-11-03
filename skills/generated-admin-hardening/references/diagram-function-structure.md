# 功能结构图快速填写

依据：`functionStructureQuickFill.ts` 的 `parseFunctionStructureQuickFillText` / `buildFunctionStructureSpecFromQuickFill`，UI 为 `FunctionStructureTreeEditor.tsx`。

使用每级两个 ASCII 空格，最多五级，依次为系统、角色、模块、操作、具体功能。第一行唯一根节点且顶格，后续不能跳级。建议始终写明前缀，避免默认层级推断改变语义。

```text
系统：订单管理演示系统
  角色：客户
    模块：我的订单
      操作：提交订单
        具体功能：填写商品与数量
      操作：查看订单
  角色：管理员
    模块：订单管理
      操作：查询订单
```

按角色组织真实可执行的业务能力。主从单据合并后，行项目维护通常放在主单操作内部；不能因此删掉独立库存或报表能力。主数据是否独立以业务和代码为准。

名称避免裸换行。确有换行时在冒号后写 JSON 字符串，例如 `模块："订单\n管理"`。不要混用空格宽度或在正文前加 `#`，否则会生成多余节点。

在对应图的“快速填写”粘贴并按实际界面应用/保存；当前树节点和连接按文本重建，会尽力保留可匹配身份，但不能保证改名、移动后的所有绑定都保留。核对角色来源绑定与显示深度。完整示例见 `assets/quick-fill-examples/01-function-structure.txt`。
