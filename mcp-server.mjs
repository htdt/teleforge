import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import net from "net";

const BOT_HOST = "localhost";
const BOT_PORT = 9876;

function tcpRequest(data, expectResponse = false) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(BOT_PORT, BOT_HOST, () => {
      sock.write(JSON.stringify(data) + "\n");
      if (!expectResponse) {
        sock.end();
        resolve(null);
      }
    });

    if (expectResponse) {
      let buf = "";
      sock.on("data", (chunk) => { buf += chunk.toString(); });
      sock.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          reject(new Error("Invalid JSON from bot: " + buf));
        }
      });
    }

    sock.on("error", reject);
  });
}

const server = new McpServer({ name: "telegram-bridge", version: "1.0.0" });

server.tool(
  "send_message",
  "Send a message to the Telegram user (no response expected).",
  { message: z.string() },
  async ({ message }) => {
    await tcpRequest({ action: "send_message", message });
    return { content: [{ type: "text", text: "sent" }] };
  }
);

server.tool(
  "ask_user",
  "Ask the Telegram user a question and wait for their response.",
  { question: z.string() },
  async ({ question }) => {
    const resp = await tcpRequest({ action: "ask_user", question }, true);
    return { content: [{ type: "text", text: resp.answer }] };
  }
);

server.tool(
  "check_messages",
  "Check for queued user messages that arrived while you were busy. Call this before switching to a new task and before ending your session.",
  {},
  async () => {
    const resp = await tcpRequest({ action: "check_messages" }, true);
    const m = resp.m || [];
    return { content: [{ type: "text", text: m.length ? m.join("\n---\n") : "0" }] };
  }
);

server.tool(
  "send_image",
  "Send an image file to the Telegram user. file_path must be an absolute path to an image on disk.",
  { file_path: z.string(), caption: z.string().optional().default("") },
  async ({ file_path, caption }) => {
    await tcpRequest({ action: "send_image", file_path, caption });
    return { content: [{ type: "text", text: "image sent" }] };
  }
);

server.tool(
  "send_video",
  "Send a video file to the Telegram user. file_path must be an absolute path to a video on disk. Must be under 50 MB.",
  { file_path: z.string(), caption: z.string().optional().default("") },
  async ({ file_path, caption }) => {
    await tcpRequest({ action: "send_video", file_path, caption });
    return { content: [{ type: "text", text: "video sent" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
