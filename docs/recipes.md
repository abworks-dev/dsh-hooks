# 可运行的钩子示例

这些脚本由本项目编写，借鉴 [Codex 官方能力](codex-alignment.md)，不是 OpenAI 官方脚本。全部通过 stdin 接收 DSH JSON；不能把 Codex notify 的单个 JSON argv 直接照搬。脚本随源码/安装包的 examples 目录分发，请复制到你自己可审阅、稳定的绝对路径。

共同步骤：打开「设置 → 钩子 → 用户配置」，添加对应事件，可执行文件填本机 Node 的**绝对路径**，argv 填以下数组（替换路径）。把示例脚本及其依赖文件的绝对路径加入「信任文件」JSON 数组；argv 中的脚本不会自动纳入审阅。保存后展开条目，点击「审阅文件」，核对规则与文件 SHA-256，再确认信任并单独启用规则和全局开关。脚本变更后需要重新审阅；确认信任不执行命令。默认不共享工具参数；事件由真实会话触发，配置不会试跑。请先在独立测试会话使用。

## 1. 本地元数据审计

事件可选 SessionStart、Stop 或 SubagentStop；matcher `*`；共享参数关闭。

```json
["/absolute/hooks/examples/audit.mjs", "/absolute/logs/dsh-events.jsonl"]
```

Windows 示例：

```json
["C:\\Hooks\\examples\\audit.mjs", "C:\\Hooks\\logs\\dsh-events.jsonl"]
```

预先创建日志目录。audit.mjs 只按字段白名单追加事件、会话/子任务标识、工具名、provider、结束原因、时间；即使误传 tool_input 也不会保存。它会真实写文件，不自动轮转；你负责保留期限、访问权限和磁盘容量。POSIX 首次创建请求 mode 0600，不据此承诺 Windows ACL 或已有文件权限。

## 2. 工具执行前命令策略

事件 **PreToolUse**；matcher 填你实际使用的工具名，例如 `ops_bash`（内置工具可能叫 `bash`，以实际记录为准）；明确勾选**向此脚本发送工具参数**。

```json
["/absolute/hooks/examples/command-policy.mjs"]
```

脚本读取 `tool_input.command`，演示拒绝 `rm -rf` / `rm -fr`、`git push --force` / `-f`、特定顺序的 PowerShell `Remove-Item -Recurse -Force`，返回 Codex 风格 deny JSON 和理由。缺少 command 时也拒绝，避免忘记开启共享后默默放行。

**只是协议示例，不是可靠的破坏性命令检测器**：正则不能理解 shell 语法，不能覆盖编码、间接脚本、别名、选项变体、其他工具或混淆；必须结合 DSH 原有沙箱、审批与独立审查。它返回 allow 也仍经过其他规则和常规审批。脚本不修改命令、不自动授权。

参数可能含密钥/文件正文。该规则的 stdout/stderr 在记录里隐藏，但它返回的拒绝理由会反馈给工具调用者，**请勿把原始命令或秘密拼进理由**。脚本自身写盘或联网不受此隐藏保护。

## 3. 完成提醒

事件 **Stop** 或 **SubagentStop**，matcher `*`；共享参数关闭；建议 timeout 5000 ms。Stop 表示进入 idle，不保证每条用户消息恰好一次。

macOS（系统 osascript）：

```json
["/absolute/hooks/examples/notify.mjs", "mac", "/usr/bin/osascript"]
```

Linux（需你自己安装 notify-send，有可访问的桌面通知服务）：

```json
["/absolute/hooks/examples/notify.mjs", "linux", "/usr/bin/notify-send"]
```

Windows（示例仅播放系统提示音，不承诺 Toast 弹窗）：

```json
["C:\\Hooks\\examples\\notify.mjs", "windows-sound", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]
```

程序只发固定的“Agent idle / subagent finished”消息，不发提示/回复。子程序依旧空环境，桌面 Linux 的 DBus、Windows 服务会话或静音设置可能使提醒不可用；失败会记录 notifier_failed。可自行修改本地脚本，为特定 OS 配置明确的通知服务，而不是继承整份 Host 环境凭据。**自动测试只验证参数构造，不代表三平台原生提醒都已现场通过。**

## 4. 模型用量记录

事件 **PostModelRequest**；matcher `*`，载荷选“仅元数据”，不共享参数。可开启后台通知。Node argv：

```json
["/absolute/hooks/examples/model-usage.mjs", "/absolute/logs/dsh-model-usage.jsonl"]
```

脚本和 `event.mjs` 都加入信任文件。预先创建日志目录。只记录白名单状态及 Host 提供的 token 数，不记录提示词、回复或错误正文；无用量时不推算、不冒充计费用量。计数字段采用 DSH 命名，不是 Codex wire schema；日志不自动轮转，须自行限制访问及保留期限。

## 5. 回复结束后检查项目

事件 **Stop**；matcher `*`，仅元数据。Node argv：

```json
["/absolute/hooks/examples/project-check.mjs", "/absolute/project", "/absolute/logs/checks.jsonl", "/absolute/node", "/absolute/project/scripts/check.mjs"]
```

后三部分依次是固定项目目录、日志路径、原生可执行文件及它的参数；不使用事件里的目录或命令，不经 shell。把 `project-check.mjs`、`event.mjs`、实际检查脚本及需要固定审阅的依赖加入信任文件。检查脚本必须自行审阅，建议只读、无网络、无子进程；Node 路径同样必须替换成本机绝对路径。Windows 不要直接填写 `npm.cmd`；可指定 Node 和已审阅的检查脚本。

钩子超时设为 **15000 ms**，脚本内部约 10 秒后向直接检查子进程请求终止；不保证终止其后代。只追加退出码与 passed，不保留检查输出；检查退出非零记录 passed:false，不要求 Agent 继续。后台模式会占共享执行容量；同步模式同样不是结束门禁。可能多次触发，应使用可重复执行的检查。运行脚本有真实文件/网络副作用的可能，元数据模式不是沙箱。

## 还不能直接照搬的官方场景

- Codex MCP scanner.scan_patch：本版没有 MCP handler。不要把配置里的 type=mcp_tool 填进本插件。
- SessionStart 的 additionalContext：本版不注入上下文。
- Stop“测试未过则继续修复”：本版不能续跑。你可以在自己指定的项目路径运行检查并记录结果，但不能把它称作阻止 Agent 结束的质量门禁。

## 自己验证例子

```sh
npm test
```

测试会使用临时目录写入审计 fixture，并通过固定 Node 子进程验证真实 policy stdin→JSON deny→manager gate；用量示例验证实际 stdin、JSONL 写入、空用量、异常输入及隐私白名单；项目检查示例真实运行固定 Node fixture，验证指定目录、成功/失败退出码和错误事件拒绝。不执行删除命令、不推送 Git、不调用 OS 通知、不向网络发数据。

本次完整回归 **446/446 通过，0 跳过**。这里“验证”指上述自动化与无害真实子进程，不代表你的项目检查已通过，也不代表三平台通知或真实会话中已启用这些示例。
