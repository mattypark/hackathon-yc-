# agent/ — Person 3 (orchestrator + Terac human-in-the-loop)

Express on **:4001**. Contracts frozen in [../CONTRACT.md](../CONTRACT.md); build spec in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Status: BUILT + smoke-tested via MOCKS (2026-07-24)

The full loop was verified standalone with a mock harness — **not yet against the real Terac API, real Runware key, or teammates' services**:

- `/handle` → intent parse (fallback works) → mock editor → `POST :4000/send` with `{videoPath, caption: "done — cut to 42s 🎬"}` ✅
- `/terac/launch` → mock opportunity created with `task_url = ${PUBLIC_URL}/review/<localId>` → poll loop picked up 3 simulated reviews → sent `🧑‍🎨 3 human editors reviewed your cut — 4.3/5` + quotes ✅
- `/terac/status/:id` → `{feedbackCount: 3, done: true, summarySent: true}` ✅

## Files

| File | What |
|---|---|
| `server.js` | :4001 — `POST /handle`, `POST /terac/launch`, `GET /terac/status/:id`. Spawns `python3 ../editor/cut.py '<EditRequest JSON>'`; hardcoded fallback intent so the demo never dies on parsing |
| `llm.js` | Runware LLM client (OpenAI-compatible, `anthropic:claude@sonnet-4-6`) for intent parse + feedback summary |
| `terac.js` | Terac v2 client: project cached in `terac-project.json`, create+launch opportunity, 60s submissions poll + reads `../feedback/{localId}.json`, LLM summary → `/send` |
| `dev-mock.js` | Test-only stand-in for messaging :4000 (logs `/send` payloads, injects fake reviewer feedback). Never run in the demo |
| `.env.example` | Copy to `.env`, fill keys |

## Setup

```bash
cd agent && npm install
cp .env.example .env   # fill RUNWARE_API_KEY, TERAC_API_KEY, PUBLIC_URL (Person 1's tunnel)
node server.js
```

## Standalone test (no teammates / no keys needed)

```bash
node dev-mock.js                                              # terminal 1
MOCK_TERAC=1 MOCK_EDITOR=1 MOCK_LLM=1 TERAC_POLL_MS=3000 node server.js   # terminal 2
curl -X POST localhost:4001/handle -H "Content-Type: application/json" \
  -d '{"chatId":"test","text":"cut the non-talking parts","from":"+15550100"}'
curl -X POST localhost:4000/mock/feedback/<localId from agent logs>
# watch the [MOCK iMESSAGE OUT] banners in terminal 1
```

(PowerShell: `$env:MOCK_TERAC="1"; ...` — full walkthrough in the header of `dev-mock.js`.)

## ⚠️ Person 1 (messaging) needs to know

1. **Review page keys on `localId`, not the Terac oppId.** The `task_url` Terac sends humans to is `${PUBLIC_URL}/review/<localId>`. Your `POST /review/:id/feedback` must persist to **`feedback/<localId>.json`** at the repo root as a JSON **array** of `{oppId, participantId, rating, comments, submittedAt}` — that exact file is what my poll loop reads.
2. **The video is never uploaded to Terac.** Reviewers watch it on your review page via `GET /media/final.mp4` — that route must work from the public tunnel.
3. My replies to you are exactly the CONTRACT.md `/send` shape: `{chatId, videoPath?, caption?}` for the edited video, `{chatId, text}` for status/summary messages.
4. Forward inbound messages to me as `POST localhost:4001/handle` `{chatId, text, from}` (per CONTRACT.md).

## Person 2 (editor) needs to know

- I call `python3 editor/cut.py '<EditRequest JSON>'` from the **repo root** (override interpreter with `PYTHON_BIN`), expect EditResult JSON on stdout per CONTRACT.md.

## Things to know / booth-confirm at Terac

- Real API verified from live docs: base `https://terac.com/api/external/v2`, `Authorization: Bearer`, 100 req/min, `POST /opportunities` + `POST /opportunities/{id}/launch`, `GET /opportunities/{id}/submissions?status=approved`.
- **`task_type: "survey"` is unconfirmed** (docs example only shows `"interview"`). If create 4xxs, set `TERAC_TASK_TYPE=interview` in `.env`.
- `expected_days_to_complete` minimum is **5 days** → human responses take hours/days. Launch the real opportunity 1–2h before judging; keep a pre-collected run as backup.
- No `filters` sent yet — screening question only; add `job_function` values after enumerating `GET /filters/.../options` at the booth.
- Substantive feedback comes from OUR review page file, not Terac submissions (those only carry screening answers/status).
- Premiere garnish: skipped (non-critical); manual `timeline.xml` import into Premiere is the backup wow shot.
