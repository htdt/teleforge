# Teleforge

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions remotely through a Telegram bot. Designed for one-shot tasks on a headless VM — send a task, let the agent scaffold, build, and ship with minimal back-and-forth. The agent can ask follow-up questions and send images/videos mid-session via MCP tools.

## Architecture

- **bot.mjs** — Telegram bot (grammy) + internal TCP server. Receives tasks from Telegram, spawns `claude` CLI as a subprocess, streams results back.
- **mcp-server.mjs** — MCP server that the agent loads as a tool provider. Bridges tool calls (`send_message`, `ask_user`, `send_image`) to the bot over a local TCP socket.

## Setup

```bash
npm install
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TG_BOT_TOKEN` | yes | — | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TG_USER_ID` | yes | — | Your numeric Telegram user ID. Only this user can interact with the bot. |
| `SCAFFOLD_DIR` | no | `./scaffold` | Template directory copied into each session. Contains `CLAUDE.md`. |
| `SESSIONS_DIR` | no | `~/.teleforge/sessions` | Where per-session working directories are created. |
| `IMAGES_DIR` | no | `~/.teleforge/images` | Where images received from Telegram are saved. |

Set them however you prefer (shell export, `.env` file with a loader, systemd unit, etc).

### Run

```bash
TG_BOT_TOKEN=... TG_USER_ID=... npm start
```

## Commands

### Model override

Start your message with `model <model-id>` (optionally followed by a newline) to override the Claude model for that session. The prefix is stripped from the task text.

Example: `model claude-sonnet-4-5-20250514` followed by your task.

### Reply to resume

Reply to a `Done [sessionId]...` or `Killed [sessionId].` message with a new task to resume that session — restores the working directory **and** the Claude conversation history, so the agent has full context from previous turns.

The quoted part of the message is stripped so it doesn't confuse the agent.

### `shutdown`

Kill the currently running session immediately. The session directory is kept — reply to the `Killed` message to resume it later.

## Security note

The bot spawns Claude Code with `--dangerously-skip-permissions`. This flag disables all interactive permission prompts so the agent can execute tools autonomously (file edits, shell commands, etc.) without manual approval.

**This means the agent has unrestricted access to your machine.** Only run this in an environment you're comfortable with (a container, a VM, a dedicated dev machine). Do not expose the bot to untrusted Telegram users — `TG_USER_ID` restricts access to a single account, but the underlying session has no guardrails.
