Antigravity+ adds a second Antigravity provider to Paseo that runs `agy acp`, the Agent Client Protocol server built into the Antigravity CLI, instead of the stream-json print mode the built-in provider uses. It also adds an Antigravity quota source to the Usage panel.

## What you get

- Conversation history after a daemon restart or agent reload. Paseo reopens the agy conversation with `session/load`, and agy replays it into the timeline.
- Import session lists your local agy conversations, including ones started by the built-in Antigravity provider or in the agy terminal UI.
- Slash commands and skills such as `/goal`, `/plan`, `/compact` and your own skills appear in the composer.
- Permission modes from agy: Default, Accept edits, Auto and Plan. New agents start in Auto, which runs edits and safe commands and asks through a Paseo permission card before anything irreversible. agy is never started with `--dangerously-skip-permissions`.
- Paseo's MCP servers and the agent's Paseo instructions reach agy, so Antigravity agents can use Paseo's orchestration tools.
- The context window meter in the composer, from agy's usage updates.
- Steering: a message sent during a running turn joins that turn instead of interrupting it.
- Model and thinking level as separate choices.

## Quota

The quota source reads agy's Google login from the macOS Keychain (service `gemini`) and asks Google's Antigravity backend for the same quota agy shows. It reports the plan name and each window Google returns: a weekly and a 5-hour limit for Claude and GPT models, and one shared pool for Google models. Google does not report a length for the Google pool, so it is labeled by name only. The access token is used only for these requests. When it has expired, the source runs `agy models` once so agy refreshes its own login; the plugin never reads the refresh token or writes the Keychain.

## Requirements

- Paseo 0.16.0 or later and agy 1.5.8 or later, signed in.
- Quota needs macOS. The provider works wherever agy runs.

## Limits

- Antigravity+ is a separate provider. Agents created with the built-in Antigravity provider stay on it; import their conversations to move them.
- Background commands: when agy moves a long command to the background it ends the turn and resumes on its own later, so Paseo can show the agent idle while that command runs.
- Shell, read and search tools show as generic tool rows with their input and output; file edits show as diffs.
