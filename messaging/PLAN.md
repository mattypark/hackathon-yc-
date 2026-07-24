# messaging/ — Execution Plan (Person 1)

**Source of truth: [IMPLEMENTATION.md](IMPLEMENTATION.md) + [../ARCHITECTURE.md](../ARCHITECTURE.md).** This doc is the working plan for building it, plus the answers to the open questions IMPLEMENTATION.md flagged (verified against docs.linqapp.com, Jul 2026).

## Verified answers to IMPLEMENTATION.md's open questions

IMPLEMENTATION.md line 45 says *"⚠ verify exact media-part shape"* and line 48 says *"check SDK"* for existing-chat sends. Verified:

1. **Video media parts: URL-based sends are capped at 10MB.** `{ type: "media", url: PUBLIC_URL/media/... }` will be rejected for any real multi-clip cut. The supported path for large files (up to **100MB**, hard cap) is the pre-upload flow:
   - `POST /v3/attachments` `{ filename, content_type: "video/mp4", size_bytes }` → returns presigned `upload_url` (expires 15 min), `required_headers`, permanent `attachment_id`
   - `PUT` raw bytes to `upload_url` with exactly `required_headers`
   - send `{ type: "media", attachment_id }`
   - So `/send` uses pre-upload as primary; `PUBLIC_URL/media/` link-as-text stays as the fallback exactly as IMPLEMENTATION.md specifies. `GET /media/:file` is still required regardless — the Terac review page uses it as the `<video>` src.
2. **Replying in-thread**: the webhook payload carries a real `chat_id` → reply via `POST /v3/chats/{chatId}/messages`. `POST /v3/chats` (`client.chats.create`) is only for cold-starting a chat from a phone number. `/send` handles both: `chatId` starting with `+` → create-chat path; otherwise → existing-chat path.
3. **Webhook verification needs `LINQ_WEBHOOK_SECRET`** (the `whsec_...` returned once when the subscription is created). Not in ARCHITECTURE's env list yet — added here. Consequence: don't blindly re-create the subscription on every boot or the secret rotates; `subscribe.js` is a run-once script (re-run only when the tunnel URL changes, then update `.env`).
4. **Delivery is at-least-once** (10 retries / ~25 min on 5xx/timeout): dedupe inbound events on the `webhook-id` header or one text triggers multiple edit runs. Reply 200 immediately, process async (already in IMPLEMENTATION.md).
5. **>100MB guard**: before upload, if the file exceeds ~95MB, transcode with ffmpeg (H.264, bitrate computed from duration) — auto-editor bundles ffmpeg so it's present.
6. Extras that cost nothing: `idempotency_key` on sends (no double-texts on agent retries), pin webhook payload version via `?version=2026-02-03`, confetti `effect` on the final video reply.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express :4000 — all 6 routes from ARCHITECTURE.md endpoint map |
| `linq.js` | Linq helpers: `sendText`, `sendVideo` (pre-upload flow + size guard + fallback) |
| `subscribe.js` | Run-once: create webhook subscription for `PUBLIC_URL/webhook/linq`, print `whsec_` secret |
| `test-send.js` | T+30 gate: text + sample video to your own phone, standalone |
| `env.example` | Copy to `.env` (note: `.env.*` is gitignored, hence the name) |

## Routes (per ARCHITECTURE.md — unchanged)

- `POST /webhook/linq` — raw-body route, `webhooks.unwrap`, dedupe by `webhook-id`, 200 fast, forward `{chatId, text, from}` → `POST :4001/handle`. Skips events with no text (media-only) and non-`message.received` events.
- `POST /send` — `{ chatId, text?, videoPath?, caption? }` → text-only or caption+video (pre-upload). Returns `{ ok, messageId }`.
- `GET /upload` / `POST /upload` — drag-drop page → multer → `../clips/` (.mp4/.mov/.m4v only, 500MB cap).
- `GET /review/:id` / `POST /review/:id/feedback` — Terac reviewer page → append to `../feedback/{id}.json`.
- `GET /media/:file` — static `../output/` (review page video src; also the send-fallback link target).

## Build order (= IMPLEMENTATION.md's, with the send mechanism corrected)

1. Skeleton + `/send` text-only → prove the key works (~20 min)
2. `/send` video via pre-upload → **T+30 gate** (`test-send.js` with a >10MB sample proves the real thing)
3. Tunnel + `subscribe.js` + `/webhook/linq` → forward to :4001 (~30 min)
4. `/media` static + `/upload` page (~30 min)
5. `/review/:id` + feedback store (~30 min)

## Env (`env.example`)

```bash
LINQ_API_KEY=            # bearer, in hand
LINQ_FROM_NUMBER=        # provisioned +1 number
LINQ_WEBHOOK_SECRET=     # printed by subscribe.js after tunnel is up
PUBLIC_URL=              # cloudflared output
AGENT_URL=http://localhost:4001/handle
PORT=4000
```

## Test gates

Same five curl gates as IMPLEMENTATION.md §Test gates, with #2 (sample video) executed via `node test-send.js <path-to-mp4>` against a **>10MB** file so the pre-upload path is what gets proven at T+30.
