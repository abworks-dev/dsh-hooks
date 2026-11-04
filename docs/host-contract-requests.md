# 剩余 Hooks 能力需要的宿主契约

这是提交给 DSH 维护者的接口需求与验收清单，不是现有可调用 API，也不是本插件已经支持这些能力的声明。现状和 Codex 差异见 [能力对齐](codex-alignment.md)。未向任何远端提交 issue。

## Stop 同步续跑

2026-11-04 再次只读查询当前 Host 的 agentLoop 和 agent/turn-stopping：

- 事件为 serial，精确签名为 `'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void`。
- 事件说明明确监听器在提交前用 `agent.steer(...)` 提供新工作，状态机随后重读 inbox。因此不是缺少前置时点。
- 事件和 agentLoop 返回的公开 Agent 声明仍只有 `readonly id: SessionId`；未给出 steer 参数、返回类型和取消语义。

需要：公开原始 Agent 的精确续跑契约、允许的消息构造形式、拒绝/取消结果，以及与正在结束的 turn、disposed、同 ID 新 Agent 的绑定规则。不要要求插件按 ID 重新 resume 会话或伪造用户 prompt。

验收：原始 Agent 被替换、已释放或 turn signal 取消时不投递；监听器串行组合不丢已有工作；重复 Stop 有界且可取消；脚本失败不能产生无界续跑。所有测试不得自动同意审批。

## PreToolUse 参数改写

2026-11-04 重新查询 tools/pre-execute：ToolExecutionInput.arguments 为 readonly；PreToolDecision 仅包含 allow/deny/cancel/ask，没有替换参数字段。不能通过强制修改 exec.arguments 或重调 tools.execute 冒充原调用的改写。

需要：公开参数替换决策，规定工具 schema 重新校验、后续门禁/审批对替换值的复核、原 callId/token/取消信号保留，以及多监听器改写的组合顺序。

验收：原始执行对象被冻结时仍正常；改写不产生第二次工具调用，不绕过后续审批；非法输入 fail closed，取消不执行。当前插件拒绝 updatedInput 控制输出，既不修改原输入，也不以 allow 绕过后续策略。

## 同步及后台追加上下文

已知 tools/post-execute 的 accept 决策有 additionalContexts，但消息基类/文本块和多处 additionalContexts 的合并契约尚不完整。

需要：完整 MessageBase/UserMessage/TextBlock 定义；next() 决策与工具结果的追加、替换、顺序和取消规则；后台结果进入模型的明确安全时点；会话 idle 时不新建 turn、结束后丢弃结果的可验证操作。

验收：后续插件的 block/替换不可被绕过；现有上下文顺序保留；取消不迟到投递；不同 Agent 不能串会话；不改写系统消息或用户历史。

### 模型请求通知不等于上下文写入口

当前 llm/stream 为 waterfall，签名是 `(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`。Host 明确 LOOP 请求为 deep-frozen；手工请求由调用者保有输入所有权。读取 sessionId/provider/model 或公开 finish reason 可用于诊断，但 sessionId 本身不证明 LOOP 来源，不能据此改写 messages/system/tools 或把后台输出拼入请求。通知必须保持原 chunk、next 次数、异常及迭代器关闭语义；后台排队还须绑定原 Agent/Session，不能在同 ID 新主体上续发。这类观察扩展是插件工作，不解决上述安全时点交付契约。

### 无需新增宿主接口：模型 usage 元数据（0.15.0 已本地安装）

当前公开 `StreamChunk` 已含 `{ type: 'usage'; usage: TokenUsage }`；`TokenUsage` 要求 `inputTokens`、`outputTokens: number`，可选 `totalTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens: number`。这不需要新增宿主 API。`GenerateOptions` 没有 turn_id，不能推导或伪造。

源码已只为 PostModelRequest 添加 `token_usage`，保留旧 status 和所有流语义。官方只证明 counts-or-null，没有明确内部键；上述 camelCase 六字段属于 DSH 本地投影，不能宣称 wire 兼容。使用前须验证自有数据描述符、普通对象和非负 safe integer，不触发 getter，不读取未知字段；在 yield 原 chunk 前复制。每次可见模型调用保留最后一份完整有效快照，非法后续值不覆盖，不求和、不合并、不补总数；没有有效值用 null。不是可靠的重试尝试计数。

验收：原 chunk/异常/return/next 次数不变，正文 getter 不读取；提供方在 yield 后或排队期间修改原对象不改变快照；不同调用隔离；请求 abort 后 Post 仍可诊断，但 Agent/Session 替换或释放取消排队。执行记录、存储、GUI、规则与信任定义不增加用量字段。先用注入执行器验证，不运行真实用户脚本。

## 压缩事件

当前提交后日志与摘要失败恢复入口不能冒充压缩前门禁。公开 SessionEventMap 的压缩字段仍被投影截断。

需要：完整且可独立查询的压缩事件类型；开始、成功结束、失败与取消的区分；若支持 PreCompact，提供真正提交前的等待点并明确控制能力。

验收：失败尝试不触发成功 PostCompact；不能由日志时间推测前置；同次压缩有稳定关联标识；取消和重复通知有明确语义。

## MCP handler

通用工具名称、schema 和 execute 不证明 MCP 来源，资源 provider 注册也不是工具目录。

需要：可验证的 server/connection/provenance 与工具映射；保留原始 Agent、调用 token、scope、signal 以及现有工具/审批策略链的调用入口；定义断线、替换、递归与重入规则。

验收：名称前缀伪装不能获得 MCP 身份；权限拒绝保持拒绝；不直接调用工具实现；不自动重试有副作用的调用；不自动审批。

## 不是宿主接口缺失的项目

更多后台事件与调度策略仍可在插件层推进。Stop/UserPromptSubmit/SessionStart/Interrupt 的显式后台元数据通知、显式登记来源的启动/轮询检查、冲突与信任撤销已交付；空来源和非空来源的登记、预览更新、接受与解除登记已完成真实页面回归，均未执行命令。不能把这些工作混入上述接口需求，或将检查间隔说成即时撤销保证。实际存储后端的备份恢复仍缺少完整验收，不以 fixture JSON 往返替代。
