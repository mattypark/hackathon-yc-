# jptr — iMessage → Video Editing Agent

**Hackathon plan. 4 hours. 3 people. Zero merge conflicts by design.**

Text an iMessage ("hey, I have 4 clips from yesterday at a salon, cut all the non-talking clips") → agent grabs the clips → auto-cuts the non-talking parts → texts the edited video back in the same thread.

---

## Validated Stack (researched, not vibes)

| Layer | Tool | Why |
|---|---|---|
| iMessage I/O | **Linq API v3** ([docs.linqapp.com](https://docs.linqapp.com/)) | `POST https://api.linqapp.com/api/partner/v3/chats` sends text + media parts (video reply); `POST /webhook-subscriptions` for `message.received`. Node SDK: `@linqapp/sdk`. Key in hand. Tunnel via ngrok/cloudflared. |
| Cut engine | **auto-editor** (`pip install auto-editor`) | `auto-editor clip.mp4 --margin 0.2sec -o cut.mp4` = the entire "remove non-talking" feature in one command. ffmpeg concat for multi-clip. Also `--export premiere` generates a Premiere timeline. |
| Premiere garnish | **[premiere-pro-mcp](https://github.com/leancoderkavy/premiere-pro-mcp)** | 269 tools, opens real Premiere timeline of the cut for the wow shot. NOT critical path (CEP/ExtendScript setup is 30–60min + flaky). Only wire if core loop works by T-90min. |
| Clips | Local `./clips` folder ("synced from Drive" narrative) | Zero OAuth time sink. frame.io only if spare time. |
| Brain | Claude API | Parses intent from the text ("cut non-talking", which clips) → pipeline params. Hardcoded fallback if parse fails. |

**Note on Terac:** it is NOT a video/planning tool — it's a human-feedback/research API (hackathon sponsor, $250 credit/team). Optional sponsor-prize angle: recruit humans to rate edit quality. Skip unless chasing that prize.

**Fallback if Linq stalls:** [imsg-plus](https://github.com/micahbrich/imsg-plus) — local Mac Messages.app CLI. `watch --json` to receive, `send --file video.mp4` to reply. ~15min setup, needs Full Disk Access.

---

## Repo Layout — no-merge design

```
jptr/
├── README.md
├── CONTRACT.md           ← frozen after kickoff; the ONLY shared doc
├── messaging/            ← Person 1 ONLY
│   └── server.js         (Express: Linq webhook receive + send video reply)
├── editor/               ← Person 2 ONLY
│   └── cut.py            (auto-editor + ffmpeg concat: clips/ → output/final.mp4)
├── agent/                ← Person 3 ONLY
│   └── orchestrate.js    (Claude intent parse → run editor → hand video to messaging)
├── clips/                (gitignored demo footage)
└── output/               (gitignored)
```

**Rule: each person commits/pushes ONLY their folder, straight to `main`. Disjoint folders = no conflicts. `git pull --rebase && git push`.**

## CONTRACT.md — the 2 JSON shapes (freeze at kickoff)

```json
// EditRequest (agent → editor)
{ "clipsDir": "./clips", "instruction": "cut non-talking", "marginSec": 0.2 }

// EditResult (editor → agent → messaging)
{ "ok": true, "videoPath": "./output/final.mp4", "durationSec": 42 }
```

Messaging exposes one function: `sendVideo(chatId, videoPath, caption)`.

---

## Person Split

### Person 1 — Messaging (`/messaging`)
1. Express server + cloudflared/ngrok tunnel.
2. Subscribe webhook: `POST /webhook-subscriptions` → `message.received` (HMAC verify via SDK `webhooks.unwrap`, needs RAW body).
3. Inbound text → forward to agent (`POST localhost:4001/handle`).
4. `sendVideo`: static-serve `output/final.mp4` over the tunnel → Linq media part + text reply.
5. **#1 unknown = video media-part format. Test sending a sample mp4 in the FIRST 30 MINUTES.**

### Person 2 — Editor (`/editor`)
1. `pip install auto-editor` (bundles ffmpeg). Drop 4 test clips in `clips/`.
2. Script: loop clips → `auto-editor <clip> --margin 0.2sec -o cut_<n>.mp4` → ffmpeg concat → `output/final.mp4`. Print EditResult JSON.
3. Emit `--export premiere` XML for Person 3's garnish.
4. Test on REAL salon-style footage early — noisy audio may need `--edit audio:threshold=...` tuning.

### Person 3 — Agent + Demo (`/agent`)
1. Orchestrator server on `:4001/handle` — Claude API parses text → spawns editor → on EditResult calls `sendVideo`.
2. Hardcoded happy path if Claude parse fails: "cut non-talking, all clips."
3. Garnish (ONLY if core loop works by T-90min): premiere-pro-mcp CEP install, open the auto-editor Premiere XML on screen.
4. Owns demo: full run start→finish (text sent → video arrives in thread). Rehearse twice.

---

## Timeline gates

- **T+30min:** Linq round-trip proven (webhook fires, sample video sends).
- **T+90min:** full loop — text in → `final.mp4` back in iMessage thread.
- **T-45min:** freeze features, rehearse demo x2 with fresh clips.

## Risks (ranked)

1. **Linq video media-part send** — untested. Mitigate first 30min. Fallback: imsg-plus.
2. Webhook tunnel + HMAC — use SDK unwrap + raw-body middleware.
3. auto-editor threshold on noisy salon audio — test real footage early.
4. Premiere MCP flakiness — already demoted to garnish.
