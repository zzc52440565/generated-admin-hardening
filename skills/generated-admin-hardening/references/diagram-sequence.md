# 时序图快速填写

依据：`sequenceQuickFill.ts::parseSystemSequenceQuickFillText` / `buildSystemSequenceSpecFromQuickFill` 与 `SequenceTaskEditor.tsx`。系统时序和业务时序使用同一套中文行协议。

```text
标题：提交订单
参与者：客户 actor
参与者：订单页面 boundary
参与者：订单服务 control
参与者：订单 entity
消息：客户 -> 订单页面：提交商品与数量 sync
消息：订单页面 -> 订单服务：提交订单 sync
激活：订单服务
片段开始：alt 参数有效
消息：订单服务 -> 订单：保存订单 sync
消息：订单 -> 订单服务：返回订单编号 return
消息：订单服务 -> 订单页面：返回提交结果 return
片段否则：参数无效
消息：订单服务 -> 订单页面：返回校验错误 return
片段结束
结束激活：订单服务
消息：订单页面 -> 客户：展示处理结果 return
```

- 固定使用中文全角冒号 `：` 和 ASCII 箭头 `->`；模型不能擅自翻译关键字或改成 Mermaid 的 `->>`。
- 参与者先声明，名称唯一，并与每条消息完全一致；分类仅推荐 `actor / boundary / control / entity / participant`。数据库可以作为 `entity`；代码没有独立服务时不凭空增加一层。
- 消息末尾类型支持 `sync / async / return`；`reply` 等价于 `return`，另有 `create / destroy / lost / found`。省略为同步。异步队列只在真实存在时使用 `async`，不能把入队画成任务已经完成。
- 片段类型支持 `alt / opt / loop / par / critical / break`；开始与结束配对，`片段否则：条件` 用于对应分支。`激活：名称` 与 `结束激活：名称` 也要配对。
- 状态约束可写 `状态：订单：待处理`，必须对应真实状态。
- 当前解析器会忽略部分无法识别的行，输出后必须核对消息数和分支，不能把“未报错”当解析完整。避免在名称/消息尾部混入作为语法的词。

每个核心业务场景独立一张图，不把不同图混贴。目标图需要至少一个参与者和事件才会重建；它会替换当前参与者/事件及顺序，不能靠粘贴空文本清空。示例文件 `assets/quick-fill-examples/03-sequence-submit.txt`。
