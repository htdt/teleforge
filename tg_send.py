#!/usr/bin/env python3

from __future__ import annotations

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

TEXT_LIMIT = 4096
CAPTION_LIMIT = 1024

IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}

VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".mkv",
    ".avi",
}


class CliError(RuntimeError):
    pass


@dataclass(frozen=True)
class Args:
    text: str = ""
    file: str = ""
    help: bool = False


@dataclass(frozen=True)
class Config:
    token: str
    chat_id: str


def usage(program_name: str) -> str:
    return "\n".join(
        [
            "Usage:",
            f"  {program_name} --text \"hello\"",
            f"  {program_name} --file ./image.png",
            f"  {program_name} --text \"caption\" --file ./video.mp4",
            "",
            "Environment:",
            "  TG_BOT_TOKEN   Telegram bot token (required)",
            "  TG_CHAT_ID     Target chat ID or @channelusername (required)",
            "",
            "Notes:",
            "  - At least one of --text or --file is required.",
            "  - --file is auto-detected as image or video from its extension.",
            "  - If --text is too long for a media caption, the file is sent first and the text is sent as follow-up messages.",
        ]
    )


def resolve_program_name(raw_program_name: str) -> str:
    program_name = Path(raw_program_name).name
    if program_name == "tg_send.py":
        return "python3 -m tg_send"
    return program_name or "tg-send"


def parse_args(argv: list[str], program_name: str) -> Args:
    args = Args()
    index = 0

    while index < len(argv):
        current = argv[index]

        if current in {"--help", "-h"}:
            args = Args(text=args.text, file=args.file, help=True)
            index += 1
            continue

        if current not in {"--text", "--file"}:
            raise CliError(f"Unknown argument: {current}\n\n{usage(program_name)}")

        if index + 1 >= len(argv):
            raise CliError(f"Missing value for {current}\n\n{usage(program_name)}")

        value = argv[index + 1]
        if current == "--text":
            args = Args(text=value, file=args.file, help=args.help)
        else:
            args = Args(text=args.text, file=value, help=args.help)

        index += 2

    return args


def get_config() -> Config:
    token = os.getenv("TG_BOT_TOKEN")
    chat_id = os.getenv("TG_CHAT_ID")

    if not token:
        raise CliError("TG_BOT_TOKEN is required.")
    if not chat_id:
        raise CliError("TG_CHAT_ID is required.")

    return Config(token=token, chat_id=chat_id)


def detect_media_type(file_path: Path) -> tuple[str, str]:
    extension = file_path.suffix.lower()
    if extension in IMAGE_EXTENSIONS:
        return ("sendPhoto", "photo")
    if extension in VIDEO_EXTENSIONS:
        return ("sendVideo", "video")

    raise CliError(
        f"Unsupported file type: {extension or '(no extension)'}\n"
        "Supported image extensions: .jpg, .jpeg, .png, .webp\n"
        "Supported video extensions: .mp4, .mov, .m4v, .webm, .mkv, .avi"
    )


def telegram_request(
    token: str,
    method: str,
    *,
    json_payload: dict[str, str] | None = None,
    form_payload: bytes | None = None,
    content_type: str | None = None,
) -> object:
    headers: dict[str, str] = {}
    body: bytes | None = None

    if json_payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(json_payload).encode("utf-8")
    elif form_payload is not None:
        if content_type is None:
            raise CliError("Missing content type for form upload.")
        headers["Content-Type"] = content_type
        body = form_payload

    request = urllib.request.Request(
        url=f"https://api.telegram.org/bot{token}/{method}",
        data=body,
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request) as response:
            status = response.status
            response_bytes = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        response_bytes = error.read()
    except urllib.error.URLError as error:
        raise CliError(f"Telegram API request failed: {error.reason}") from error

    response_text = response_bytes.decode("utf-8", errors="replace")
    try:
        payload = json.loads(response_text)
    except json.JSONDecodeError as error:
        raise CliError(
            f"Telegram API returned non-JSON response ({status}): {response_text}"
        ) from error

    if status >= 400 or not payload.get("ok"):
        description = payload.get("description")
        raise CliError(description or f"Telegram API request failed with status {status}")

    return payload.get("result")


def send_text(token: str, chat_id: str, text: str) -> None:
    if not text:
        return

    for start in range(0, len(text), TEXT_LIMIT):
        telegram_request(
            token,
            "sendMessage",
            json_payload={
                "chat_id": chat_id,
                "text": text[start : start + TEXT_LIMIT],
            },
        )


def build_multipart_form(
    *,
    fields: dict[str, str],
    file_field: str,
    file_path: Path,
) -> tuple[bytes, str]:
    boundary = f"----tg-send-{uuid.uuid4().hex}"
    body = bytearray()

    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
        )
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        (
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{file_path.name}"\r\n'
        ).encode("utf-8")
    )
    body.extend(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    body.extend(file_path.read_bytes())
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    return bytes(body), boundary


def send_file(token: str, chat_id: str, file_name: str, text: str) -> None:
    file_path = Path(file_name).expanduser()

    if not file_path.exists():
        raise CliError(f"File not found: {file_path}")
    if not file_path.is_file():
        raise CliError(f"Not a file: {file_path}")

    method, field = detect_media_type(file_path)
    caption = text if text and len(text) <= CAPTION_LIMIT else ""

    fields = {"chat_id": chat_id}
    if caption:
        fields["caption"] = caption

    form_payload, boundary = build_multipart_form(
        fields=fields,
        file_field=field,
        file_path=file_path,
    )

    telegram_request(
        token,
        method,
        form_payload=form_payload,
        content_type=f"multipart/form-data; boundary={boundary}",
    )

    if text and not caption:
        send_text(token, chat_id, text)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    program_name = resolve_program_name(sys.argv[0])

    try:
        args = parse_args(argv, program_name)
        if args.help:
            print(usage(program_name))
            return 0

        if not args.text and not args.file:
            raise CliError(
                f"At least one of --text or --file is required.\n\n{usage(program_name)}"
            )

        config = get_config()
        if args.file:
            send_file(config.token, config.chat_id, args.file, args.text)
            return 0

        send_text(config.token, config.chat_id, args.text)
        return 0
    except CliError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
