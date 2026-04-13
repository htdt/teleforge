# tg-push

Python CLI for sending text plus an optional image or video to Telegram.

There is no bot polling loop, no MCP bridge, and no long-running server, just simple one-way messages.

## Install

```bash
pip install tg-push
```

Or with [pipx](https://pipx.pypa.io) for an isolated install:

```bash
pipx install tg-push
```

## Environment

| Variable | Required | Description |
|---|---|---|
| `TG_BOT_TOKEN` | yes | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TG_CHAT_ID` | yes | Target chat ID or `@channelusername` |

For a 1:1 bot chat, `TG_CHAT_ID` is your Telegram user id. For groups and channels, use the actual chat id instead.

## Usage

```bash
tg-push --text "build finished"
tg-push --file ./render.png
tg-push --text "latest render" --file ./render.png
```

## Behavior

- At least one of `--text` or `--file` is required.
- If `--file` is present, the tool auto-detects image vs video from the file extension.
- Supported image extensions: `.jpg`, `.jpeg`, `.png`, `.webp`
- Supported video extensions: `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`, `.avi`
- If `--text` is longer than Telegram's media caption limit, the file is sent first and the text is sent as follow-up messages.
- The project has no runtime dependencies outside the Python standard library.
