Antigravity+ adds a second Antigravity provider to Paseo that runs `agy acp`, the Agent Client Protocol server built into the Antigravity CLI, instead of the stream-json print mode the built-in provider uses. Prompts, attachments, MCP tool calls and tool outputs go to `agy acp` in the session's working directory and through `agy` to Google's Antigravity service. The plugin also adds an Antigravity quota source to the Usage panel.

## What you get

- Conversation history after a daemon restart or agent reload. Paseo reopens the agy conversation with `session/load`, and agy replays it into the timeline.
- Import session lists your local agy CLI conversations for the selected directory, newest first, including ones started by the built-in Antigravity provider or in the agy terminal UI. To avoid listing Antigravity desktop app conversations that `agy acp` cannot load, the plugin checks `~/.gemini/antigravity-cli/conversations/` for a local conversation database and runs `session/list` in an empty temporary folder (`$TMPDIR/antigravity-plus/session-list`).
- Slash commands and skills such as `/goal`, `/plan`, `/compact` and your own skills appear in the composer.
- Modes: Bypass, plus agy's own Default, Accept edits, Auto and Plan. New agents start in Bypass, where every edit and command runs without asking and outside agy's terminal sandbox. Bypass runs agy in its Default mode and the plugin approves each request agy makes with `allow_once`; Auto and the other modes ask through Paseo permission cards. Deny rules in your agy settings still apply in every mode.
- Paseo's MCP servers and the agent's Paseo instructions reach agy, so Antigravity agents can use Paseo's orchestration tools.
- Subagents through Paseo. agy's own `invoke_subagent` starts subagents that Paseo cannot show or control, so it is blocked in Antigravity+ sessions and agy is told to use Paseo's `create_agent` instead. agy commands that rely on native subagents, such as `/teamwork` and `/boost`, do not work here; use the agy terminal UI for them.
- The context window meter in the composer, from agy's usage updates.
- Steering: a message sent during a running turn joins that turn instead of interrupting it.
- Model and thinking level as separate choices, with each model's own levels, such as XHigh for Gemini 4 Hydrogen.

## Setup

Blocking `invoke_subagent` needs the companion agy plugin in `agy-plugin/`, linked into agy's global plugins folder (`~/.gemini/config/plugins/`). See the repository README for the symlink command. Its hook blocks `invoke_subagent` only in agy processes started by Antigravity+, which carry `ANTIGRAVITY_PLUS=1`; anywhere else it answers "allow", and agy does not ask permission for `invoke_subagent` on its own, so other agy sessions behave as before. Without the companion plugin, agy is still told to prefer Paseo agents but nothing enforces it.

## Quota

The quota source reads agy's Google login from the macOS Keychain (service `gemini`) and asks Google's Antigravity backend (`daily-cloudcode-pa.googleapis.com`) for quota. It reports the plan name, a weekly and a 5-hour limit for Claude and GPT models, and a "Gemini" window for the pool shared by Gemini 4 Hydrogen and the Flash models. Google does not report a length for that pool, so it is labeled by name only. Gemini 4 Argon has a separate quota that this backend does not report, so the Gemini window leaves Argon out. The access token is used only for these requests. When it has expired, the source runs `agy models` once so agy refreshes its own login; the plugin only uses the access token, never uses or stores the refresh token, and never writes the Keychain.

## Requirements

- Paseo 0.16.0 or later and agy 1.5.8 or later, signed in.
- macOS only. The quota source reads the macOS Keychain and the companion agy plugin runs its hook with `/bin/sh`. Windows is not supported, and Linux is untested.

## Limits

- Antigravity+ is a separate provider. Agents created with the built-in Antigravity provider stay on it; import their conversations to move them.
- Background commands: when agy moves a long-running command to the background, its turn can end before the command finishes, so Paseo shows the agent idle while that command still runs.
- Shell, read and search tools show as generic tool rows with their input and output; file edits show as diffs.
