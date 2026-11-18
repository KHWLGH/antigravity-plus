# Antigravity+（Paseo 插件）

[English](./README.md) | 简体中文

Antigravity+ 为 [Paseo](https://paseo.sh) 提供基于 `agy acp`（Antigravity CLI 内置 Agent Client Protocol 服务）的增强型 Antigravity 提供商（`antigravity-plus`），并在 Paseo 的 Usage 面板中集成 Antigravity 额度监控。

## 核心特性

- **重启后保留会话历史**：通过 ACP `session/load` 重新打开并回放历史对话。
- **极速会话导入**：按当前工作区目录列出本地 `agy` CLI 会话（按更新时间倒序，带内存缓存与后台刷新），并自动过滤 `agy acp` 无法加载的 Antigravity 桌面端会话。
- **斜杠命令与技能**：在 Paseo 输入框中支持 `/goal`、`/plan`、`/compact`、`/grill-me` 等斜杠命令与自定义技能补全。
- **完善的权限模式**：在 `agy` 原生的 **Default**、**Accept edits**、**Auto**、**Plan** 之外新增 **Bypass** 模式（新建代理默认启用，不进终端沙箱，在流层以 `allow_once` 自动批准权限请求，不污染全局授权配置）。
- **按模型独立匹配思考档位**：根据 `agy` 的模型变体列表为不同模型提供专属档位（如 Gemini 4 Hydrogen 支持 `XHigh`，GPT-OSS 与 Orchestrator 等无档位模型自动隐藏档位选择）。
- **运行中插话（Steering）**：在运行轮次中发送新消息会直接并入当前轮次继续执行，不会打断重来。
- **Paseo MCP 与子代理编排**：向 `agy` 透传 Paseo MCP 服务与系统指令，拦截不可见不可控的原生 `invoke_subagent`，引导模型统一使用 Paseo 的 `create_agent` 创建可见、可控的子代理标签页。
- **上下文圆环与额度面板**：输入框实时展示上下文窗口占用；macOS 下在 Usage 面板展示套餐名称、Claude/GPT（周限额与 5 小时限额）及 Gemini（Hydrogen/Flash 共享池）额度。

## 环境要求

- **Paseo** `>= 0.16.0`
- **Antigravity CLI (`agy`)** `>= 1.5.8`（在 `PATH` 中可执行且已登录）
- **macOS**（仅额度监控依赖 macOS 钥匙串中的 `gemini` 登录项；提供商本身跨平台可用）

## 安装方式

直接从 GitHub 安装（或待官方商城收录后通过商城安装）：

```bash
paseo plugin add git:jule-x/antigravity-plus
```

### 配置伴随 `agy` 插件（推荐）

为了在 Antigravity+ 会话中强制拦截 `agy` 内置的 `invoke_subagent`、让模型始终通过 Paseo 的 `create_agent` 启动子代理，请将插件内的 `agy-plugin` 软链到 `agy` 全局插件目录：

```bash
mkdir -p ~/.gemini/config/plugins
ln -s "$(ls -dt ~/.paseo/plugins/antigravity-plus/*/checkout/agy-plugin | head -n 1)" ~/.gemini/config/plugins/antigravity-plus-guard
```

如果是从本地克隆的目录安装的插件：

```bash
mkdir -p ~/.gemini/config/plugins
ln -s /absolute/path/to/antigravity-plus/agy-plugin ~/.gemini/config/plugins/antigravity-plus-guard
```

该 `PreToolUse` 钩子仅在进程带有 `ANTIGRAVITY_PLUS=1` 环境变量（由 Antigravity+ 自动注入）时拒绝 `invoke_subagent`；在终端或 IDE 等其他环境下均返回 `{"decision":"allow"}`，不影响正常使用。

### 建议：关闭内置 Antigravity 提供商

由于用户插件无法覆盖内置提供商 ID，Antigravity+ 的 ID 为 `antigravity-plus`。你可以在 **Settings → Providers** 中关闭内置的 **Antigravity**，并通过 Import session 将之前的本地会话导入到 **Antigravity+** 中继续使用。

## 本地开发与验证

```bash
npm install
npm run typecheck
npm test
```

## 开源协议

[MIT](./LICENSE)
