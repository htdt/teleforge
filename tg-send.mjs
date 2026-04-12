#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
]);

function usage() {
  return [
    "Usage:",
    "  tg-send --text \"hello\"",
    "  tg-send --file ./image.png",
    "  tg-send --text \"caption\" --file ./video.mp4",
    "",
    "Environment:",
    "  TG_BOT_TOKEN   Telegram bot token (required)",
    "  TG_CHAT_ID     Target chat ID or @channelusername (required)",
    "",
    "Notes:",
    "  - At least one of --text or --file is required.",
    "  - --file is auto-detected as image or video from its extension.",
    "  - If --text is too long for a media caption, the file is sent first and the text is sent as follow-up messages.",
  ].join("\n");
}

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { text: "", file: "", help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg !== "--text" && arg !== "--file") {
      fail(`Unknown argument: ${arg}\n\n${usage()}`);
    }

    const next = argv[i + 1];
    if (next === undefined) {
      fail(`Missing value for ${arg}\n\n${usage()}`);
    }

    if (arg === "--text") {
      args.text = next;
    } else {
      args.file = next;
    }

    i++;
  }

  return args;
}

function getConfig() {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  if (!token) fail("TG_BOT_TOKEN is required.");
  if (!chatId) fail("TG_CHAT_ID is required.");

  return { token, chatId };
}

function detectMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return { method: "sendPhoto", field: "photo" };
  if (VIDEO_EXTENSIONS.has(ext)) return { method: "sendVideo", field: "video" };

  fail(
    `Unsupported file type: ${ext || "(no extension)"}\n` +
    "Supported image extensions: .jpg, .jpeg, .png, .webp\n" +
    "Supported video extensions: .mp4, .mov, .m4v, .webm, .mkv, .avi"
  );
}

async function telegramRequest(token, method, { json, formData } = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: json ? { "content-type": "application/json" } : undefined,
    body: json ? JSON.stringify(json) : formData,
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`Telegram API returned non-JSON response (${response.status}): ${bodyText}`);
  }

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram API request failed with status ${response.status}`);
  }

  return payload.result;
}

async function sendText(token, chatId, text) {
  if (!text) return;

  for (let i = 0; i < text.length; i += TEXT_LIMIT) {
    await telegramRequest(token, "sendMessage", {
      json: {
        chat_id: chatId,
        text: text.slice(i, i + TEXT_LIMIT),
      },
    });
  }
}

async function sendFile(token, chatId, filePath, text) {
  if (!fs.existsSync(filePath)) {
    fail(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    fail(`Not a file: ${filePath}`);
  }

  const { method, field } = detectMediaType(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const caption = text && text.length <= CAPTION_LIMIT ? text : "";

  const formData = new FormData();
  formData.set("chat_id", chatId);
  formData.set(field, new Blob([fileBuffer]), path.basename(filePath));
  if (caption) {
    formData.set("caption", caption);
  }

  await telegramRequest(token, method, { formData });

  if (text && !caption) {
    await sendText(token, chatId, text);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.text && !args.file) {
    fail(`At least one of --text or --file is required.\n\n${usage()}`);
  }

  const { token, chatId } = getConfig();

  if (args.file) {
    await sendFile(token, chatId, args.file, args.text);
    return;
  }

  await sendText(token, chatId, args.text);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
