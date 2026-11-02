# 空回复重试（EMPTY_RESPONSE）方案 v1

状态：已固定，按此实施。改动范围 `src/`、`client/`、`test/`、README；不动 DSH 安装目录。

## 1. 问题

上游偶尔返回“正常 stop、但只有思考块和空文本、没有任何工具调用”的完成。适配器把它当普通
成功回复，agent loop 于是静默结束回合，agent 空闲。DSH 自带的 EMPTY_RESPONSE 判定只数
`message.content.length`，思考块使它恒为假，官方重试因此从不触发。

## 2. 位置

放在本插件已经占用的 `llm/stream` 瀑布里，在 finish chunk 到达时判定并改写 reason。
改写后的 `finish.reason.kind = 'error'` 会走 agent loop 既有的 `agent/request-error` 路径，
由官方 `dsh-llm-retry` 按 EMPTY_RESPONSE 重试（默认 ≤5 次，500ms–10s 指数退避）。

不改 `node_modules`，不新增重试循环，不重复调用 `next()`。

## 3. “可见内容”定义

流里出现过任一项，即视为可见（不改写）：

| chunk | 条件 |
|---|---|
| `text-delta` | text 含非空白字符 |
| `block-end` | block.type === 'text' 且 text 非空白 |
| `tool-call-delta` | 任意（工具调用永远算可见） |
| `block-start` | blockType 不是 text / thinking / reasoning（如 tool-call、image） |
| `block-end` | block.type 不是 text / thinking / reasoning（如 tool-call、image、file） |

只有 `reasoning-delta`、空白 text、空白 text/thinking block、usage 时视为“无可见内容”。

## 4. 改写条件

五个条件同时成立才把 `finish(stop)` 改写为：

```json
{ "kind": "error", "failure": { "code": "EMPTY_RESPONSE", "message": "provider returned a completed response with no visible content" } }
```

1. chunk.type === 'finish'
2. chunk.reason.kind === 'stop'
3. `options.signal` 未 abort
4. 可见性跟踪结果为 false
5. `retryEmptyResponse` 为 true（默认 true），且 provider 过滤通过（空列表＝全部）

改写保留 `replayState` 与 chunk 的其余字段；日志只记 provider，不记内容。

## 5. 明确不改写的形态

- 任何已带 tool-call / image / 其他非文本产物的完成；
- `reason.kind` 为 error / aborted / tool-calls / max-tokens；
- 已被取消的请求（signal.aborted）；
- `retryEmptyResponse` 关闭时的任何完成；
- 既有错误码分类路径（保护码、RETRY_CODES、provider 过滤）保持原样。

## 6. 配置

- Host schema 新增 `retryEmptyResponse`：`Schema.boolean().default(true).volatile()`。
- 读取兼容 volatile 引用（`.get()`）与直接布尔值。
- Client 配置页新增第三个控件（checkbox），保存为 `set`/`unset` 操作，与现有两字段同一原子提交。
- 列表字段语义不变。

## 7. 测试矩阵

Host：
- 只有 reasoning + 空 text + stop → EMPTY_RESPONSE，replayState 保留；
- 空白 text → EMPTY_RESPONSE；
- 非空白 text / tool-call-delta / block-end tool-call / block-end image → 不改写；
- aborted signal → 不改写；
- `retryEmptyResponse: false` → 不改写；
- provider 过滤排除 → 不改写；
- 既有错误码分类与保护码测试保持通过。

Client：
- 三个控件的渲染与可达性；
- 保存包含三个字段的原子操作（boolean 用 set，重置用 unset）；
- 重置与逐字段编辑；
- 既有只读/冲突/重复保存测试保持通过。

## 8. 非目标

- 不修适配器层（那是 DSH 上游的事）；
- 不改变“模型倾向沉默”的行为，只把静默结束变成重试或可见错误；
- 不引入文本缓冲或全流收集。
