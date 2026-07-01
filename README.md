# Telegram Notifier MCP Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that exposes a
minimal [Model Context Protocol](https://modelcontextprotocol.io) **Streamable
HTTP** endpoint with a single tool, `send_telegram_message`, which sends text to
a Telegram chat through the **Bot API**.

Because it is a public Worker with a valid TLS certificate, it is reachable by
**cloud-hosted MCP clients** (e.g. remote custom connectors), which a
`localhost` or private-tailnet server is not. Sending through a bot produces a
real push notification, unlike posting to your own "Saved Messages".

## Why this exists

Remote MCP connectors are dialed **from the provider's servers**, not from your
machine — so the endpoint must be publicly reachable over HTTPS. Rather than
expose a home server, this runs on Cloudflare's free Workers plan:

- Public HTTPS with a managed certificate on your own domain.
- No servers to run or keep awake.
- Gated by an unguessable secret, so only holders of the full URL can use it.

## Security model

The endpoint is gated by a secret **path segment**. Every request must arrive at
`https://<host>/<SECRET_PATH>`; anything else returns `404`. The full URL is the
only credential, so treat it like a password. The single tool can only *send*
messages to the configured chat — it cannot read anything.

## Tool

| Tool | Arguments | Description |
| --- | --- | --- |
| `send_telegram_message` | `text` (required), `chat_id` (optional) | Sends `text` to `chat_id`, or to `TELEGRAM_DEFAULT_CHAT_ID` when omitted. |

## Configuration

Everything sensitive is a Worker **secret** (never committed). The Telegram chat
id is stored as a secret too, so the repository contains no personal data.

| Name | Kind | Description |
| --- | --- | --- |
| `SECRET_PATH` | secret | Unguessable first path segment that gates the endpoint. |
| `TELEGRAM_BOT_TOKEN` | secret | Bot token from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_DEFAULT_CHAT_ID` | secret | Chat/user id used when a call omits `chat_id`. |

For local development the same three values go in `.dev.vars` (gitignored); see
`.dev.vars.example`.

## Prerequisites

- Node.js (for the Wrangler CLI): `npm install -g wrangler`
- A Cloudflare account with a zone (domain) you control.
- A Cloudflare **API token** with, on that zone: *Workers Scripts: Edit*,
  *Workers Routes: Edit*, *DNS: Edit*, and *Account Settings: Read*
  (the "Edit Cloudflare Workers" template plus DNS edit covers it).
- A Telegram bot token and the chat id you want to notify.

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...          # the token described above
wrangler whoami                          # sanity-check auth + account

# Edit wrangler.toml first: set [[routes]] pattern to your own host.
wrangler deploy                          # creates the Worker + custom domain

# Set the secrets (once). Generate a strong SECRET_PATH, e.g.:
#   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
wrangler secret put SECRET_PATH
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_DEFAULT_CHAT_ID
```

## Local development

```bash
cp .dev.vars.example .dev.vars           # then fill in the three values
wrangler dev                             # serves http://127.0.0.1:8787
```

## Connect it to your MCP client

In **Settings → Connectors → Add custom connector**:

- **Name:** `Telegram`
- **Remote MCP server URL:** `https://<host>/<SECRET_PATH>`
- Leave the OAuth fields empty.

## Manual test

```bash
HOST=https://<host>/<SECRET_PATH>

# List tools
curl -s "$HOST" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Send a message
curl -s "$HOST" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_telegram_message","arguments":{"text":"Hello from the Worker"}}}'

# The gate: a wrong path returns 404
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/wrong-path
```

## How it works

`src/index.js` is a single `fetch` handler that:

1. Rejects any request whose first path segment isn't `SECRET_PATH` (`404`).
2. Answers `GET` with a health check, `OPTIONS` with CORS preflight.
3. Parses `POST` bodies as JSON-RPC and handles the MCP methods `initialize`,
   `ping`, `tools/list`, and `tools/call` (single messages or batches).
4. For `tools/call`, calls the Telegram Bot API `sendMessage` and returns the
   result as MCP tool content.

Responses use `application/json`, which the Streamable HTTP transport accepts.

## License

Released into the public domain under [The Unlicense](LICENSE).
