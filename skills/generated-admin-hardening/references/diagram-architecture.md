# 架构图快速填写

依据：architectureDiagramQuickFill.ts 的 buildArchitectureDiagramQuickFillText / buildArchitectureDiagramSpecFromQuickFill；ArchitectureQuickFillEditor 经原图编辑面板和保存链路应用。

当前支持原生快速填写，不再需要人工逐项构建清单。选择当前项目/架构成员，在右侧“快速填写”复制或粘贴完整文本，点击应用，再使用既有保存入口。

```text
标题："订单系统架构图"
方向：LR
节点：1 | "浏览器" | round-rect
节点：2 | "业务服务" | rect
节点：3 | "数据库" | database
连接：1 -> 2 | "HTTP请求/响应" | flow | solid
连接：2 -> 3 | "数据读写" | flow | solid
```

- 节点编号为唯一正整数；连接引用本次声明的编号，节点和连接各一行。名称必须使用JSON双引号及转义，名称内可含竖线、箭头、引号与换行。
- 方向支持 LR/RL/TB/BT；节点形状使用真实GraphNodeShape，例如 rect、round-rect、database、document、hexagon、stored-data。未知形状整次拒绝。
- 连接格式为“连接：源编号 -> 目标编号 | JSON名称 | kind | style”；可以省略标签与后两项，默认flow/solid。类型支持 flow、link、dependency、inheritance、realization、association、aggregation、composition、bind；线型支持 solid、dashed、bold。通常用flow/solid表达通信，按实际语义选择。
- 标题以JSON字符串表达。保留系统复制文本中的布局框节点，原样应用保留其身份、样式和位置；重新生成目标架构时只列需要的全部对象。
- 当前四种预置架构排版按既有展示规则不绘制连线和箭头；连接文本仍保留关系语义并可回填，不能把接收连接数据写成已展示箭头。
- 新增节点/连接会避开已有身份，重复名称仍需使用不同编号；插入或调整连接行不会占用后续保留连接的身份。
- 应用按当前架构成员全文更新，未出现的节点和连接移除；其他模板成员不会被本次粘贴一起替换。空/非法文本不应用，草稿保留，不需要先手动清空。
- 与预置模板不一致时，现有产品可能提示“偏离模板骨架”。核对目标项目实际技术栈与代码后保留真实结构，不为消除警告添加不存在的组件。
- 不把内部JSON、Mermaid或PlantUML粘入此入口。保留同一canonical成员身份，保存走原图稿入口；公开示例页的内存编辑不等于用户项目已经持久化。

图中组件、数据库、队列和通信方式仍须依据目标项目真实实现；过程/触发器不是独立服务器。示例 assets/quick-fill-examples/06-architecture.txt 仅演示语法，不是用户项目事实。
