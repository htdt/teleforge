# tg-send

Single-shot CLI for sending text plus an optional image or video to Telegram.

There is no bot polling loop, no MCP bridge, and no long-running server, just simple one-way messages.

## Setup

No runtime dependencies are required. Run it directly with Node, or use `npm link` if you want a `tg-send` command in your shell.

## Environment

| Variable | Required | Description |
|---|---|---|
| `TG_BOT_TOKEN` | yes | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TG_CHAT_ID` | yes | Target chat ID or `@channelusername` |

For a 1:1 bot chat, `TG_CHAT_ID` is your Telegram user id. For groups and channels, use the actual chat id instead.

## Usage

Send text only:

```bash
TG_BOT_TOKEN=... TG_CHAT_ID=... node tg-send.mjs --text "build finished"
```

Send a file only:

```bash
TG_BOT_TOKEN=... TG_CHAT_ID=... node tg-send.mjs --file ./render.png
```

Send a file with caption text:

```bash
TG_BOT_TOKEN=... TG_CHAT_ID=... node tg-send.mjs --text "latest render" --file ./render.png
```

Executable script usage also works:

```bash
./tg-send.mjs --text "hello"
```

## Behavior

- At least one of `--text` or `--file` is required.
- If `--file` is present, the tool auto-detects image vs video from the file extension.
- Supported image extensions: `.jpg`, `.jpeg`, `.png`, `.webp`
- Supported video extensions: `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi`
- If `--text` is longer than Telegram's media caption limit, the file is sent first and the text is sent as follow-up messages.

## Install As Command

```bash
npm link
tg-send --text "hello from telegram"
```
