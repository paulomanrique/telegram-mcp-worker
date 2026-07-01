/**
 * Telegram Notifier MCP Worker
 *
 * A Cloudflare Worker that implements a minimal Model Context Protocol (MCP)
 * "Streamable HTTP" endpoint exposing a single tool, `send_telegram_message`,
 * which relays text to a Telegram chat via the Bot API (so it notifies, unlike
 * self-chat "Saved Messages").
 *
 * The endpoint is gated by a secret path segment: requests must arrive at
 * `https://<host>/<SECRET_PATH>`. Anyone without the full URL gets a 404.
 *
 * Secrets/vars (configured via `wrangler secret put` / wrangler.toml [vars]):
 *   - SECRET_PATH               (secret) the unguessable path segment gate
 *   - TELEGRAM_BOT_TOKEN        (secret) bot token from @BotFather
 *   - TELEGRAM_DEFAULT_CHAT_ID  (var)    chat id used when a call omits chat_id
 */

const SERVER_NAME = "telegram-notifier";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "send_telegram_message",
    description:
      "Send a plain-text message to a Telegram chat via the bot. " +
      "If chat_id is omitted, the server's default chat is used.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message text to send." },
        chat_id: {
          type: "string",
          description:
            "Optional Telegram chat/user id. Defaults to the server's configured chat.",
        },
      },
      required: ["text"],
    },
  },
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function json(payload, status, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    ...corsHeaders(),
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return new Response(JSON.stringify(payload), { status, headers });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function sendTelegramMessage(env, text, chatId) {
  const token = (env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const target = (chatId || env.TELEGRAM_DEFAULT_CHAT_ID || "").toString().trim();
  if (!target) {
    throw new Error("No chat_id provided and TELEGRAM_DEFAULT_CHAT_ID is not set.");
  }

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: target, text }),
  });
  const body = await resp.json();
  if (!body.ok) {
    throw new Error(`Telegram API rejected the request: ${JSON.stringify(body)}`);
  }
  const messageId = body.result?.message_id ?? "?";
  return `Message delivered to chat ${target} (message_id: ${messageId}).`;
}

async function dispatchToolCall(env, name, args) {
  if (name !== "send_telegram_message") return toolError(`Unknown tool: ${name}`);
  const text = args?.text;
  if (typeof text !== "string" || !text) {
    return toolError("Argument 'text' is required and must be a string.");
  }
  try {
    const status = await sendTelegramMessage(env, text, args?.chat_id);
    return { content: [{ type: "text", text: status }] };
  } catch (err) {
    return toolError(String(err.message || err));
  }
}

async function handleRpc(message, env) {
  const method = message.method;
  const id = message.id;
  const params = message.params || {};

  // Notifications carry no id and must not be answered.
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(id, await dispatchToolCall(env, params.name || "", params.arguments || {}));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = (env.SECRET_PATH || "").trim();
    const parts = url.pathname.split("/").filter(Boolean);

    // Gate: the first path segment must equal the secret.
    if (!secret || parts[0] !== secret) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check (GET on the secret path).
    if (request.method === "GET") {
      return json({ status: "ok", server: SERVER_NAME }, 200);
    }

    // Session termination.
    if (request.method === "DELETE") {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST, DELETE, OPTIONS", ...corsHeaders() },
      });
    }

    let message;
    try {
      message = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const sessionId = crypto.randomUUID();

    // Support both single messages and JSON-RPC batches.
    if (Array.isArray(message)) {
      const responses = [];
      for (const m of message) {
        const r = await handleRpc(m, env);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }
      return json(responses, 200, sessionId);
    }

    const response = await handleRpc(message, env);
    if (response === null) {
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    return json(response, 200, sessionId);
  },
};
