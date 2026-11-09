# 可选的本地浏览器审计

`scripts/browser_audit.py` 替代原来三个硬编码脚本。只在已有 Python Playwright 和浏览器的环境运行，不自动安装工具，不登录，不读取验证码日志，不含默认账号。选择器和预期来自目标项目，示例不是通用检查配置。

```bash
python3 /path/to/generated-admin-hardening/scripts/browser_audit.py \
  --config /path/to/project/audit-cases.json \
  --output /path/to/project/audit-results-new.json
```

配置示例：

```json
{
  "base_url": "http://127.0.0.1:8008",
  "storage_state": "private/session.json",
  "pages": [{
    "path": "/orders",
    "ready": "#orders",
    "checks": [
      {"name":"订单表格可见", "kind":"layout", "selector":"#orders table"},
      {"name":"打开详情", "kind":"button", "reviewed_read_only":true,
       "selector":"#view-first", "expect":{"kind":"visible", "selector":"#detail"}},
      {"name":"按已知状态筛选", "kind":"filter", "reviewed_read_only":true,
       "selector":"#status", "action":"select", "value":"PENDING", "submit":"#query",
       "request":{"path":"/api/orders", "method":"GET", "params":{"status":"PENDING"}},
       "result":{"selector":"#orders tbody tr", "count":1}}
    ]
  }]
}
```

- `storage_state` 可省略；有登录时先用项目已有方式建立会话，路径相对配置文件。会话属于敏感运行材料，不提交、不随技能分发。
- 地址仅支持 localhost/回环 IP；页面只允许同源 `/` 开头路径。页面本身仍可能访问外部服务，必须先核对应用配置；本脚本不是网络沙箱。
- 所有按钮和筛选必须显式标记 `reviewed_read_only:true`；这个标记是作者已审查的声明，脚本无法证明按钮无副作用。发送、删除、付款、审核等业务写入使用项目隔离测试，不放进此清单。
- 每个用例重新导航到页面，筛选在独立基线上执行；同一会话不会在用例间自动清库或恢复后台状态。
- 按钮预期支持 `visible`（之前隐藏）、`text`（文字发生变化）、`url`（精确同源路径）和 `download`。不会点击确认框或弹窗底部按钮；JS 确认框统一取消。
- 筛选只支持标准 input 的 `fill` 或原生 select 的 `select`，自定义组件用项目已有测试。验证本次 GET/POST 的预期参数和 HTTP 成功结果，再验证明确预期的 DOM 文本/数量。大范围筛选还需另验后端查询及返回内容。
- 同样行数可能正确；应使用有正反样本的固定数据和唯一结果选择器，不能把 count 相等当成后端完全正确。
- 布局允许按用例设置 `allow_document_scroll:true`，不检查所有表格内部滚动。
- 退出码：0=配置用例通过，1=用例失败，2=配置/报告文件错误，3=环境未就绪或未验证。报告包含失败类型，定位需在本地安全地复现；不输出完整请求体或 Playwright 敏感日志。
- 页面脚本异常会导致当前用例失败。该工具不全面覆盖控制台警告、所有 HTTP 请求、可访问性、权限、并发、事务或业务闭环；不能替代正式验收。
