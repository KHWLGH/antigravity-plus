# Antigravity+ for Paseo

English | [简体中文](./README.zh-CN.md)

Antigravity+ adds a full-featured Antigravity provider (`antigravity-plus`) to [Paseo](https://paseo.sh) powered by `agy acp` (the Agent Client Protocol server built into the Antigravity CLI), plus an Antigravity quota source in Paseo's Usage panel.

## Features

- **Persistent history across restarts**: Reopens conversations via ACP `session/load` and replays the timeline.
- **Fast session import**: Lists local `agy` CLI conversations for the current workspace directory (newest first, with in-memory caching and background refresh), filtering out unimportable Antigravity desktop app records.
- **Slash commands & skills**: Surfaces `/goal`, `/plan`, `/compact`, `/grill-me`, and your custom skills in the Paseo composer.
- **Permission modes**: Adds **Bypass** (default for new agents, running outside the terminal sandbox and auto-approving with `allow_once` without polluting global grants) alongside `agy`'s native **Default**, **Accept edits**, **Auto**, and **Plan** modes.
- **Per-model thinking levels**: Derives each model's supported thinking levels from `agy`'s variant catalog (including `XHigh` for Gemini 4 Hydrogen, and no thinking selector for level-less models like GPT-OSS and Orchestrator).
- **Mid-turn steering**: Messages sent during an active turn join the running turn instead of interrupting it.
- **Paseo MCP & subagent orchestration**: Forwards Paseo's MCP servers and agent system instructions to `agy`, and redirects subagent creation from `agy`'s hidden `invoke_subagent` to Paseo's visible, controllable `create_agent`.
- **Context window & Usage panel quota**: Reports live context window usage in the composer and displays Claude/GPT (Weekly & 5-hour) and Gemini (Hydrogen/Flash shared pool) quota windows on macOS.

## Requirements

- **Paseo** `>= 0.16.0`
- **Antigravity CLI (`agy`)** `>= 1.5.8`, installed on `PATH` and signed in
- **macOS only**: the Usage panel quota source reads service `gemini` from the macOS Keychain, and the companion hook runs with `/bin/sh`. Windows is not supported; Linux is untested.

## Installation

Install from the Paseo plugin registry (once listed) or directly from GitHub:

```bash
paseo plugin add git:jule-x/antigravity-plus
```

### Companion `agy` plugin (recommended)

To enforce blocking `agy`'s internal `invoke_subagent` tool inside Antigravity+ sessions so the model always spawns visible Paseo subagents via `create_agent`, symlink the bundled `agy-plugin` directory into your global Antigravity plugins folder:

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn "$(ls -dt ~/.paseo/plugins/antigravity-plus/*/checkout/agy-plugin | head -n 1)" ~/.gemini/config/plugins/antigravity-plus-guard
```

If you installed the plugin from a local clone instead:

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn /absolute/path/to/antigravity-plus/agy-plugin ~/.gemini/config/plugins/antigravity-plus-guard
```

The installed checkout directory changes after `paseo plugin update`, so re-run the first command after each update.

The `PreToolUse` hook only denies `invoke_subagent` when `ANTIGRAVITY_PLUS=1` is present in the environment (set automatically by Antigravity+). Outside Paseo, it returns `{"decision":"allow"}` and leaves your terminal/IDE `agy` sessions untouched.

### Tip: Disable the built-in Antigravity provider

Because Antigravity+ registers as `antigravity-plus` alongside Paseo's built-in `antigravity` provider, you can disable the built-in **Antigravity** provider in **Settings → Providers** and import any existing sessions into **Antigravity+**.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](./LICENSE)
