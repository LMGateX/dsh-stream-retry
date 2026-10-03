# DSH Stream Retry — 可配置流中断重试兼容插件

为 **DSH 0.2.0-rc.2** 的官方重试执行器补充上游错误分类。插件本身不启动第二套重试循环，不发“继续”消息，也不重建 agent。复用官方 dsh-llm-retry，在同一 turn / step 重试失败的模型请求。

## 默认预设与可编辑设置

| 设置 | 默认值 | 含义 |
|---|---|---|
| errorCodes | upstream_stream_read_error、stream_timeout、stream error | 完整错误标识列表，可增删。自定义数组**替换**默认列表；空数组关闭本插件的映射。 |
| providers | 空数组 | 对所有同进程 provider 生效；非空时只匹配列出的精确路由。不是 API URL，不支持通配符。 |

配置界面逐行维护列表，内部空格保留：**stream error 是一个完整标识**，不会拆成两个词。区分大小写，不自动把 stream_error、stream  error、stream error extra 当成 stream error。

每个列表最多 100 项，每项最多 200 字符。错误标识不得包含首尾空白、冒号、引号、反引号或控制字符；provider 不得含空白。只填写 code，不填写冒号后的错误描述，不填写凭证。

## 如何匹配

匹配分成两层：

1. failure.code 是预设或用户指定的上游标识：直接匹配，message 可以任意变化。
2. failure.code 被适配器泛化为 PI_AI_ERROR、UNKNOWN 或 STREAM_CLOSED：只识别以下**整条错误的外层格式**，不扫描描述正文：

    Error Code upstream_stream_read_error: 任意描述
    upstream_stream_read_error: 另一种描述
    stream error: 任意描述
    stream error

最后一项是“整条消息只包含标识”的兼容规则，不代表保留了结构化原始 code。默认两个 snake_case 标识和含空格标识都支持这些格式。

不匹配正文引用、code 的前缀/后缀变体、第二行标识、引号包裹的整条模板、JSON 中嵌套的 code。首版不做任意 JSON/正则/通配符/子串规则。上游压扁为文本之后，无法绝对区分真正外层模板与逐字相同的上游回显；本插件不承诺原始 code 来源的真实性。

永久错误 guard 优先于用户列表：已知 AUTH、QUOTA、ACCOUNT_QUOTA、ABORTED、无效请求/配置/凭证、上下文超限、图片 offload 恢复等不改。结构化 HTTP 4xx 除 408/429 外不改。已有 TIMEOUT、TRANSPORT、SERVER、RATE_LIMIT、EMPTY_RESPONSE **保留原码**，由 provider 原有策略决定重试。

因此 stream_timeout 如果已被 DSH 正确分类成 TIMEOUT，本来就能按官方策略重试，本插件不会改成 TRANSPORT 或改变差异化策略。清空 errorCodes 只停用本兼容层，不会关闭 DSH 官方已经支持的重试。PI_AI_ERROR、UNKNOWN、STREAM_CLOSED 是泛化承载码，不能通过把它们加入列表来批量重试所有通用错误；仍须识别外层的明确上游标识。

## 安装与配置

这是 Host + Web client 的普通 bundle；[manifest](<package.json>) 声明 [组合 patch](<cordis.patch.yml>)，只挂载一个全局分类器。需要现有组合已启用官方 dsh-llm-retry（标准 base bundle 已声明它），且目标 provider 的 retryPolicy 允许 TRANSPORT。不要重复挂载另一个官方执行器。

从目录安装（示例，**此开发过程未执行安装**）：

    dsh plugin --profile web add /绝对路径/dsh-stream-retry

也可在 DSH 插件管理器的添加插件操作中使用这个目录或打包的本地 tgz。CLI/插件管理器的安装会修改 profile；不要手工在本机安装目录或用户 profile 中复制代码。

安装后，在插件管理器进入本 bundle，找到 stream-retry 行的“配置 / Configure”入口，可编辑两个逐行列表。页面使用公开 plugins.row.config 和 configForms；只有 Host 服务已提供可编辑配置时才出现。没有另起 Web 服务器。

- **保存**：一次原子提交两个字段，携带开始编辑时的 revision；只修改这两字段，不覆盖未知设置。
- **放弃草稿**：重新读取当前已接受值。
- **恢复继承值**：暂存清除用户覆盖的操作，按“保存”后才生效。
- 远端已更新、只读、校验失败或连接异常时不会偷偷覆盖数据；保存被拒绝会保留草稿。

两个字段为 volatile 设置，读取新的 terminal failure 时使用最新值，不重启正在运行的 agent。若组合或安装结果提示 restart-required，请按结果重启；不能只凭安装成功就认定已激活。保留 patch 中的 row id=stream-retry，配置页按它寻址。

文件配置示例（保留默认三项再追加自定义项）：

    - id: stream-retry
      config:
        errorCodes:
          - upstream_stream_read_error
          - stream_timeout
          - stream error
          - gateway_disconnect
        providers: []

errorCodes 是完整列表，不是增量。重试次数、退避、是否重试 TRANSPORT 仍配置在**目标 provider 的 retryPolicy**，不是本插件。DSH 默认 normal 策略最多五次重试，500ms–10s 退避和 10% jitter；用户已有不同策略时，本插件尊重它。

## 安全与范围

- 只改变错误 finish 的分类，保留 message/status/requestId/providerRetryAfterMs/replayState 等字段，不修改 frozen request。
- 普通 token 原样流过，不缓冲或拼接多个模型响应；每次只调用 next() 一次。
- 用户取消、插件卸载和官方退避取消都不会被转成额外请求。卸载后已经捕获的分类器也停止新增映射。
- 日志仅包含 provider、原分类码和命中标识，不输出完整错误描述、请求消息或 replay 内容；日志说“分类”不代表官方一定安排了重试。
- 全局挂载覆盖共享同进程 LLM/loop 的主 agent、spawn、fork、continuable child；远程/其他进程要在对应运行环境另行安装。
- 直接调用 ctx.llm.stream() 只会看到修正的错误码，**不会自动重试**。真实恢复需要 agent loop + 官方重试执行器。
- 不是“续传 token”，不重跑整个已完成任务。每次请求重试可能再次计费，不能保证 provider 自带工具或远端副作用 exactly-once。

## 开发与验证

[后端](<index.js>)、[匹配器](<matcher.js>)、[Web 配置页](<client.js>) 是可直接运行的 JavaScript，无构建或安装脚本；[类型声明](<index.d.ts>) 描述 public plugin 接口。应用层只依赖 Schemastery；DSH/Cordis peer 声明约束已经验证的宿主版本，不复制另一个 LLM 服务或重试执行器。

安装依赖并运行检查与单元测试（不需要 DSH 运行时）：

    npm install --ignore-scripts
    npm run check
    npm run test:unit

集成测试需要一份已安装的 DSH 0.2.0-rc.2，并显式指定它的位置；包内没有任何硬编码机器路径：

    # 全局安装：指向包含 node_modules/@deepseek-ai/dsh 的目录
    DSH_RUNTIME_ROOT=/usr/local/lib npm run test:integration

    # 或把本包安装进某个 profile 后，在能解析 @deepseek-ai/dsh 的目录直接运行
    npm run test:integration

未设置 DSH_RUNTIME_ROOT 且无法解析到已安装的 DSH 时，集成测试会给出明确错误，而不是猜测本机路径。

[后端行为测试](<test/plugin.test.mjs>) 从 public apply / Config 及 llm/stream 测试预设、字面边界、永久码、配置列表、取消、字段保留和卸载。

[client 协议测试](<test/client.test.mjs>) 用公共 configForms/slots 模拟检查原子保存、revision 冲突、草稿、重置、卸载及两个可访问编辑器；不导入私有 Harness Client 包，只使用平台 React。

[真实 runtime 集成测试](<test/integration.test.mjs>) 通过 [runtime helper](<test/runtime.mjs>) 挂载真正 Cordis/core/本产品/官方 retry，注入离线 mock adapter，不调用真实模型 API。验证 same-step 重试、partial 隔离、UNKNOWN/STREAM_CLOSED 实际 adapter throw、预算耗尽、事件驱动取消及 in-process 子 agent。持久测试只使用测试自建临时 JSONL，清理路径有 ownership 校验，不修改现有用户会话。

本机已执行 npm run check 和 npm test：**59/59 通过**，其中后端行为 13、client 公共协议模拟 12、真实 DSH 集成 34。主 agent 亲自重跑，退出码 0，stderr 为空。测试使用 1ms 退避以快速确定性验证，不改变生产退避；另用 60s 官方退避验证事件触发取消。

**验证限制：没有安装到当前 Web profile，没有实际浏览器操作或真实上游网络测试。** 配置页目前通过公共协议/组件模拟测试；必须安装后再确认实际入口、保存和视觉效果。临时离线 persistence 测试不等于崩溃后的自动恢复。

## 官方接口依据

- [插件 Config](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)
- [官方重试插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-retry/README.md)

当前实现以本机 0.2.0-rc.2 的公开声明和运行测试为准；master 的接口可能变化，升级前应重新验证。许可证：[MIT](<LICENSE>)。