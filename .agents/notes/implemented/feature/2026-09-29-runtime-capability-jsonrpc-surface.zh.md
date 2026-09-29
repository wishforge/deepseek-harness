# Agent Note: 通过 stdio JSON-RPC 暴露运行时能力

Status: implemented

[English](2026-09-29-runtime-capability-jsonrpc-surface.md) | 中文

## Problem

从外部驱动本运行时的进程——目前是 shell 调用已发布 `dsh` CLI 的 agent harness——无法向运行时询问三个 决定调用方行为的问题：当前部署提供哪些能力、本部署的沙箱策略对某个具体文件系统操作给出什么结论、以及它 先前创建的 scope 是否仍然存在。这些知识目前只存在于进程内部：能力事实在包清单与 profile 模板里，沙箱策略 在 `SandboxPolicyService` 之后，scope 身份在 scope 包自己的注册表里。

这一缺口的代价是重复实现并随之漂移。需要策略答案的调用方要么内嵌本仓的策略代码，要么自行重新实现；两者 随后互相不一致，于是模型被告知的是一回事，运行时实际执行的却是另一回事。同一缺口也让拒绝无法上报：调用方 只能得知某个操作被挡住，而不知道是运行中的 profile 要求了该部署并未提供的服务。

## Decision

profile `harness-capability` 加载新插件 `harness-jsonrpc-server` （`packages/sdk/harness-jsonrpc-server`）及其 bundle `harness-app` （`packages/bundle/harness-app`），并在 CLI 已经拥有的 stdio JSON-RPC 传输之上提供四个方法：

```text
get_capabilities, get_context, create_scope, policy_check
```

- `get_capabilities` 返回加载中 profile 的静态清单。它只报告哪些能力可用；两侧都没有任何注册由它派生。
- `get_context` 返回运行时身份、profile 名、解析出的沙箱模式与工作区根，以及目前已创建的 scope id。
- `create_scope` 包装 `packages/core/scope` 中已被验证的 `createScope`，并记录其返回的 id。
- `policy_check` 依据 `SandboxPolicyService` 为本部署解析出的沙箱模式与工作区根评估单个操作。

两个依赖都是 required inject：`inject = ['sandboxPolicy', 'harnessAppStartup']`。缺少策略服务的部署不会 悄悄提供一个用臆测答案填充的能力面——插件根本不加载。该 profile 是可选加入的：已发布的 `base`、`sdk`、 `acp`、`web` profile 均未变化，stdout 依旧只留给协议帧。

## Wire contract

| 方法 | 参数 | 结果 | 失败 |
|---|---|---|---|
| `get_capabilities` | `{}` | 该 profile 的能力清单 | — |
| `get_context` | `{}` | 身份、profile、沙箱模式、工作区根、scope id | — |
| `create_scope` | `{key}` | `{scopeId}` | key 重复 |
| `policy_check` | `{operation, path, scopeId?}` | `{decision, reason}` | operation 或 path 非法、scope id 未知 |

- 可选的 `scopeId` 在缺省时**省略**，绝不发送 `null`；非字符串值被拒绝，而不是被强制转换。
- 被拒绝的操作是带 `decision: "denied"` 的正常结果；只有参数畸形与运行时故障才是错误。
- 所有 handler 侧失败都以传输层的 `-32603` 加语义化消息呈现（`invalid params: …`、 `scope not found: …`、`unknown DeepSeek Harness runtime capability method: …`）。

## Scope semantics

`create_scope` 通过共享 scope 包创建真实 scope 并记录其 id；后续 `policy_check` 提到该 id 时只检查该 id 是否存在。没有任何策略答案会因为提供了 scope id 而不同。读者可能假设的更强性质——scope 会改变适用哪套 策略——既未实现也未声称：`SandboxPolicyService` 由部署默认值加会话的模式与工作目录解析，而由 `Context.extend` 创建的 scope 无法遮蔽一个已提供的服务，除非使用 `Context.isolate` 加一次全新注册，本次 变更并未尝试。

## Alternatives considered

**MCP 式动态发现。** 以 `tools/list` 形状的调用提供能力列表、让调用方注册返回的一切，会把本运行时的打包 耦合到某个调用方协议，并使该面可由构建之外配置。四个方法改为在源码中固定，从而让 wire 契约可评审、调用方 的工具列表稳定。

**只用进程内库导入提供这些方法。** 链接本仓包的调用方能得到相同答案且没有 wire 面，但它必须精确匹配版本 并在自己进程内运行该运行时，而这恰是本能力面要保留的隔离。

**带 `data` 载荷的类型化错误码（`-32602`、`-32001`）。** 这是更精确的契约，但在不修改共享传输的前提下不可 达：handler 抛出的错误被固定为 `-32603`，而传输层私有的 `writeError` 不接受 `data`。为一个能力面新增一条 平行传输路径被判定为不值得引入这种分叉；语义化消息承载了同等信息。

**把 `sandboxPolicy` 改为可选，使能力面总能加载。** 那么没有解析出策略服务的部署将用猜测回答策略问题。 拒绝加载才是诚实的结果。

**在同一能力面上加入 `dispose_scope`、网络、进程或审批策略。** 每一项都需要本次变更不做的语义决策——销毁 生命周期、部署能表达哪些进程或网络规则、没有人参与时审批答案意味着什么——而一个靠猜的能力面比一个保持狭窄 的能力面更糟。

## Consequences

- 能力面固定为四个方法。新增第五个是 wire 变更，其后需要调用方发版——这正是可评审契约的预期代价。
- 调用方现在能得知拒绝：未知方法、畸形参数、未知 scope id、正在关闭的服务端，都能通过消息区分，而不是靠 沉默。
- 能力上报是清单，不是探测。它报告该 profile 发布的内容，而非某次部署实际已经跑过的内容。
- 策略答案就是部署自身的答案，因此调用方不再需要第二套策略实现；上文 `Scope` 的限制界定了这一收益的边界。
- 加载该 profile 需要两个被注入的服务同时存在；缺少任一者的部署得到的是没有能力面，而不是降级的能力面。
- Agent Note 是本次变更为 wire 语义新增的唯一文档；该变更的工作设计集存放在本仓之外。

## Testing

- `vitest run packages/sdk/harness-jsonrpc-server packages/bundle/harness-app` 覆盖两种入站方言、参数校验、 跨调用的 scope 状态、并发在途请求的关联、`dispose` 与 `shutdown` 两条拆卸路径（含多失败传播），以及在 进程只退出一次之前先应答的 shutdown 帧。
- 逐文件覆盖率门禁在三个新源文件上保持通过。
- 真实的 `dsh --profile harness-capability` 应答全部四个方法，stdout 仅协议帧，stdin EOF 时以 0 退出。
- 与调用方客户端进行的跨进程运行覆盖握手、全部四个操作、四个并发请求、未知方法错误帧与干净关闭。
- 模型驱动的运行覆盖该接缝的端到端行为：本地模型与生产提供方各自调用 `policy_check`，以及先 `create_scope` 再用返回 id 调 `policy_check`，会话记录中可见运行时自身的返回文案。

## Related

- 调用方一侧的变更（会话持有的运行时、四个工具、`[harness]` 配置）位于另一个仓库；本 note 记录该接缝的 提供方一侧。
- [Profile system](2026-07-07-mcp-client-plugin.zh.md) 是可选 profile 承载带 required 依赖插件的最接近先例。
