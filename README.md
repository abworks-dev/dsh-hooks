# 钩子 · DSH Hooks

[![Tests](https://github.com/abworks-dev/dsh-hooks/actions/workflows/test.yml/badge.svg)](https://github.com/abworks-dev/dsh-hooks/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/abworks-dev/dsh-hooks?include_prereleases)](https://github.com/abworks-dev/dsh-hooks/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在 DeepSeek Harness 中，按会话事件管理本地自动化命令。**

插件在「设置 → 钩子」提供事件分组、命令编辑、全局与单项开关、最近执行记录。可以运行自己编写的通知、日志或集成脚本，无需另装 AU05、Ulanzi Studio 或任何硬件。

- **7 类事件**：会话开始/结束、消息入队、工具执行前/后、进入空闲、权限请求。
- **默认不执行**：全局与新规则默认关闭；修改规则后需重新启用。
- **明确的执行边界**：绝对路径 + argv，不隐式经过 shell；超时、输出、并发数量均有限制。
- **真实工具前置拦截**：只有 PreToolUse 可以阻止工具，其余事件仅通知。
- **本地所有者管理**：不向模型提供创建、启用或执行钩子的工具，不自动批准权限。

包名：`@abworks/dsh-hooks` · MIT · Node.js ≥ 22 · 界面目前以中文为主，尚未完整 i18n。

> 0.1.0 是早期版本。借鉴 Codex 的事件命名与分组体验，不是 Codex 插件，也不宣称完整兼容其配置、协议或安全模型。请先在非生产会话试用。

## 安装与使用

### 方式一：安装 Release 包（推荐）

1. 打开 [Releases](https://github.com/abworks-dev/dsh-hooks/releases)，下载 `abworks-dsh-hooks-0.1.0.tgz`。
2. 在 DSH 的插件管理器中，使用本地包路径安装该 TGZ 并启用插件。
3. 进入 **账号菜单 → 设置 → 钩子**。若入口未出现，刷新当前 DSH 页面。

### 方式二：从 GitHub 安装

在 DSH 插件管理器的安装输入中填写：

```text
github:abworks-dev/dsh-hooks#v0.1.0
```

源码直接运行，不需要编译；DSH Host 提供所需的运行时服务与 peer 依赖。本项目目前通过 GitHub 分发，**尚未发布 npm，不能假定仅填写 npm 包名就能安装**。参考验证环境为 Windows / DSH `0.2.1-rc.5`；其他系统和 DSH 版本尚未现场验证。

### 第一次配置

1. 保持全局执行关闭，选择事件并「添加」。
2. 填写可信可执行文件的**绝对路径**、JSON 字符串数组参数、简单 glob 匹配、超时和输出上限。
3. 保存后审阅脚本内容，显式启用该钩子，再打开全局执行开关。
4. 在真实会话触发事件后刷新，查看最近执行记录。保存、刷新均不会试跑命令。

修改规则后需重新启用。配置保存在插件自己的 storage domain；记录仅存内存，最多 100 条，重启丢失。关闭设置页不会停止规则；关闭全局执行可停止后续触发，已启动命令有自己的超时。卸载/禁用插件会取消运行中的子进程。管理接口只允许 Host 所连接的本地所有者浏览器，拒绝远端调用。

## 事件及真实语义

| 事件 | DSH 来源 | 本版语义 |
| --- | --- | --- |
| SessionStart | agent/created | Agent 就绪通知，不是 Codex 的 startup/resume 等细分来源 |
| SessionEnd | agent/disposed | Agent 释放通知，不等于删除持久会话 |
| UserPromptSubmit | agent/inbox/inserted | 消息入队后的通知，不能否决提交 |
| PreToolUse | tools/pre-execute | 真正执行前等待命令；退出码 2 或运行异常拒绝此工具 |
| PostToolUse | tools/result | 最终工具结果之后通知；不能回滚或替换结果 |
| Stop | agent/status idle | 进入 idle 通知；不能阻止结束、续跑或保证一次会话只通知一次 |
| PermissionRequest | approval/request | 仅观察请求，正常审批流程不变；不允许脚本批准权限 |

只有 `PreToolUse` 是阻断事件。正常完成但退出非 2 的命令不阻断；超时、繁忙、输出超限、启动失败等执行异常在该事件上拒绝工具。本版这个 fail-closed 策略不同于 Codex，避免无声绕过用户规则。钩子只覆盖通过 DSH 公开工具执行通道的调用，**不是完整安全沙箱或所有插件副作用的安全边界**。

## 命令协议

直接启动原生可执行文件与 argv，`shell: false`；Windows 不接受 `.cmd`/`.bat`，需要明确指定解释器。工具匹配支持 `*`、`?`，区分大小写；**不是 Codex 正则**。非工具事件使用 `*`。

stdin 是一个 JSON 对象：

```json
{"hook_event_name":"PreToolUse","session_id":"agent-id","tool_name":"ops_bash","timestamp":0,"source":"dsh","payload_version":1}
```

为降低隐私风险，当前**不传提示正文、工具参数、结果正文、transcript 或凭据**。因此脚本不能按具体命令内容执行 Codex 式策略检查。stdout/stderr 仅供记录查看，不解析控制 JSON，不注入模型上下文。唯一控制信号是 `PreToolUse` 的退出码 2。

超时 100–30000 ms；输出合计上限 256–65536 字节；全局最多同时运行 4 个命令，规则顺序执行。清空子进程环境，不继承 Host 环境凭据；解释器与子程序应使用绝对路径。cwd 并未切换为会话项目目录，勿依赖相对路径。进程取消针对直接子进程，不承诺杀死脚本自行创建的整棵进程树。

示例：可执行文件填写本机 Node 的绝对路径，参数填写 `["/absolute/path/hook.mjs"]`。脚本应自行限制文件、网络及日志行为。

```js
// hook.mjs：只演示协议，不是安全策略模板
let text = '';
for await (const chunk of process.stdin) text += chunk;
const event = JSON.parse(text);
console.log(`${event.hook_event_name}: ${event.tool_name}`);
```

## 与 Codex 对齐的范围

调研基准：2026-11-03 的 [Codex 官方 Hooks 文档](https://developers.openai.com/codex/hooks)。官方发布文档优先于 main 分支 schema。

- Codex 正式文档列出 14 个事件；本版实现上表 7 个映射，且通知/阻断语义按 DSH 明确标注。
- 其余 7 个：PreCompact、PostCompact、SubagentStart、SubagentStop、Interrupt、PreModelRequest、PostModelRequest，**本版未实现**。
- Codex 支持 command 与 mcp_tool；prompt/agent 目前仅解析跳过。本版只支持 command。
- 本版未实现 hooks.json/TOML 导入、用户/项目/managed 多来源合并、正则 matcher、异步 handler、JSON 决策/输入重写、上下文注入、MCP handler 或 Stop 续跑。
- Codex 有精确定义信任审阅、脚本更新重审、managed 管理策略；本版是保存后禁用、手动审阅再启用，**不具备脚本哈希信任管理**。脚本文件在外部发生变化不会自动被检测，使用者需自行审阅。
- UI 借鉴 Settings > Hooks 的分组与开关，并增加自有命令编辑器和执行记录；不把截图当成完整 Codex CRUD 能力证明。

详见官方的 [配置与来源](https://developers.openai.com/codex/hooks#where-codex-looks-for-hooks)、[事件匹配](https://developers.openai.com/codex/hooks#matcher-patterns)、[PreToolUse](https://developers.openai.com/codex/hooks#pretooluse)、[信任审阅](https://developers.openai.com/codex/hooks#review-and-trust-hooks)。

## 安全与权限

钩子以 Host 用户身份启动，可读取本机文件、发起网络访问及产生副作用，不受模型工具权限自动约束。空环境不是沙箱；不要运行不可信脚本，也不要把密钥写入参数或输出。有限记录仍可能包含脚本打印的敏感信息。此插件不注册模型工具，不让模型配置、启用或试跑钩子，不自动回答任何审批。

## 从 Studio 插件迁移

`@abworks/dsh-studio-hook` 是 AU05 / Studio 状态与输入桥，历史包保持原名和行为。本包是独立产品，不读取或迁移硬件绑定、配对密钥和旧运行配置。需要硬件的用户继续安装旧包；只需本地自动化的用户安装本包即可。两者可共存，但避免脚本重复转发同一通知。

## 开发与测试

```sh
git clone https://github.com/abworks-dev/dsh-hooks.git
cd dsh-hooks
npm test
npm run check
mkdir -p dist
npm run pack:release
```

测试使用 Node 内置 runner，不需启动 DSH；覆盖规则校验、持久化回滚、默认禁用、命令 stdin/输出/超时/取消、前置拦截、RPC 所有者限制和设置页调用契约。Host 激活与真实界面仍需要在 DSH 中验证，不能用离线测试替代。

- 独立插件：11 项自动测试通过。
- 本机真实 GUI：创建/保存/启用/删除规则通过；SessionStart 实际执行无副作用的 `node --version`，退出码 0。
- 原开发仓库参考回归：659 通过、0 失败、1 跳过；这不是本独立仓库的测试数量。
- 已知验证边界见 [验收记录](docs/verification.md)；报告安全问题前请阅读 [安全说明](SECURITY.md)。

发布包仅包含 manifest、Cordis patch、Host/Client 源码、README、许可证、图标和展示资源，不包含本地配置、配对密钥、日志或依赖捆绑。GitHub Actions 只运行测试与语法检查，不自动发布到 npm 或插件市场。

## 反馈

请在 [Issues](https://github.com/abworks-dev/dsh-hooks/issues) 中提供 DSH/系统版本、事件类型、经过脱敏的规则配置与执行状态。**不要公开令牌、凭据、个人会话正文或敏感脚本输出。**
