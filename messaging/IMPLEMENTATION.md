# messaging/ — Person 1 Technical Implementation

Owns the single public surface: Linq iMessage I/O, drag-drop upload page, Terac review page, media serving. One Express app, port **4000**, one cloudflared tunnel.

Read [../ARCHITECTURE.md](../ARCHITECTURE.md) first — endpoint map there is canonical.

## Stack

```bash
cd messaging
npm init -y
npm install express multer @linqapp/sdk dotenv
brew install cloudflared   # or use ngrok
```

## Boot sequence (server.js)

1. Load `.env` (`LINQ_API_KEY`, `LINQ_FROM_NUMBER`, `PUBLIC_URL`).
2. Start Express on 4000.
3. Start tunnel manually in second terminal: `cloudflared tunnel --url http://localhost:4000` → copy URL into `.env` `PUBLIC_URL`, restart.
4. On boot, ensure Linq webhook subscription exists:

```js
// POST https://api.linqapp.com/api/partner/v3/webhook-subscriptions
// { "target_url": `${PUBLIC_URL}/webhook/linq`, "subscribed_events": ["message.received"] }
```

## Routes

### 1. `POST /webhook/linq` — inbound iMessage
- **Raw body required** for HMAC: `express.raw({ type: 'application/json' })` on THIS route only.
- Verify: `client.webhooks.unwrap(rawBody, { headers: req.headers })` (Standard Webhooks, HMAC-SHA256 — `webhook-id`/`webhook-timestamp`/`webhook-signature` headers).
- Extract `{ chatId, text, from }` → `fetch('http://localhost:4001/handle', { method:'POST', body: JSON.stringify({chatId, text, from}) })`. Fire-and-forget; reply 200 to Linq immediately.

### 2. `POST /send` — outbound (agent calls this)
Body: `{ chatId, text?, videoPath?, caption? }`

```js
const client = new LinqAPIV3({ apiKey: process.env.LINQ_API_KEY });
// text-only:
parts = [{ type: 'text', value: text }]
// video: static-serve the file, pass public URL as media part
parts = [
  { type: 'text', value: caption },
  { type: 'media', url: `${PUBLIC_URL}/media/${basename(videoPath)}` }  // ⚠ verify exact media-part shape at docs.linqapp.com/api
]
await client.chats.create({ from: LINQ_FROM_NUMBER, to: [chatId], message: { parts } })
// If chatId is an existing chat id (not phone), use the chat-message endpoint instead — check SDK.
```

**FIRST 30 MINUTES: test video media part with a sample mp4. This is the #1 unknown in the whole system.** If media parts reject video: fallback = send text with the `/media/...` link.

### 3. `GET /upload` + `POST /upload` — drag-drop frontend
Session-start alternative to Drive. Agent texts this URL to the user when a session begins.

- `GET /upload`: single inline HTML page, no framework. Drop zone (`dragover`/`drop` events) + `<input type="file" multiple accept="video/*">`. JS posts `FormData` to `POST /upload`, shows per-file progress + "N clips ready".
- `POST /upload`: `multer({ dest: '../clips/', limits: { fileSize: 500 * 1024 * 1024 } })`. Accept `.mp4 .mov .m4v` only (reject others, 415). Rename to original filename. Respond `{ ok: true, count }`.

### 4. `GET /review/:id` — Terac human review page
What Terac participants land on (`task_url`). Inline HTML:
- `<video controls src="/media/final.mp4">` (or per-oppId filename if multiple runs)
- 1–5 star radio group + `<textarea>` "What would you change?"
- Submit → `POST /review/:id/feedback` → thank-you screen. Keep it under 4 minutes of effort.

### 5. `POST /review/:id/feedback`
Body `{ rating, comments, participantId? }`. Append ReviewFeedback (see ARCHITECTURE.md shape, add `submittedAt`) to `../feedback/{id}.json` (create dir/file if missing, read-modify-write array). Agent's poller reads this file.

### 6. `GET /media/:file`
`express.static('../output')` mounted at `/media`. Serves `final.mp4` to both Linq (media part fetch) and the review page. Sanitize: no path traversal (`path.basename` the param).

## Test gates (curl each before integrating)

```bash
# 1. send text to yourself
curl -X POST localhost:4000/send -H 'content-type: application/json' \
  -d '{"chatId":"+1YOURNUMBER","text":"jptr alive"}'
# 2. send sample video  ← DO THIS FIRST 30 MIN
curl -X POST localhost:4000/send -d '{"chatId":"+1YOURNUMBER","videoPath":"../output/final.mp4","caption":"test cut"}'
# 3. upload page: open $PUBLIC_URL/upload in phone browser, drop a clip, check ../clips/
# 4. review flow
curl $PUBLIC_URL/review/test123
curl -X POST localhost:4000/review/test123/feedback -d '{"rating":4,"comments":"nice"}'
cat ../feedback/test123.json
# 5. inbound: text the Linq number from your phone, watch server log show forward to :4001
```

## Env

```bash
LINQ_API_KEY=
LINQ_FROM_NUMBER=
PUBLIC_URL=          # cloudflared output
```

## Build order
1. Express skeleton + `/send` text (prove Linq key works) — 20 min
2. `/send` video media part test — **gate at T+30min**
3. Tunnel + webhook subscribe + `/webhook/linq` → :4001 forward — 30 min
4. `/media` static + `/upload` page — 30 min
5. `/review/:id` + feedback store — 30 min
