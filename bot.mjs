import { Bot, InputFile } from "grammy";
import { spawn } from "child_process";
import { createServer } from "net";
import { createInterface } from "readline";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// Config
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const ALLOWED_USER_ID = Number(process.env.TG_USER_ID);
if (!BOT_TOKEN) { console.error("TG_BOT_TOKEN env not set"); process.exit(1); }
if (!ALLOWED_USER_ID) { console.error("TG_USER_ID env not set"); process.exit(1); }
const MCP_PORT = 9876;
const SCAFFOLD_DIR = process.env.SCAFFOLD_DIR || path.join(__dirname, "scaffold");
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(HOME, ".teleforge", "sessions");
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(HOME, ".teleforge", "images");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Generate MCP config with absolute paths (so it works from any cwd)
const MCP_CONFIG_PATH = path.join(__dirname, ".mcp_runtime.json");
fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({
  mcpServers: {
    telegram: {
      command: "node",
      args: [path.join(__dirname, "mcp-server.mjs")]
    }
  }
}, null, 2));

const bot = new Bot(BOT_TOKEN);

// Session state
let activeSession = false;
let activeSessionId = null;
let pendingResolve = null;
let currentProc = null;
const messageQueue = [];

// --- Session management ---

function createSession() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  const base = `${mm}${dd}-${hh}${min}`;
  let sessionId = base;
  let sessionDir = path.join(SESSIONS_DIR, sessionId);

  let suffix = 2;
  while (fs.existsSync(sessionDir)) {
    sessionId = `${base}-${suffix}`;
    sessionDir = path.join(SESSIONS_DIR, sessionId);
    suffix++;
  }

  fs.cpSync(SCAFFOLD_DIR, sessionDir, { recursive: true });
  return { sessionId, sessionDir };
}

function log(...args) {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(ts, ...args);
}

// --- TCP server for MCP bridge ---

const tcpServer = createServer((sock) => {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const nlIdx = buf.indexOf("\n");
    if (nlIdx === -1) return;
    const line = buf.slice(0, nlIdx);
    buf = buf.slice(nlIdx + 1);
    handleMcpRequest(JSON.parse(line), sock);
  });
  sock.on("error", (err) => log("TCP sock error:", err.message));
});

async function handleMcpRequest(req, sock) {
  try {
    if (req.action === "send_message") {
      log("MCP send_message:", req.message);
      await sendTg(ALLOWED_USER_ID, req.message);
      sock.end();
    } else if (req.action === "ask_user") {
      log("MCP ask_user:", req.question);
      await bot.api.sendMessage(ALLOWED_USER_ID, `❓ ${req.question}`);
      const answer = await new Promise((resolve) => { pendingResolve = resolve; });
      pendingResolve = null;
      log("MCP ask_user answer:", answer);
      sock.end(JSON.stringify({ answer }) + "\n");
    } else if (req.action === "check_messages") {
      const entries = messageQueue.splice(0);
      for (const e of entries) {
        bot.api.setMessageReaction(ALLOWED_USER_ID, e.messageId, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
      }
      const m = entries.map((e) => e.text);
      sock.end(JSON.stringify({ m }) + "\n");
    } else if (req.action === "send_image") {
      const { file_path, caption } = req;
      if (!fs.existsSync(file_path)) {
        log("MCP send_image: file not found:", file_path);
        sock.end();
        return;
      }
      const imageBytes = fs.readFileSync(file_path);
      const filename = path.basename(file_path);
      log(`MCP send_image: ${filename} (${imageBytes.length} bytes, caption=${caption})`);
      await bot.api.sendPhoto(ALLOWED_USER_ID, new InputFile(imageBytes, filename), {
        caption: caption || undefined,
      });
      sock.end();
    } else if (req.action === "send_video") {
      const { file_path, caption } = req;
      if (!fs.existsSync(file_path)) {
        log("MCP send_video: file not found:", file_path);
        sock.end();
        return;
      }
      const stat = fs.statSync(file_path);
      if (stat.size > 50 * 1024 * 1024) {
        log(`MCP send_video: file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB), max 50 MB`);
        sock.end();
        return;
      }
      const videoBytes = fs.readFileSync(file_path);
      const filename = path.basename(file_path);
      log(`MCP send_video: ${filename} (${videoBytes.length} bytes, caption=${caption})`);
      await bot.api.sendVideo(ALLOWED_USER_ID, new InputFile(videoBytes, filename), {
        caption: caption || undefined,
      });
      sock.end();
    } else {
      log("MCP unknown action:", req.action);
      sock.end();
    }
  } catch (err) {
    log("MCP handler error:", err.message);
    sock.end();
  }
}

// --- Telegram helpers ---

async function sendTg(chatId, text) {
  if (!text || !text.trim()) return;
  for (let i = 0; i < text.length; i += 4096) {
    await bot.api.sendMessage(chatId, text.slice(i, i + 4096));
  }
}

async function downloadPhotos(msg) {
  const paths = [];

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.api.getFile(photo.file_id);
    const localPath = path.join(IMAGES_DIR, `${photo.file_unique_id}.jpg`);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const resp = await fetch(url);
    fs.writeFileSync(localPath, Buffer.from(await resp.arrayBuffer()));
    paths.push(localPath);
  }

  if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/")) {
    const file = await bot.api.getFile(msg.document.file_id);
    const origName = msg.document.file_name || `${msg.document.file_unique_id}.bin`;
    const localPath = path.join(IMAGES_DIR, `${msg.document.file_unique_id}_${origName}`);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const resp = await fetch(url);
    fs.writeFileSync(localPath, Buffer.from(await resp.arrayBuffer()));
    paths.push(localPath);
  }

  return paths;
}

function buildReplyContext(msg) {
  const reply = msg.reply_to_message;
  if (!reply) return "";
  const lines = [];
  const origText = reply.text || reply.caption || "";
  const hasPhoto = reply.photo && reply.photo.length > 0;
  const hasDoc = reply.document && reply.document.mime_type && reply.document.mime_type.startsWith("image/");
  if (!origText && !hasPhoto && !hasDoc) return "";
  lines.push("[Replying to previous message:");
  if (origText) lines.push(`  "${origText}"`);
  if (hasPhoto) lines.push("  (had an attached photo)");
  if (hasDoc) lines.push(`  (had an attached image: ${reply.document.file_name || "document"})`);
  lines.push("]");
  return lines.join("\n");
}

function buildTextWithImages(text, imagePaths, replyContext) {
  const parts = [];
  if (replyContext) parts.push(replyContext);
  if (text) parts.push(text);
  if (imagePaths.length > 0) {
    parts.push("Attached images (local paths):");
    for (const p of imagePaths) parts.push(`  ${p}`);
  }
  return parts.join("\n");
}

function extractModel(text) {
  const m = text.match(/^model\s+(\S+)\n?/i);
  if (!m) return { model: null, rest: text };
  return { model: m[1], rest: text.slice(m[0].length) };
}

// --- Bot handlers ---

bot.command("start", async (ctx) => {
  if (ctx.from.id !== ALLOWED_USER_ID) return;
  await ctx.reply("Send me a task for Claude Code.");
});

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (ctx.from.id !== ALLOWED_USER_ID) return;

  const hasContent = msg.text || msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/"));
  if (!hasContent) return;

  const imagePaths = await downloadPhotos(msg);
  const replyContext = buildReplyContext(msg);
  const textPart = (msg.text || msg.caption || "").trim();

  // If Claude is waiting for user input, resolve it
  if (pendingResolve) {
    const reply = buildTextWithImages(msg.text || msg.caption, imagePaths, replyContext);
    log("USER REPLY:", reply);
    pendingResolve(reply);
    return;
  }

  // Kill current session: "shutdown"
  if (/^shutdown$/i.test(textPart)) {
    if (!activeSession) {
      await ctx.reply("No active session.");
      return;
    }
    const sid = activeSessionId;
    log("SHUTDOWN:", sid);
    if (pendingResolve) { pendingResolve = null; }
    if (currentProc) { currentProc.kill(); currentProc = null; }
    activeSession = false;
    activeSessionId = null;
    messageQueue.length = 0;
    await ctx.reply(`Killed [${sid}].`);
    return;
  }

  // If agent is busy, queue the message
  if (activeSession) {
    const queued = buildTextWithImages(msg.text || msg.caption, imagePaths, replyContext);
    if (queued.trim()) {
      messageQueue.push({ text: queued, messageId: msg.message_id });
      log("QUEUED:", queued.slice(0, 200));
    }
    return;
  }

  // Resume session by replying to a "Done" message (only when no active session)
  const doneMatch = msg.reply_to_message?.text?.match(/^(?:Done|Killed) \[(\S+)\]\./);
  if (doneMatch) {
    const resumeId = doneMatch[1];
    const resumeDir = path.join(SESSIONS_DIR, resumeId);

    if (!fs.existsSync(resumeDir)) {
      await ctx.reply(`Session not found: ${resumeId}`);
      return;
    }

    // Use only the user's text + images, skip the quoted Done message
    const actualTask = buildTextWithImages(textPart, imagePaths, "");

    if (!actualTask.trim()) {
      await ctx.reply("No task provided. Reply to the Done message with a task.");
      return;
    }

    const { model, rest: cleanTask } = extractModel(actualTask);

    log("CONTINUE SESSION:", resumeId, resumeDir);
    log("USER TASK:", cleanTask);
    activeSession = true;
    activeSessionId = resumeId;
    await ctx.reply(`Continuing: ${resumeId}${model ? ` (model: ${model})` : ""}`);

    spawnClaude(cleanTask, msg.chat.id, resumeDir, resumeId, { resume: true, model });
    return;
  }

  const task = buildTextWithImages(msg.text || msg.caption, imagePaths, replyContext);
  if (!task.trim()) return;

  const { model, rest: cleanTask } = extractModel(task);

  const { sessionId, sessionDir } = createSession();
  log("SESSION:", sessionId, sessionDir);
  log("USER TASK:", cleanTask);
  activeSession = true;
  activeSessionId = sessionId;
  await ctx.reply(`Session: ${sessionId}${model ? ` (model: ${model})` : ""}`);

  spawnClaude(cleanTask, msg.chat.id, sessionDir, sessionId, { model });
});

// --- Claude subprocess ---

function spawnClaude(task, chatId, sessionDir, sessionId, { resume = false, model } = {}) {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", MCP_CONFIG_PATH,
    "--dangerously-skip-permissions",
  ];

  if (model) {
    args.push("--model", model);
    log("MODEL:", model);
  }

  const sessionFile = path.join(sessionDir, ".claude-session-id");

  if (resume) {
    // Resume existing Claude conversation if session ID file exists
    if (fs.existsSync(sessionFile)) {
      const claudeId = fs.readFileSync(sessionFile, "utf-8").trim();
      args.push("--resume", claudeId);
      log("RESUME CLAUDE SESSION:", claudeId);
    }
  } else {
    // New session: generate and save a Claude session ID
    const claudeId = crypto.randomUUID();
    fs.writeFileSync(sessionFile, claudeId);
    args.push("--session-id", claudeId);
    log("NEW CLAUDE SESSION:", claudeId);
  }

  // "--" prevents task text starting with "-" from being parsed as a flag
  args.push("--", task);

  const proc = spawn("claude", args, {
    cwd: sessionDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  currentProc = proc;
  let lastText = "";
  let doneSent = false;

  const rl = createInterface({ input: proc.stdout });

  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("NON-JSON:", line.slice(0, 300));
      return;
    }

    const msgType = msg.type;
    log(`STDOUT: type=${msgType} len=${line.length}`);

    if (msgType === "assistant") {
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text.trim()) {
          lastText = block.text.trim();
          log("CLAUDE:", lastText);
        }
      }
    } else if (msgType === "result") {
      if (msg.subagent || doneSent) return;
      doneSent = true;
      const result = msg.result || "";
      const cost = msg.cost_usd || 0;
      const turns = msg.num_turns || 0;
      log(`RESULT: cost=$${cost.toFixed(2)} turns=${turns}`);

      (async () => {
        await sendTg(chatId, `Done [${sessionId}]. Cost: $${cost.toFixed(4)}, turns: ${turns}`);
      })();
    }
  });

  proc.stderr.on("data", (data) => {
    log("STDERR:", data.toString().trim());
  });

  proc.on("close", (code) => {
    currentProc = null;
    activeSession = false;
    activeSessionId = null;
    log("CLAUDE EXIT:", code);
  });

  proc.on("error", (err) => {
    currentProc = null;
    activeSession = false;
    activeSessionId = null;
    log("SPAWN ERROR:", err.message);
    sendTg(chatId, `Error: ${err.message}`);
  });
}

// --- Startup ---

tcpServer.listen(MCP_PORT, "localhost", () => {
  log(`MCP bridge on localhost:${MCP_PORT}`);
});

log("Starting bot...");
log("Scaffold:", SCAFFOLD_DIR);
log("Sessions:", SESSIONS_DIR);
log("Images:  ", IMAGES_DIR);
bot.start({
  onStart: () => log("Bot is running."),
});

// --- Graceful shutdown ---

function shutdown() {
  log("Shutting down...");
  bot.stop();
  if (currentProc) currentProc.kill();
  tcpServer.close();
  setTimeout(() => process.exit(0), 1000);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
