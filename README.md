# 钩子 · DSH Hooks

[![Tests](https://github.com/abworks-dev/dsh-hooks/actions/workflows/test.yml/badge.svg)](https://github.com/abworks-dev/dsh-hooks/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/abworks-dev/dsh-hooks?include_prereleases)](https://github.com/abworks-dev/dsh-hooks/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**把 Codex 风格的生命周期自动化带到 DeepSeek Harness：通知、审计、工具执行前检查，在「设置 → 钩子」统一管理。**

Codex-inspired lifecycle hooks for DeepSeek Harness — local command automation and explicit pre-tool policies, **not a Codex hooks compatibility layer**.

无需硬件、Studio 或额外常驻服务。钩子在确定的生命周期事件上运行你审阅过的程序，不依赖模型“记得执行”；以 Host 用户身份运行，**不是沙箱或完整安全防线**。

## 你可以用它做什么

| 场景 | 配置事件 | 当前可兑现的效果 |
| --- | --- | --- |
| 回合完成提醒 | Stop | Agent 进入空闲后调用本机通知程序；不包含提示或回复正文 |
| 子任务完成审计 | SubagentStop | 将子任务标识、provider、结束原因写入本地 JSONL；不读取子任务回复 |
| 命令执行前审阅 | PreToolUse | 逐条明确共享工具参数后，脚本按实际命令返回 deny；拒绝理由反馈给工具调用方 |
| 自定义工具后处理 | PostToolUse | 默认只收元数据；可阻断并替换工具反馈，不回滚副作用 |

项目附带 [三个可运行示例与配置步骤](docs/recipes.md)，以及 [Codex 官方案例与能力对照](docs/codex-alignment.md)。其中脚本是本项目实现，**不冒称 OpenAI 官方脚本**。

### 0.16 新增

PreToolUse 也可显式选择后台通知，但不是安全门禁：工具可能先于通知执行，后台输出与退出码不作拒绝决定。默认同步路径保持等待与拒绝；通知与同步钩子共享资源，繁忙时同步门禁仍拒绝，不降级放行。

PostToolUse 可显式选择 metadata-only 后台通知，默认关闭；不读取工具输入或结果，不反馈或改写结果，保留下游插件原决策。未选择后台时原有同步反馈路径不变。

本地 SubagentStart 可显式选择 metadata-only 后台通知，默认关闭；绑定原始子 Agent/Session，释放或替换后取消，不读取提示或回复。外部提供方和 SubagentStop 不支持后台；不以 provider 冒充公开契约缺少的 agent_type。

### 0.15 新增

PostModelRequest 增加 `token_usage`：仅复制公开用量计数，没有有效值为 null；不读取正文、不改变原状态或模型流。六个 camelCase 计数字段属于 DSH 本地结构，不宣称与 Codex wire 格式相同。每次可见调用保留最后有效快照，不累加、不作为完整计费账本。

### 0.14 新增

- PreModelRequest/PostModelRequest 可显式选择「后台通知」，不读取正文、不修改模型请求或交付上下文。
- 保留原模型流、异常与提前关闭；原 Agent/Session 被替换后取消待处理通知。请求 abort 取消 Pre，Post 可独立报告已结束的 aborted 状态，不恢复任务。
- 模型事件不是压缩事件；session-title/compaction 调用不触发这些通知。

### 0.13 新增

- Interrupt 可显式选择仅元数据后台通知，仅在用户中断记录提交后触发，不阻止中断或重启任务。
- 后台 Interrupt 默认 1000 ms、最多 3000 ms，超限拒绝；旧非后台规则保持原超时和信任摘要，不自动转换。
- 选择后台模式时编辑器将超限旧值改为 1000 ms；保存仍关闭且未信任，需重新审阅并单独启用。

### 0.11 新增

- SessionStart 可显式选择「后台通知」；按真实创建事件来源匹配，不等待初始化、不注入上下文、不控制模型续跑，也不补发挂载前的历史事件。
- UserPromptSubmit 可显式选择「后台通知」；仅在消息入队后发送元数据，不读取正文、不阻止提交、不注入上下文。
- 与 Stop 共享现有队列、文件信任和取消边界；工具与审批事件仍不接受 async:true，不能用后台输出控制审批。

### 0.10 新增

- 明确登记所选 Codex JSON/TOML 固定文件；独立选择解释器和目标范围，新规则关闭且未信任，普通导入不会自动关联。
- 启动及周期检查发现变化时停用所属规则；更新先预览再明确接受，不支持项或冲突不部分替换。检查不是实时防线，不自动恢复启用。
- 可解除关联并保留快照。回退 0.9.0 前须解除全部登记；[备份范围与回退限制](docs/upgrade-and-rollback.md)不能省略。

### 0.9 新增

- Stop 规则可显式选择「后台通知」；仅发送元数据，不阻断结束、不续跑、不追加模型上下文。
- 每个插件实例最多 4 个后台活动任务、32 个待处理项；满额记录 busy，不自动重试。这不是 Codex 每会话 8 并发或完整后台交付。
- 绑定原始 Agent/Session；执行前重检规则、作用域与文件信任。Agent 释放时取消该主体的等待任务并请求取消运行任务，比持久会话关闭更保守；不保证 OS 进程树已经终止。
- Codex 导入接受 Stop、UserPromptSubmit、SessionStart、Interrupt、PreModelRequest、PostModelRequest、SubagentStart、PostToolUse、PreToolUse 的 command async:true（SubagentStart 仅执行本地子智能体通知），仍关闭、未信任，解释器须显式指定。其他事件的 async:true 继续拒绝，不静默改为同步。

### 0.8 新增

- PermissionRequest 默认仍只观察；单条规则显式勾选「允许此钩子拒绝审批」后，可拒绝审批。保存会关闭规则、清除信任，需重新审阅并单独启用。
- 只实现拒绝或继续原审批链，不允许脚本自动批准权限。启用拒绝策略后，执行、校验或协议失败会拒绝该请求。
- 0.8.1 的运行记录区分本条钩子的拒绝、未拒绝与取消；「未拒绝」不等于最终审批通过。

### 已有能力

- **显式用户/项目作用域**：默认用户规则；项目规则仅在事件所属 Session 的 Host 有效工作目录与规范化项目根精确相等时执行，用户规则先于匹配项目规则。
- **12 类事件**：包含 PreModelRequest / PostModelRequest 和明确用户取消后的 Interrupt 诊断；不是全部 14 类，也不是启动前/结束前控制点。
- **匹配与审阅**：保留 glob，增加隔离 worker 预算内的 regex；二阶段信任绑定规则、可执行文件及显式 `trustFiles`，启用和每次执行前重检。
- **工具反馈控制**：PreToolUse 拒绝子集保留，PostToolUse 可阻断并替换反馈，不能回滚副作用；`allow` 不跳过 DSH 审批。
- **显式数据共享**：保留仅工具输入的 `includeToolInput`；另增 `payloadMode: "full"`，在适用事件共享工具输入/结果。两者均默认关闭并隐藏运行记录 stdout/stderr；不发送提示、模型正文或 transcript，拒绝理由仍可能泄密。
- **受限 Codex JSON 导入**：显式指定解释器，先预览；不执行、不自动信任、不自动启用，不支持的处理器拒绝导入。

各版本的安装、自动化测试与真实页面验收分别记录在[验收记录](docs/verification.md)；不把局部协议支持称为完整 Codex 兼容。登记来源功能有独立的[升级与回退说明](docs/upgrade-and-rollback.md)：仅导出插件目录不代表备份了规则状态，回退旧版前须解除全部登记。

全局与新规则默认关闭，修改规则后需重新启用。管理接口只接受本地所有者浏览器，不向模型提供创建、启用或试跑钩子的工具。界面以中文为主，尚未完整 i18n。

## 安装

从 [Releases](https://github.com/abworks-dev/dsh-hooks/releases) 下载 `abworks-dsh-hooks-0.19.1.tgz`，在 DSH 插件管理器按本地路径安装并启用；也可填写：

```text
github:abworks-dev/dsh-hooks#v0.19.1
```

然后打开 **账号菜单 → 设置 → 钩子**。若未出现入口，刷新现有 DSH 页面。源码无需编译；尚未发布 npm，不能假定仅填写 npm 包名就能安装。参考现场环境 Windows / DSH `0.2.1-rc.5`；Node.js ≥ 22。

1. 保持全局关闭，在事件分组里点击「添加」。
2. 填可信可执行文件的**绝对路径**、argv JSON 字符串数组、匹配、超时和输出上限。
3. 需要命令内容检查时，在该条工具规则中明确勾选「向此脚本发送工具参数」。参数可能含密钥或文件内容，先审阅脚本。
4. 将脚本及依赖配置的绝对路径加入 `trustFiles`，保存后规则关闭、旧信任清除。点击「审阅文件」，检查规则与文件摘要后确认信任，再启用单项及全局开关。信任不会启用或执行命令；保存、预览、导入均不会试跑。旧配置中已启用但未信任的规则迁移后关闭；缺少显式 scope 的旧规则迁移到 user 时也清除信任并关闭，需重新审阅。
5. 需要工具结果时才逐条选择 `payloadMode: "full"`；默认仍为 metadata，不发送提示、模型正文或 transcript。在真实测试会话触发事件后刷新记录。

安装地址指本批目标版本；标签与产物是否已公开，以 Releases 实际条目为准，不能把本地打包或安装当作市场发布。

规则仍由当前 Host 同一所有者 storage 管理；仅显式登记后检查所选固定文件，不扫描环境或祖先仓库。关闭设置页不停止规则；全局关闭只停止后续触发。超时、取消或卸载向直接子进程请求 kill，但任务可能在进程回收前返回；卸载不等待全部任务 drain，不能据此确认 OS 进程已终止，后代进程可能残留。不要将脚本守护进程化。

### 用户与项目作用域

规则 `scope` 是显式联合：默认 `{ "kind": "user" }`，或 `{ "kind": "project", "root": "规范化的现有绝对目录" }`。保存时先异步核验并规范化目录，再原子持久化。ID 在全部作用域中唯一；作用域绑定信任，修改后关闭规则并需重新审阅。

项目匹配使用**事件原始主体 Session** 的 Host 有效工作目录，不是页面头部初始 cwd，也不是 GUI 当前选择、进程 cwd 或隐式 cd。仅与 root 精确相等才匹配，不包括子目录；有效目录在等待异步工作前取一次；拿不到主体/有效目录，或项目根缺失、重定向时跳过项目规则，不回退到其他目录。运行记录区分 `scope_unavailable`（会话目录不可用）和 `scope_invalid`（项目目录失效），不记录目录路径；正常目录不匹配保持静默。跳过不拒绝工具执行，也不表示脚本运行过。先运行用户规则，再运行匹配项目规则。root 只决定事件是否适用，**不改变命令子进程 cwd，不是沙箱**。

作用域不会自动读取项目配置。手动「发现配置」仅在所有者输入 Host 目录并点击后，检查固定 JSON/TOML 候选；JSON 可载入预览，TOML 只提取 hooks 后载入相同的 JSON 预览。没有 managed/session/plugin 来源发现。导入仍由所有者在 `options.scope` 显式选择目标作用域；源 JSON 不能自行赋权。

## 事件与语义

| 事件 | DSH 来源 | 语义 |
| --- | --- | --- |
| SessionStart | agent/created | Agent 创建初始化时通知，不等待初始化完成；保留 Host 的 startup/resume/clear/compact 来源 |
| SessionEnd | agent/disposed | Agent 释放通知；不是删除持久会话 |
| UserPromptSubmit | agent/inbox/inserted | 入队后通知，不能否决提交 |
| PreToolUse | tools/pre-execute | 默认同步等待并可拒绝；显式后台只通知，不作门禁 |
| PostToolUse | tools/post-execute | 工具本体执行后可阻断并替换反馈；不回滚副作用 |
| Stop | agent/status idle | 进入 idle 通知；不阻止结束、不续跑 |
| PermissionRequest | approval/request | 默认只观察；显式启用拒绝策略后等待拒绝决定，绝不自动批准 |
| SubagentStart | subagent/start | 子智能体已发布通知 |
| SubagentStop | subagent/end | 子智能体结束通知；不阻止结束、不续跑 |
| PreModelRequest | llm/stream | Agent 模型请求开始迭代前诊断，不修改请求 |
| PostModelRequest | llm/stream | 模型流完成、错误、取消或提前关闭后诊断 |
| Interrupt | session/event turn/end | 仅明确的 user 原因取消后通知，不重启或阻止中断 |

PreToolUse 可阻断执行；PostToolUse 只替换已执行工具的反馈。繁忙、超时、输出超限、启动失败、非法共享输入或非法结构化控制输出在 PreToolUse 上拒绝工具。此 fail-closed 策略**不同于 Codex 的部分失败语义**。子代理与模型事件只有诊断语义；模型事件不提供请求/回复正文。只有经过 DSH 公开工具执行通道的调用受覆盖，不能拦截所有插件副作用。

## 命令与输出协议

绝对路径 + argv，`shell: false`；Windows 不接受 `.cmd` / `.bat`，需明确填写解释器。matcher 默认是大小写敏感整串 `*` / `?` glob，也支持 Codex 风格 regex（JavaScript 正则语法，不等同 Codex 引擎）。原生及 Codex 导入的 matcher 均最多 512 个字符；这一本地限制不代表 Codex 官方上限。regex 在独立 worker 执行，启动预算 2 秒、匹配预算 100 ms，超时终止，不允许不受限回溯占用 Host 主线程。工具事件匹配工具名；会话、子代理事件使用其可用元数据，缺失字段为空；UserPromptSubmit、Stop、模型事件忽略 matcher。

默认 stdin 是单个 JSON：

```json
{"hook_event_name":"PreToolUse","session_id":"agent-id","tool_name":"ops_bash","timestamp":0,"source":"dsh","payload_version":1}
```

工具规则显式开启共享后另有 `tool_input` JSON 对象（最多 65536 UTF-8 字节、深度 64）。子智能体事件另有 `child_id`、`provider`、`run_id`、`local`，结束时有 `stop_reason`；`session_id` 对应该子任务，未提供父会话 ID。payload_version 保持 1，新增字段均为可选。

PreToolUse 在退出码 0 时可输出：

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"此操作需要手动审阅。"}}
```

`allow` 表示继续其他规则与正常工具/权限流程，不自动批准权限。另支持顶层 `decision: "block"` / `reason`；PostToolUse 支持此形状或 `continue: false` / `stopReason`，以及退出码 2 的阻断反馈。未知控制字段、错误事件名或非法 JSON 在 PreToolUse 上 fail-closed。普通文本只作诊断。**不支持 `additionalContext`、`updatedInput`、ask、输入改写或任意结果改写**，不把 Stop 的 exit 2 当成续跑。

### PermissionRequest 的拒绝策略

默认或导入的 PermissionRequest 规则是观察通知，不等待它决定审批。只有该条规则显式保存 `denyPermissionRequest: true`、重新审阅并启用后，才等待策略结果：

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"不符合本地审批策略。"}}}
```

`behavior: "allow"` 仅委托 DSH 原审批链，**不会自动批准**；空成功结果也继续正常审批。仅采用公开审批事件中的会话/工具元数据，不读取或发送审批理由、显示文案或工具参数，即使选择 full 也是如此。`message` 仅作有限诊断，Host 审批结果联合类型不能传递此文案。

显式拒绝策略使用本地 fail-closed：非零退出码、超时、繁忙、指纹失效、非法 JSON 或未知控制字段均拒绝；取消优先返回 cancelled。不把退出码 2 冒称为 Codex PermissionRequest 的拒绝协议。`continue`、`stopReason`、顶层 `decision`、`updatedInput`、`updatedPermissions`、`interrupt` 与自动批准均不支持。async 仍不支持；观察规则不能借输出获得拒绝能力。项目目录不匹配或上下文不可用仍按作用域规则跳过，不产生拒绝。

`includeToolInput` 兼容选项仍只适用于 PreToolUse / PostToolUse，且只共享工具输入。`payloadMode: "full"` 是独立显式 opt-in，在适用工具事件共享输入及结果，仍不发送提示、模型正文或 transcript。两种共享模式均隐藏运行记录中的 stdout/stderr；结构化理由仍进入反馈与记录，不能视为数据脱敏。

超时 100–600000 ms（手工规则省略时仍为 5000 ms，界面新增默认值不变），stdout/stderr 合计限 256–65536 字节，每个 manager 最多 4 个活动任务及 4 个尚未收到 close 的直接子进程句柄；超时/取消不提前释放子进程名额，未退出的子进程会阻止新启动（忙时不排队）。此限制不跨插件重载或 manager 实例，不统计后代进程，规则按顺序执行；timeout/abort 在 kill 请求后可能先于进程回收返回。子进程环境清空，不继承 Host 凭据/PATH；不切换到会话项目 cwd，需明确使用绝对路径。记录仅内存最近 100 条；参数共享规则的 stdout/stderr 留空，但拒绝理由会进入记录及工具反馈。启用及每次执行前重新校验信任摘要，规则或所列文件变更后拒绝执行，需重新审阅。

### 手动发现配置文件

在「导入 Codex 配置」中选择来源类型、填写 **Host 上**的绝对目录，再点击「发现配置」。用户目录指实际 `CODEX_HOME` 目录本身，不是父级 home；项目目录指项目根。

- 用户：仅检查所选目录中的 `hooks.json`、`config.toml`。
- 项目：仅检查所选根下 `.codex/hooks.json`、`.codex/config.toml`。
- JSON/TOML 文件最多 256 KiB，要求有效 UTF-8；文件链接、候选子目录 junction、路径变化、非普通文件或读取失败不载入。TOML 在独立 worker 中解析，最多 2 秒，限制堆、深度及节点数；只返回 `{hooks}` JSON，不返回模型、凭据等其他配置。缺少 hooks、日期/非有限数字等非 JSON 值或危险键拒绝载入。来源哈希对应原始文件字节，载入内容则为提取的 hooks 快照。
- 点击「载入 JSON」才替换文本；仍需指定解释器并预览，再显式导入关闭且未信任的规则。内容哈希保留为来源标签；手动编辑 JSON 会清除该标签。来源目录与导入适用范围分别选择，不自动互相赋权。
- 同一发现快照可点击「预览全部来源」，累加当前可载入 JSON/TOML 的处理器；缺失文件允许，但现有文件被拒绝时不能跳过它导入另一份。检查联合预览后再点击「导入全部来源」。最多两份、合计 100 个处理器；任一不支持项、重复 ID、已有 ID 冲突或保存失败均整批拒绝，不留下部分规则。导入仍全部关闭、未信任，不自动同步。

这是快照复制，不是 Codex 活跃配置解析器或持续同步：不扫描祖先、profile、managed/plugin/session 来源，不读取环境变量来猜用户目录，也不继承 Codex 信任。文件后续变化不会自动更新已导入规则。发现会把所选文件内容读入所有者页面；不要选择含不应展示数据的目录。普通 UNC 路径仍指 Host 文件系统位置，可能涉及网络访问；路径核验降低竞态风险，不构成原子文件系统沙箱。

### 文件信任与 Codex JSON 导入

信任是先预览、再确认同一摘要的二阶段操作，绑定规则定义、可执行文件和显式 `trustFiles`。不从 argv 自动发现脚本或依赖；解释器后面的脚本与配置需自行加入。保存修改清除信任并关闭规则。指纹检查不是沙箱，不消除检查到执行之间的 TOCTOU，不保护未列依赖、动态加载或远端资源，也不保证识别所有 Windows reparse 类型。

Codex JSON 支持 `hooks → 事件数组 → { matcher, hooks: 处理器数组 }` 的 command 子集。必须显式指定解释器绝对路径和前置参数；原始 command 作为单个参数追加，不自动拆分或猜测 shell。预览不执行；导入规则保持关闭、未信任，保留原始定义及 JSON pointer。未知事件/字段、不支持 handler、不在 Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest 白名单中的 async:true 等拒绝导入，不静默忽略。另可手动发现固定位置的 JSON 或 TOML 文件后载入同一预览流程；TOML 仅提取 hooks，不合并其他配置或自动判定活跃层。不支持后台自动发现；显式登记的固定来源会后台检查，变化时撤销相关规则信任，接受新内容仍须手工预览确认，不自动同步执行。

Codex timeout 从秒转换为毫秒：普通事件省略时默认 **600 秒**，接受 1–600 秒；SessionEnd 和 Interrupt 导入默认 1 秒、最多 3 秒。超过导入上限直接拒绝，不静默缩短。这些事件特有的 3 秒限制是 Codex 导入规则，不限制已有手工规则。指定解释器不等于禁用其 shell 语义；导入不是安全审查的替代品。

## 与 Codex 对齐，但不假装兼容

以 [Codex 官方 Hooks 文档](https://developers.openai.com/codex/hooks)的发布行为为准，非 GitHub main schema。Codex 有 14 事件、command/mcp_tool、多来源合并和信任审阅；本版实现 12 个 **DSH 映射**、同步 command 与 Stop/UserPromptSubmit/SessionStart/Interrupt/PreModelRequest/PostModelRequest/SubagentStart/PostToolUse/PreToolUse/PermissionRequest 后台通知子集、隔离 regex、显式工具数据共享、文件指纹信任、受限 JSON 导入与 pre/post 控制子集，不是全部 14 事件。

**未支持**：PreCompact / PostCompact、自动配置来源发现、managed/session/plugin 来源及其策略、MCP handler、完整 async 调度及结果交付、updatedInput/输入重写、additionalContext/上下文注入、Stop 续跑。Codex 的 prompt/agent handler 当前仅解析跳过，也不列作本项目已支持能力。详见 [逐项能力和官方案例出处](docs/codex-alignment.md)及[宿主契约需求与验收条件](docs/host-contract-requests.md)。

## 开发、验证与安全

```sh
git clone https://github.com/abworks-dev/dsh-hooks.git
cd dsh-hooks
npm test
npm run check
npm run pack:release
```

Node 内置 runner，测试不需要启动 DSH 或运行用户脚本。覆盖协议、输入隐私、JSON 拒绝、生命周期、持久化、取消、RPC 权限、UI 合同和固定子进程示例；多平台 CI 不代表多平台真实 GUI 已验收。真实安装/界面证据与版本边界见 [验收记录](docs/verification.md)。

阅读 [安全说明](SECURITY.md)。脚本是 Host 用户权限的任意程序，空环境不是沙箱。仅启用可信代码，不在参数、拒绝理由、输出或公开 Issue 中放凭据。示例命令检测只是演示，不能覆盖 shell 混淆、间接脚本或所有工具。

原 `@abworks/dsh-studio-hook` 是独立硬件桥；本项目不读取或迁移其绑定、密钥。没有异常安装脚本、不打包用户数据、不自动发布 npm/市场。问题请提交 [Issues](https://github.com/abworks-dev/dsh-hooks/issues)，附经过脱敏的环境、规则与状态。
