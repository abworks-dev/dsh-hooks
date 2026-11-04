# Codex 风格，不是兼容层

核验基准：2026-11-04。首要来源是 [Codex Hooks 官方发布文档](https://developers.openai.com/codex/hooks)（当前跳转至 [Hooks](https://learn.chatgpt.com/docs/hooks)），发布行为优先于可能超前的 main schema。[官方源码事件表](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs)只作佐证；不借用 Claude Hooks 冒充 Codex 能力。

## 最新官方复核（2026-11-04）

再次读取 [官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)，仍为 14 个事件；PreModelRequest/PostModelRequest 共用 `premodelrequest-and-postmodelrequest` 章节，不能把两个独立锚点不存在误判为事件移除。当前模型章节明确每次尝试（含重试）触发、输出仅诊断，不可改上下文或阻止请求；PostModelRequest 的官方 status 为 completed/failed/cancelled，另有 error、token_usage 和 turn_id，以及可用时的 agent_id/agent_type。

本插件仍保留 DSH 流观察的状态值（如 stop、error、aborted、closed），没有承诺上述字段或同等尝试关联；不伪造 turn_id，不为追求字段齐全泄露原始错误正文。模型通知可用不等于 Codex payload 等价。官方后台仍为每会话 8 并发、SessionEnd 始终同步；本插件的 manager 级 4+32 队列与安全点上下文交付差距不变。

## PermissionRequest 后台观察（0.19.0 已本地安装）

共享白名单新增仅观察型 PermissionRequest；async:true 与 denyPermissionRequest:true 严格互斥，仍只允许元数据，不读参数、审批原因或显示正文。原绑定先等待同步拒绝策略，再发起观察分支；后台不等待脚本完成、不采纳 deny/allow/退出码/上下文，不产生审批策略结果标签。它只代表请求曾进入此监听器，不代表获准、工具执行或最终审批结果；原始 next() 的 allowed-once/rejected/cancelled/unavailable 与异常保持不变。

保存/导入仍关闭且未信任，原始 Agent/Session、取消和 4+32 容量限制保持不变。源码已包含后端/导入及编辑器互斥控件：选后台观察清除拒绝策略，选拒绝策略清除后台观察；同一时刻旧回调也使用最新草稿，完整载荷/输入选项和事件切换仍清除不兼容模式。Host 信任审阅以精确规则而非草稿说明模式，后台视图不误显示同步失败拒绝文案。0.19.0 已本地安装并应用；现有真实桌面编辑器已验证默认双 Off、仅在未保存草稿中的双向互斥及取消清理；默认态截图已目视核对，未执行用户命令或真实审批，不等于所有执行/键盘/主题状态验收。

## PreToolUse 后台通知（0.18.0 已本地安装）

显式 metadata-only 后台通知不再充当安全门禁：工具可能先于通知执行，后台退出码 2、deny/block、非法输出或异常均不作为门禁决定。未选择后台的默认同步 PreToolUse 仍等待并按既有规则拒绝；同一事件的同步规则继续参与仲裁，前置同步拒绝可能跳过后续通知，先入队的通知则只代表尝试而非已确认执行。资源仍共享，繁忙的同步门禁仍拒绝，不承诺零可用性影响。

编辑器默认关闭，明确提示“不作为安全门禁”；保存/导入仍关闭且未信任，完整载荷及工具参数分享不允许后台。切换参数分享会立即清除后台勾选，避免页面显示与保存结果不一致。0.18.0 已打包并本地安装，application:applied/changed:true；随后真实桌面编辑器核验默认 Off、可选、全局暂停与非门禁提示，截图确认勾选框同行及元数据默认；取消草稿并关闭，无保存/信任/启用/执行。未覆盖亮色、窄屏、完整键盘或真实命令，不将单一路径扩展为全场景验收。

## PostToolUse 后台通知（0.17.0 已本地安装）

新增显式 metadata-only 后台选项，复用原 Agent/Session、4 活动/32 等待及取消边界。现有 tools/post-execute waterfall 只等待排队决定，随后调用并原样返回 next() 的真实决策，不等待后台命令完成；其他插件的 block、替换结果或异常不被异步输出覆盖。工具输入、结果及附加上下文不读取，stdout、退出码和 JSON 不作为反馈、阻断或上下文；不回滚工具，也不重新执行工具。该模式不会提供成功/失败结果正文，不宣称完整 Codex PostToolUse payload 等价。

保存/导入仍关闭且未信任，编辑器默认不勾选；完整载荷、includeToolInput 与审批策略不能和后台模式组合。原有未选后台的同步 PostToolUse 反馈路径不变。0.17.0 已打包并本地安装，application:applied/changed:true；随后真实桌面编辑器验证默认 Off、可选、全局暂停与不读结果/不反馈提示，截图确认勾选框同行与元数据默认；取消草稿并关闭，无保存/信任/启用/执行。未覆盖亮色、窄屏、完整键盘或真实命令，不以此宣称全场景验收。

## 模型用量快照（0.15.0，本地安装，尚未公开发布）

PostModelRequest 新增 `token_usage`：有有效 usage 块时投影 DSH 的 `inputTokens`、`outputTokens`，以及出现的 `totalTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`；没有有效值为 null。Pre 和其他事件不增加此字段。官方没有在发布文档中定义该对象内部键，因此这里的 camelCase 是本地结构，不是 Codex wire 兼容声明；原有 status 保持不变，不添加原始错误或 turn_id。

只接受自有数据字段及非负安全整数，不执行 getter、不读取未知字段或正文；在原块 yield 前复制。每次可见调用使用最后一份完整有效快照，后续非法值不覆盖，不合并、不求和、不补总数。排队期间提供方更改原对象不改变计数；不同调用独立。这不是宿主内部重试尝试的完整计费账本。规则、信任、存储和执行记录不新增用量字段；不改变原模型流、请求取消和原 Agent/Session 失效边界。0.15.0 已打包并本地安装，application:applied/changed:true；未执行真实用户钩子，无新增界面，不把单元回归当成真实脚本验收。

## 本地 SubagentStart 后台通知（0.16.0 已本地安装）

公开 `subagent/start` 是子智能体发布后的 emit；Host 明确进程内子智能体在通知时可由 `ctx.agents.get(info.id)` 获取。源码新增显式 metadata-only 后台白名单，捕获原始子 Agent 和 Session，并要求 local:true；外部提供方、无原 Agent/Session、同 ID 替换或释放均不启动排队通知。保存/导入仍关闭且未信任，完整载荷或工具输入不允许后台；编辑器默认不勾选，风险提示明确只支持本地子智能体。

只发送既有 child_id/run_id/provider/local 等元数据，不读取提示或子任务回复，不等待初始化、不续跑，也不将 stdout 用作控制或上下文。公开 RunInfo 没有 agentType，不把 provider 冒充 agent_type；因此官方按 agent_type 精确筛选也尚不等价，实际绑定仍只能依赖已有缺省/通配匹配行为。复用同一 4 活动/32 等待队列，不新增独立预算。作用域与生命周期绑定原始子会话，不假装 Codex 主会话或父线程标识；SubagentStop 仍不支持后台，不把已经释放的子智能体当作存活主体。0.16.0 已打包并本地安装（application:applied/changed:true）。随后真实桌面验证 SubagentStart 编辑器后台选项默认关闭且可选、全局暂停及本地限定提示可见，截图确认勾选框同行与元数据默认；取消草稿并关闭，未保存/信任/启用/执行钩子。未覆盖亮色、窄屏、完整键盘或真实脚本，不以此宣称全场景验收。

## 模型事件后台通知（0.14.0）

源码后端新增 PreModelRequest/PostModelRequest 的显式 metadata-only 后台白名单；保存/导入仍关闭且未信任，不允许完整负载或工具输入。实际 llm/stream 绑定保持 next、原 chunk、异常和提前关闭；通知不等待脚本完成、不改写请求、不交付上下文。模型消息/系统提示/工具及块正文不读取。排队绑定事件时的原 Agent/Session，并快照 sessionId；无存活 Agent、主体替换或释放不执行。请求 abort 取消 Pre 通知，Post 仍可报告已结束的 aborted 状态；这不是恢复模型任务。

当前过滤只有 sessionId 和 purpose，并不证明 LOOP 来源；session-title/compaction 请求不触发通知，不能将模型调用等同于压缩前后事件。源码编辑器现已加入这两个事件的后台选项，默认关闭，切换完整载荷或工具事件会清除后台选择；风险提示区分模型通知与结束通知。0.14.0 已打包并本地安装（application:applied/changed:true）；随后真实桌面分别验证 PreModelRequest/PostModelRequest 编辑器：后台选项默认关闭且可选、仅元数据默认、全局暂停和模型边界提示可见，复选框与标签同行；取消草稿并关闭配置，未保存、信任、启用或执行命令。未覆盖亮色、窄屏、完整键盘或实际脚本执行，不以此宣称全场景视觉验收。完整 Codex 后台输出安全点交付仍未实现。

## Interrupt 后台通知（0.13.0）

重新核对公开 `session/event`：这是日志提交后的 emit，签名 `(session: Session, event: SessionEvent): void`；只有 `turn/end` 的 `aborted/user` 原因可映射用户中断，不能阻止或重启已中断任务。现有监听按 Session 对象和 seq 去重，不能直接复用已中断的 turn signal 来启动通知，否则通知会在执行前被取消。

此项不是整体缺少 Host API。源码现已复用精确 Agent/Session 身份与 metadata 队列，并为 `async:true` 的 Interrupt 单独设置默认 1000 ms、范围 100..3000 ms；超限拒绝，不截断。导入仍默认 1 秒、最大 3 秒；原生未选择后台模式的既有规则保持默认 5000 ms、上限 600000 ms，false/缺省的规范定义与信任摘要不变，避免旧配置加载失败。编辑器仅在用户选择后台模式或从其他后台事件切入 Interrupt 时，将超限旧值改为 1000 ms；有效短值保留，保存仍关闭且未信任。监听器额外捕获事件时的精确 Agent，和原有 Session 身份一起在出队/执行前复核；不读取消息正文。专项覆盖去重、输出控制忽略、取消、身份替换与共享队列。0.13.0 已打包并本地安装，application:applied/changed:true。随后真实桌面 Interrupt 编辑路径确认后台通知默认关闭、可选、全局暂停、短超时/不重启提示可见且勾选框同行；UIA 验证未保存的显式选择将超时改为 1000 ms，再取消选择并取消编辑/关闭配置。没有保存、审阅信任、启用或执行用户钩子；未覆盖亮色、窄屏、完整键盘和真实命令执行。

## 官方真的展示了什么

| 官方案例/协议 | 出处与关键内容 | DSH Hooks 当前对应 |
| --- | --- | --- |
| 工具执行前策略 | [PreToolUse](https://developers.openai.com/codex/hooks#pretooluse)：tool_input、permissionDecision=deny、updatedInput | 显式共享工具输入、deny/理由子集；allow 不绕过审批，updatedInput 未实现。项目危险命令检测脚本是演示，不是官方算法 |
| MCP 扫描补丁 | [MCP tool hooks](https://developers.openai.com/codex/hooks#mcp-tool-hooks)：PostToolUse、Write\|Edit、scanner.scan_patch、timeout 30 | 未实现 MCP handler；自行用 command 集成不等于原生官方 MCP 支持 |
| 会话上下文 | [SessionStart](https://learn.chatgpt.com/docs/hooks#sessionstart)：按 source 匹配 startup/resume/clear/compact/fork；纯文本 stdout 或 additionalContext 加入 developer 上下文。compact 来源在紧接的模型续跑前交付，continue:false 可结束本轮 | 仅观察真实 agent/created；不因压缩日志伪造 source:compact，不注入 stdout 或控制模型续跑。事件命名相同不证明触发范围相同 |
| Stop 质量门禁 | [Stop](https://developers.openai.com/codex/hooks#stop)：decision=block、continuation、stop_hook_active | idle 后通知，不能续跑或否决结束 |
| 中断审计 | [Interrupt](https://developers.openai.com/codex/hooks#interrupt)：不可阻止/重启 | 12 类映射中包含明确 user 取消后的 Interrupt；其他取消原因不冒充用户中断 |
| 桌面完成提醒 | [Notifications](https://developers.openai.com/codex/config-advanced#notifications)：JSON argv、agent-turn-complete、terminal-notifier | 这是 legacy notify，不是 hooks stdin。本项目 Stop/SubagentStop 示例独立实现，不发送提示或回复 |

官方列出的 logging/analytics、API-key scanning、persistent memories、turn-stop validation、directory-specific prompting 是用途，不表示每项有完整官方脚本或本项目全部支持。未核实到官方 Prettier 完整脚本，不称“官方格式化模板”。[本项目示例](recipes.md)保留独立身份。

## 0.12：会话创建后台通知

已本地安装 SessionStart 的显式 metadata 后台子集，与 Stop/UserPromptSubmit 共享队列、信任及主体取消检查；按真实创建事件来源匹配，不等待初始化、不注入上下文、不实现 continue:false，不补发挂载前事件。真实页面已确认 SessionStart 编辑器后台通知默认关闭、metadata 默认、执行暂停及初始化/上下文提示，取消后未保存规则。此编辑路径的截图不替代真实命令、完整键盘或其他布局验收。

## 0.11：消息入队后的后台通知

工作区已将显式 metadata 后台通知扩展到 UserPromptSubmit，与 Stop 共享既有 4 活动/32 待处理队列。Host 的 agent/inbox/inserted 为 emit，在消息已进入 inbox 后发生；不读取消息正文，不阻止提交，不注入上下文，也不延迟或重新审批工具。导入、编辑及信任审阅沿用关闭/未信任、显式选择和精确 Agent/Session 失效检查；工具与审批事件仍不接受 async:true。0.11.0 已打包本地安装；真实页面确认 UserPromptSubmit 编辑器的后台通知默认关闭、全局暂停及隐私/时点提示，取消后未保存规则。没有执行真实通知命令或把该检查当成完整 Codex 后台结果交付验收。

## 能力矩阵与优先级

| 能力 | Codex 官方行为 | 本项目 0.14.0 | 剩余差距 |
| --- | --- | --- | --- |
| 事件 | 14 个 | 12 个 DSH 映射；子代理、模型与 Interrupt 仅诊断 | P1：PreCompact、PostCompact；更完整的结束原因 |
| Handler | command、mcp_tool；prompt/agent 解析跳过 | 同步 command；显式 Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest 后台元数据通知 | P1：安全 MCP 路由；P2：完整异步调度与交付 |
| 配置 | 用户/项目/managed/session/plugin 活跃来源累加；高优先级配置不替换低优先级钩子 | 显式 user/project scope；固定用户/项目 JSON/TOML 联合预览和原子导入；可登记选定来源，启动检查及约 30 秒完成间隔复查，变化撤销信任，明确审阅后更新；TOML 仅提取 hooks | P1：managed/session/plugin 完整活跃来源策略；不自动接受或导入变化，本项目顺序不等价于 Codex |
| Matcher | 正则、事件特定目标和忽略规则 | glob + 独立 worker regex，原生/导入均为本地 512 字符上限、2 秒启动/100 ms 匹配预算 | P2：引擎、工具命名和元数据差异 |
| 输入 | 事件特定参数、cwd/transcript 等 | metadata 默认；includeToolInput 仅工具输入；full 显式共享工具输入/结果 | 不发送提示、模型正文、transcript；不自动切换项目 cwd |
| PreToolUse | deny/allow/updatedInput 等 | 默认同步拒绝 JSON 子集；allow 继续原审批链；显式后台仅通知，不作门禁 | P2：updatedInput；不自动审批 |
| PostToolUse | 可影响反馈，不回滚副作用 | 同步模式 block/continue=false 或 exit 2 替换反馈；显式后台模式仅元数据通知，不采纳输出控制 | 不支持任意结果改写或后台上下文交付 |
| PermissionRequest | 同步 decision.behavior 的 deny/allow；无决定回原审批链 | 默认只观察，显式 denyPermissionRequest 策略支持 deny；allow 仍委托原链 | 不自动批准，失败使用本地 fail-closed；消息仅诊断 |
| 上下文/Stop | additionalContext、事件特定继续控制 | 未实现；Stop/子代理结束只观察 | P1：上下文安全时点；P2：Stop 续跑 |
| 信任 | [定义审阅](https://developers.openai.com/codex/hooks#review-and-trust-hooks)、脚本更新重审、managed/项目信任 | 二阶段绑定规则 + exe + 显式 trustFiles；启用/执行重哈希 | P1：来源策略；不是 OS 沙箱或原子执行保证 |
| 调度 | 同步及受约束 async；同事件匹配的 command 可并发运行 | command 最大 600 秒，普通 Codex 导入默认值原样保留；同步按规则顺序等待、繁忙不排队；Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest async 每 manager 合计 4 活动/32 待处理；同步/异步共享 4 活动任务及 4 个未 close 的直接子进程句柄，非跨实例或进程树上限 | P2：同事件并发、每会话异步队列及安全交付；Codex 默认 600 秒不静默缩短 |
| 失败 | 按事件处理 | PreToolUse 执行/控制失败拒绝；post 不撤销执行 | 不笼统声称与 Codex 同样 fail-closed |

## 审批拒绝子集（2026-11-04）

[当前官方文档](https://learn.chatgpt.com/docs/hooks)定义 `hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message?: string}}`；allow 在 Codex 可直接放行，但本项目为保留安全边界只委托 DSH 原审批链，绝不自行批准。官方明确 updatedInput、updatedPermissions、interrupt 是保留字段，continue/stopReason/suppressOutput 不支持；当前 PermissionRequest 章节没有确立 exit 2 等于拒绝，不能从其他事件推断。

DSH 公开 `approval/request` 是可等待 waterfall，结果仅为 allowed-once/rejected/cancelled/unavailable，足以实现**拒绝子集**而不能携带消息。规则必须逐条显式选择 denyPermissionRequest=true，保存后重新审阅并启用；旧、默认和导入规则仍只观察，不能被输出悄悄升级为策略。策略失败/非零退出码/繁忙/校验错误按本地 fail-closed 拒绝，取消优先；观察通知不等待，不控制审批。没有作用域匹配时继续原链。审批输入只有公开会话/工具元数据，不读取理由、displayReason 或虚构 tool_input。async、自动批准及保留字段不支持。这是有意限制的兼容子集，不是完整 Codex 审批仲裁实现。

## async 协议复核（2026-11-04）

[官方后台配置](https://learn.chatgpt.com/docs/hooks#configure-a-background-hook)是在 command handler 中设置 `async: true`（TOML 为 `async = true`），不是 stdout 返回 `{async:true}` 或 `asyncTimeout` 的握手协议；不能借用其他产品的输出协议。后台章节没有额外的窄事件白名单，但 [SessionEnd](https://learn.chatgpt.com/docs/hooks#sessionend) 明确即使设置 async 仍同步；[Interrupt](https://learn.chatgpt.com/docs/hooks#interrupt) 可后台执行，默认 1 秒、最大 3 秒。MCP handler 始终同步。

[执行与交付](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run)：后台不能阻断、审批、改写或控制触发它的动作；工具策略、审批决定、提示拒绝及续跑必须同步。官方允许配置后台 PermissionRequest，并不意味着其结果能批准或拒绝审批。0.9 仅接受显式 Stop async:true 的 metadata 后台通知，不把普通 fire-and-forget 生命周期观察称为 Codex 后台协议；工具和审批仍同步。

[官方限制](https://learn.chatgpt.com/docs/hooks#limitations)是每会话最多 8 个后台任务，其余排队，每次匹配独立执行、允许乱序完成。结果仅在下一安全时点交付：活跃 turn 等当前模型请求与工具结束后再交给下一次模型请求；idle 则等下一次用户 turn，不会自动启动 turn。会话结束取消未完成任务并丢弃尚未交付的输出。不能把用户中断等同于会话结束，或把晚到控制结果用于无关的下一次审批。官方未明确排队等待是否计入 timeout、队列容量/溢出或 OS 进程树终止确认，不能补写为既定契约。

0.9 实现仅 Stop 的显式后台通知，是本项目子集，不是官方事件白名单。每 manager 4 活动/32 等待、FIFO、有界内存队列，每次匹配独立调用，满额记录 busy、不重试；不是官方每会话 8 并发。绑定原始 exact Agent 与 Session（同 ID 替换不继承），出队重检规则身份、信任和项目作用域，启动前再次检查。任何配置写入使既有排队定义保守失效。Agent 释放取消等待项并请求取消活动项，卸载全取消；不是持久会话删除，也不确认 OS 进程树终止，直接子进程名额保留至 close。新 async 定义清信任、关闭并重新审阅，只允许 metadata、不共享工具输入；后台 stdout 不解析为控制协议，只保留有界诊断，不追加模型上下文、写 inbox、启动 turn 或自动重试。回归覆盖有界调度、身份替换、失效/取消/信任及同步门禁不可提前放行；不据此宣称完整 Codex 后台结果交付。

## 信任与导入边界

预览规则/文件指纹，再用同一摘要确认；信任不会启用或执行。保存清除信任并关闭规则；原已启用但无信任的规则迁移后关闭。启用及每次执行前重检，文件变化后需重审。仅哈希 exe 和显式 trustFiles，不自动从 argv 猜依赖；未列依赖、动态代码、网络资源不受保护，不消除 TOCTOU，也不是完整 Windows reparse 或沙箱隔离。

导入 JSON 的 command 必须使用用户显式提供的原生解释器和 argvPrefix；原始命令作为单个参数，不自动 split/猜 shell。导入关闭、未信任、不自动执行，保留原始定义与 pointer。未知字段/事件、MCP、非 Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest 的 async:true、additionalContextLimit 等不支持项拒绝整次导入。白名单内的 command async:true 导入为上述受限后台通知；async:false/缺省不产生根字段。一般省略 timeout 默认 600 秒，接受 1–600 秒且不静默截断；SessionEnd/Interrupt 导入默认 1 秒、最多 3 秒。非后台 Interrupt 及其他手工规则省略仍为 5000 ms，不改写已有超时或信任；仅手工 async:true Interrupt 默认 1000 ms、最多 3000 ms。

## 显式项目作用域，不是自动配置来源

`scope` 默认 `{kind:'user'}`，或 `{kind:'project',root:规范化现有绝对目录}`。异步核验/规范化 root 后原子保存；所有作用域共享 ID 空间，scope 绑定信任，修改后关闭并重审。用户规则先执行，其后才是匹配项目规则。

项目适用性基于原始事件主体 Session（从 Host sessions 取回）的 有效工作目录，与 root **精确相等**，不含子目录；不使用原 header cwd、GUI 当前目录、process cwd 或隐式 cd。有效目录在异步等待前捕获一次；没有主体/有效目录，或 root 缺失/重定向时跳过项目规则，生成不含目录路径的 scope_unavailable / scope_invalid 跳过记录；普通精确目录不匹配保持静默。跳过不拒绝工具，也不读取参数或运行 matcher/文件指纹。旧规则缺少显式 scope 时迁移为 user 并清信任/关闭；已有显式 user scope 的信任定义不因此变化。root 不更改命令子进程 cwd，也不是安全沙箱。

规则仍在同一所有者 storage，scope 本身不读取仓库配置。独立手动发现操作可读取用户选择目录下的固定 hooks.json/config.toml；0.6.0 从 TOML 提取 hooks，0.7.0 可显式联合预览两份来源并一次性累加导入，managed/session/plugin 不扫描。联合导入最多两份、合计 100 个处理器；每份保留来源标签与原始定义，任一不支持项导致整批拒绝。它不是 Codex 活跃层自动合并、不继承项目信任，也不承诺 Codex 并发执行次序。导入目标由所有者显式 `options.scope` 选择，与文件来源选择相互独立，源 JSON 不能声明作用域权限。

## 官方配置发现规则（2026-11-04 复核）

[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)明确列出用户层 `~/.codex/hooks.json`、`~/.codex/config.toml`，以及项目层 `<repo>/.codex/hooks.json`、`<repo>/.codex/config.toml`。JSON 使用本页描述的原生 hooks 对象；TOML 使用内联 `[hooks]` / `[[hooks.Event]]`。用户目录须考虑真实 `CODEX_HOME`，不能把默认路径当作所有实例的有效目录。

Hooks 在**活跃配置层累加**，不沿用普通标量配置的高优先级覆盖逻辑。同一层同时存在 JSON 与 TOML 时会合并并警告。匹配同一事件的 command 可并发启动，不应承诺“系统先于用户、用户先于项目”的 Codex 执行顺序；本项目的用户先、项目后是自己的策略。

项目 `.codex` 层需项目受信任；非 managed 的每条钩子另需精确定义/脚本版本的审阅。不能把读取配置、项目受信任或导入成功当作执行授权。托管来源还可能施加 `allow_managed_hooks_only`；本项目不模拟托管权限或提供绕过信任开关。

插件默认文件是 `<plugin-root>/hooks/hooks.json`；插件清单 `.codex-plugin/plugin.json` 的 `hooks` 可替换此默认来源，包含相对插件根的 `./` 路径或内联定义，路径必须留在插件根内。尚未核实到通用独立 session hooks 文件名，不能臆造。

已实现**用户主动选择目录后的只读发现与预览**：JSON/TOML 最大 256 KiB、严格 UTF-8；0.6.0 使用受限 worker 解析 TOML，仅返回 hooks JSON，不返回其他配置字段，缺失/非法 hooks 拒绝。仅固定两个候选，显示来源与拒绝状态。TOML 原文件与提取 JSON 不相同，来源哈希绑定原始文件字节；不自动合并 JSON/TOML，也不保证 Codex 活跃配置层语义。载入保留内容哈希标签，手动编辑清除标签，过期目录响应和关闭后的响应被丢弃。导入仍是关闭且未信任的显式快照副本，不关联原文件、不自动执行。祖先项目层、profile、managed、plugin/session 来源和活跃层判定不得由这四个常见文件冒充。持续同步另需定义变更停用/重审、删除、冲突及重载规则。

## 已选来源生命周期（0.10，尚未市场发布）

当前只自动监测所有者显式登记的固定来源，不扫描环境、祖先仓库或插件目录，不自动执行导入。现有导入仍是快照，不能偷偷变成持续关联。

已交付只读监测与 manager 持久归属（0.10.3 已本地安装，尚未市场发布）：最多 8 份登记，仅重读显式选中的固定文件，按原始字节摘要区分未变/变化/缺失/拒绝/不可用；单飞、逐份检查，dispose 丢弃迟到结果，不更新接受的摘要。未选中的另一份文件不读取、不自动加入；监测结果不含正文、路径或原始错误。manager 的 registerSource 重读规范来源、核对接受摘要后原子保存关闭且未信任的规则、解释器、目标 scope、revision 与规范定义归属摘要；checkSources 在显式调用时使变化的所属规则停用并清除信任，手工修改/删除形成冲突而不覆盖。未变化检查不写配置、不替换活规则身份，避免取消既有异步排队任务。保存失效状态失败时保留原持久快照，但当前 manager 仍撤销相关规则的运行资格；文件重新出现不能自动恢复，观察到的变化不能因随后恢复而被遗忘。

已交付 exact-browser-owner RPC：registerSource/checkSources/previewSourceRefresh/refreshSource/detachSource，所有权检查先于参数解析、文件读取和 manager 查询。更新预览按登记的固定文件、解释器和目标 scope 在 Host 重新读取，只返回新摘要、关闭且未信任的规则及不支持项，不返回源文件正文、不接受更新或修改原状态。预览绑定登记 revision 与运行态登记身份，读取期间发生编辑、刷新、解除后同 ID 重登记均拒绝迟到结果；读取不占配置写入锁。返回的提交请求携带 previewToken，刷新先核对当前登记身份，预览后解除重登记或重载也不能把旧审阅套到新解释器/范围。此 token 不授予权限、不豁免文件校验；刷新仍重新读取并核对原始摘要，预览后文件变化拒绝提交。旧直接刷新调用可省略 token，保留原有 revision/摘要校验；新的更新审阅流程必须原样传回服务器预览请求。刷新必须同时提交当前 revision 与所选固定文件的已审阅原始摘要，重读后整批校验；不能更改目录、文件集合、解释器或目标 scope。项目目标规范根变化也拒绝，不能因 junction 重定向扩大作用域。0.10.1 在来源读取后与逐规则异步校验完成后，无条件再次核对来源根和目标范围，空规则更新也不能跳过；检测失败保留原快照与信任，不提交新接受状态。检查仍不是完全消除文件系统 TOCTOU 的保证。只替换仍可证明归属的旧定义，任何不支持项、ID 碰撞、100 条总量或保存失败均不部分提交；新规则关闭且未信任。相同内容的显式刷新也清除旧信任。迟到检查不能撤销新 revision；刷新读取/保存期间新观察到的失效不会被清除。失效保护比持久快照更严格，操作失败后仍须重新检查和明确刷新，不能根据 current 状态单独推断可执行。

解除关联同样校验 revision，不删除来源文件；保留规则快照，对仍匹配的所属定义停用并清除信任，不覆盖手工编辑或恢复已删除项。最后一份登记移除后，持久状态省略 sourceRegistrations 字段，为退回 0.9.0 旧 schema 提供基础；已提供升级与回退操作说明，并覆盖两份来源的暂停状态 JSON 往返及全部解除后旧外壳校验；这不是 Host 后端备份/恢复保证。仅导出 pluginData 可能不包含该存储域，当前无通用备份文件恢复入口，不能宣称所有旧版本都能读取其他新字段。

Host 会先等待首次 checkSources 成功，再绑定钩子事件和 owner RPC；首次检查或其保存失败则清理并拒绝本次挂载，不允许持久旧规则越过检查启动。随后按每次检查完成后 30 秒再检查的节奏轮询，不重叠、不追补积压，也不自动刷新或执行来源。运行中失败仅记录固定无正文警告，下一周期继续检查；变更的所属规则仍按前述失效策略阻断。定时器 unref，卸载先停止轮询再释放 manager；停止不取消已开始的文件读取，迟到结果不再安排下一周期。轮询存在检查间隔及读取延迟，不能声称文件变化即时撤销运行资格。

已交付的界面支持已登记来源：展示已接受快照/待审/冲突状态、规范目录、文件摘要与目标范围，并提供主动检查和带 revision 的确认解除；current 不表示文件实时未变或可以执行。更新流程先在 Host 重新读取并预览，核对新规则和原始摘要后才明确接受；必须原样传回包含 previewToken 的服务端请求，不支持项禁止提交。空规则是可审阅的合法结果，接受会移除该来源所属快照，不保留过时规则；真实 owner RPC 回归确认仅移除所属定义，保留无关规则、原信任和全局开关，纯预览零写入，源文件字节不变。解除只保留快照、关闭仍匹配归属的定义并清除信任，不覆盖本地编辑、不删除源文件；真实 JSON/TOML 字节（含注释与换行）保持回归已覆盖。

已交付新来源登记入口：复用显式发现的固定文件与同一次联合预览，所有者输入合法且不自动改名的登记 ID，核对规范目录、kind、文件摘要、解释器和独立目标 scope 后明确同意登记。文件选择或任一输入改变、关闭/卸载都会使旧确认失效；同 tick 写入门禁防止登记与普通导入交叉重复提交。零规则来源也可明确登记；不支持项禁止提交，旧快照不能被认领，提交后读取失败提示可能已经提交而非要求盲目重试。

0.10.3 已本地安装；真实页面已验证现有入口、导入发现及空来源登记审阅，默认未同意、提交禁用，未提交登记。随后已用临时空来源实际完成明确登记、接受更新及确认解除，全程执行暂停、零规则，最终清理登记并恢复输入。0.10.3 又完成一条关闭且未信任规则的真实登记、文件变更复查、明确接受空更新移除规则和解除，全程暂停且已清理。非空来源授信/执行及全部冲突恢复路径仍未完整现场验收；后端备份/恢复也未验证。不会自动关联已有快照导入。证据限于受控代码、真实临时文件的 RPC 与 Host 启动失败/清理回归，未操作真实用户配置、授信、命令或审批。发布前仍须完成完整生命周期界面与备份/回退验收；已有原入口和导入发现区域截图，并已有空来源登记后更新预览的现场截图；并非全部提交路径均有截图。下列条目保留完整生命周期约束，并非全部尚未实现。

- 登记由独立的 owner-only RPC 服务端重读来源，绑定规范目录、kind、明确选中的文件名、独立选择的目标 scope、原生解释器与 argvPrefix，以及原始字节摘要。新出现的另一份 JSON/TOML 不自动加入。读取后再次核对规范来源根与项目目标，每条新规则必须保持同一范围，空来源也不能跳过重定向检查；不声称文件系统级原子隔离。并发重复登记仅一次成功，不自动改名，不认领解除后留下的普通快照。
- 同一所有者状态原子保存登记、接受摘要、revision 和所拥有规则的规范定义摘要。storage v1 schema 与 manager 已共同增加可选 sourceRegistrations；旧状态不补空字段，普通更新仍保持缺省与旧定义信任摘要，未使用猜测的迁移回调。注意：一旦新版本持久化登记字段，旧版严格 schema 会拒绝此状态，不能直接降级；[升级与回退说明](upgrade-and-rollback.md)已提供全部解除归属与备份覆盖范围核对步骤，实际后端备份/恢复仍待验收。
- 启动检查和单飞、有界轮询只读已登记来源；无变化不写状态，避免无故使异步队列定义失效。变化、缺失、拒绝读取均停用并清除仍可证明归属的规则信任，保留旧快照与待审状态；根重定向不是普通删除。返回的文件不自动恢复启用。
- 显式接受更新重新检查 revision/摘要；仅原子替换未被手工编辑的所属规则，新规则始终关闭且未信任。任一来源不支持、持久化失败或总规则数超 100 均不部分提交。手工编辑/删除必须解除归属或形成冲突，不能静默覆盖。
- 现有 source 是内容哈希而非路径，ID 又绑定 review/scope 但不含解释器；同字节异路径、同 ID 异解释器均可能碰撞。不得按 source 标签认领旧导入、改变既有公开 ID 或加后缀掩盖冲突；不同登记、无归属规则及本地编辑冲突均须拒绝。

验收前置：旧状态/旧信任原样保持，JSON/TOML 原始哈希变化与删除/重现，选中来源隔离，过期 revision、并发编辑与保存回滚，解释器/内容 ID 冲突，owner 和恶意 getter 边界，以及没有自动授信、启用、执行或扩大项目作用域。上述约束已有受控回归覆盖，逐项证据见[验收记录](verification.md)；受控回归不等于真实页面全部提交路径或 Host 后端恢复已验收。

完整的宿主接口需求、验收条件及插件层工作划分见[宿主契约请求](host-contract-requests.md)；该文档不是现有 API，不得直接照其需求调用。

## 已交付边界：工具前通知与审批观察

公开契约与现有绑定复核表明，PreToolUse 的显式后台通知和 PermissionRequest 的观察分支可以在插件层继续实现，不应归咎于缺少 Host API；PreToolUse 已随 0.18.0 本地安装，审批观察后台及编辑器互斥已随 0.19.0 本地安装，实页默认关闭/双向互斥/取消清理已验证；真实审批执行未测试。必须保留同步默认值与混合规则仲裁，审批后台模式和 denyPermissionRequest:true 严格互斥，不能把异步脚本结果当成审批或工具门禁。工具前后台通知可能晚于实际工具调度，或者因后续同步拒绝而只代表调用尝试，不能声称工具已执行。审批观察也不代表请求已获批准。

所有后台事件与同步钩子共用资源：通知占满活动名额时，同步安全门禁可能因 busy 拒绝，而非降级放行；这是可用性影响，不能声称后台完全不影响前台。新增实际绑定回归确认该边界。受控实际绑定回归已覆盖两种规则顺序、同步拒绝短路、审批实际联合类型结果传递与取消；编辑器实页验证了互斥。这里的“实际结果”指测试中下游返回的契约值，不是操作用户真实审批。后续若扩大白名单仍须逐项保留这些边界。SessionEnd 与 SubagentStop 另有释放后身份问题，不能照搬存活 Agent 检查或用同 ID 新主体代替，仍待精确结束生命周期契约。

## 后续实现应在哪里做

**插件层可推进**：异步队列/取消、更多配置来源策略、元数据与审阅。本期交付 Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest 元数据后台通知子集，完整 async 交付仍不支持；当前 timeout/abort 发出直接子进程 kill 请求后任务可能先于回收返回，直接子进程名额保留至 close，卸载也不等待 drain，不能声称终止已确认，后代可能残留；名额不跨 manager 或插件重载共享。后台 Promise 或释放活动任务名额不等于安全的 Codex async，上下文交付仍需安全时点。

**MCP 路由前置条件**（2026-11-04 公开契约复核）：`tools.get(name, scope?)`、`tools.schemas(scope?)` 与 `tools.execute({callId, rootCallId?, name, schema?, arguments, agent?, parent?, signal})` 可保留现有工具策略链，但公开 ToolSchema 不提供 MCP server、provenance 或连接状态；名字前缀不是来源证明。因此仍不提供 MCP-only handler。再次检查当前 Host 公开 Service/Event 目录，结果未变：唯一 MCP 专属服务 mcpResources.register(server, provider) 只注册 resources/list、resources/templates/list、resources/read，不提供工具来源、连接状态或查找目录；不能把资源 provider 当成工具适配器。Client 目录此次查询超时，未宣称完成 Client 穷尽核验。需要可验证的公开 MCP 目录或可信适配器契约，不能用通用工具执行冒充。未来执行还须保留原始 Agent/exec token 权限链、按异步调用链防递归、绑定审阅目标及参数，并使用完整 registry 通道，不直接调用工具实现、不自动重试或审批。

**上下文追加契约复核（2026-11-04）**：`tools/post-execute` 的 `PostToolDecision` 允许不改写结果的 `accept + additionalContexts?: UserMessage[]`，因此并非完全没有追加入口。但公开投影未给出 `UserMessage` 继承的 `MessageBase`、文本块完整定义，也未规定 result 与 decision 两份 additionalContexts 的合并/替换、顺序及取消保留语义。通用 waterfall 不自动合并返回值；直接返回新的 accept 还可能绕过后续插件的 block 或结果替换。当前继续拒绝未支持的 additionalContext，而不是猜测消息字段或静默丢弃。补全这些契约后，应等待并保留 next() 的真实决策，仅追加有界、已审阅脚本产生的上下文，不修改会话 inbox 或伪造系统消息。

**压缩契约复核（2026-11-04）**：`session/event` 是提交后的 fire-and-forget emit；服务文档确有 `compaction/start` 与 `compaction/end`，但失败尝试也留在日志。公开 `SessionEventMap` 在压缩字段前被截断，不能核验 end 的成功/失败标识，不能把任意 end 当作成功 PostCompact。自动压缩服务的 trigger 参数为 `pressure | context-overflow`，不能据此猜测事件字段。唯一压缩 waterfall `compaction/summary-error` 是失败摘要的同步恢复入口，不是 PreCompact。当前保持两类事件未支持，等待可读的完整事件 schema 和真正前置扩展点。

**Stop 前置契约复核（2026-11-04）**：当前公开 `agent/turn-stopping` 是 serial，签名为 `(payload: {agent: Agent; turn: number; signal: AbortSignal}): Promise<void> | void`。详细说明明确：边界提交前等待监听器，监听器用 `agent.steer(...)` 提供新工作后状态机会重新检查 inbox；没有新工作才关闭。因此不能继续笼统称 Host 没有 Stop 前置时点。但本次 `agentLoop` 与该事件的公开 Agent 投影仍只有 `readonly id: SessionId`，没有 steer 的精确参数/返回值或消息构造契约。`sessionController.prompt(request, signal)` 虽有 `mode:'steer'`，却会按 ID 恢复 Session、按普通 prompt 接纳内容，不是原始 exact Agent 的限定续跑方法；不能用它代替钩子，避免误恢复已释放/替换的主体或伪造用户输入。当前仍保留 idle 通知，不宣称 Stop 门禁已实现。下一步需取得原始 Agent 的完整 steer 契约，确认取消、跨插件组合和有界防递归策略，再实现显式选择的同步续跑子集。

**仍需核实或新增的契约**：压缩前后公开事件、真正提交前输入拦截/改写、上述原始 Agent 续跑操作、向模型安全追加上下文。inbox 已入队、idle 后通知、模型流诊断不能替代前置控制；有事件时点但缺少操作类型，与完全没有事件必须分开记录。

Agent disposed 不等于关闭项目，idle 不保证只发生一次；子任务也可能同时触发 Agent 与 Subagent 生命周期。

## 当前交付与后续边界

已按阶段授权安装并验证：0.4.3 的真实入口、12 类事件分组及禁用规则 CRUD，后续 JSON/TOML 发现与联合预览、审批策略默认关闭等分别记录在[验收记录](verification.md)。新版本的运行语义以其各自回归和现场证据为准，不把早期截图作为全部新能力的验收。这不表示表中尚未实现的能力已完成，也不表示完整 Codex 兼容。

显式登记来源的自动检查、冲突与信任撤销策略已交付，不能再列为整体未实现。空与非空来源的安全登记/更新/解除页面路径已验证；授信/执行、全部冲突恢复和后端备份恢复仍待现场验收；进一步扩展后台事件/调度与安全结果交付仍属未实现项，不能全部归咎于缺少 Host API。MCP 来源证明、上下文消息与合并语义、压缩时点和 Stop 续跑等则须先补全或核实上文列出的公开契约。当前版本不猜接口、不绕过审批，也不自动执行发现的项目配置。
