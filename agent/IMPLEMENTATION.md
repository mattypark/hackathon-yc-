# agent/ — Person 3 Technical Implementation

Owns the brain: intent parsing, orchestration, Terac human-in-the-loop client, demo script. Express on port **4001**. Endpoint map canonical in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Stack

```bash
cd agent
npm init -y
npm install express @anthropic-ai/sdk dotenv
```

Env: `ANTHROPIC_API_KEY`, `TERAC_API_KEY`, `PUBLIC_URL` (same tunnel as messaging).

## 1. `POST /handle` — core loop

Input from messaging: `{ chatId, text, from }`.

```js
// intent parse — Claude, cheap + fast
const msg = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 300,
  system: SYSTEM,           // below
  messages: [{ role: "user", content: text }],
});
```

System prompt (include verbatim):

```
You parse video-editing requests from iMessage into JSON. Output ONLY JSON:
{ "action": "cut_nontalking" | "status" | "review" | "unknown",
  "source": "drive" | "uploaded" | "unspecified",
  "marginSec": 0.2 }
"cut the non-talking parts / dead air / silence" → cut_nontalking.
"how's it going / done yet" → status. "get feedback / have editors look" → review.
Anything else → unknown.
```

Then:
1. `action === "cut_nontalking"` → build EditRequest:
   - clips already in `clips/` (drag-drop or previous run) → `{ clipsDir:"./clips", marginSec }`
   - else if `DRIVE_FOLDER_ID` env set → add `driveFolderId`
   - else reply asking user to share Drive folder to SA email or use upload link.
2. Spawn: `child_process.execFile("python3", ["../editor/cut.py", JSON.stringify(editRequest)])` — parse stdout JSON = EditResult.
3. `ok:true` → `POST localhost:4000/send { chatId, videoPath, caption: "done — cut to ${durationSec}s 🎬" }`, then kick `POST /terac/launch` (async, don't block reply).
4. `ok:false` → send apologetic text with error.
5. **Claude parse failure/unknown → HARDCODED FALLBACK**: treat as `cut_nontalking`, all clips, margin 0.2. Demo never dies on parsing.

Session start (on boot or first message from new chatId): send onboarding text via `/send`:

```
hey! i'm jptr 🎬 two ways to give me clips:
1. share a Drive folder with jptr-editor@<project>.iam.gserviceaccount.com
2. drag & drop here: ${PUBLIC_URL}/upload
then text me what you want — e.g. "cut all the non-talking parts"
```

## 2. `agent/terac.js` — human-in-the-loop client

Base `https://terac.com/api/external/v2`, header `Authorization: Bearer ${TERAC_API_KEY}`. **Poll-only — no webhooks exist.**

```js
// once, cache id in terac-project.json
POST /projects { "name": "jptr edit review" }

// per edited video
POST /opportunities {
  "title": "Rate a 60-second auto-edited salon clip",
  "project_id": PROJECT_ID,
  "num_participants": 3,
  "business_type": "b2c",
  "description": "Watch a short auto-edited video and give a rating + one suggestion. ~4 minutes.",
  "filters": [ { "multi_select--job_function": { "$in": JOB_FUNCTION_VALUES } } ],
  "screening_questions": [ {
    "key": "edits_video",
    "text": "Do you edit or post short-form video at least weekly?",
    "pick": "one",
    "answers": [ { "text": "Yes", "qualify_logic": "must" },
                 { "text": "No",  "qualify_logic": "reject" } ] } ],
  "tasks": [ { "sequence": 1, "task_type": "survey", "review_type": "auto_approve",
               "task_url": `${PUBLIC_URL}/review/${oppLocalId}`, "duration_minutes": 4 } ]
}
POST /opportunities/{id}/launch   // no body
```

**Before first launch** — enumerate real filter values (docs don't list them):

```bash
curl -H "Authorization: Bearer $TERAC_API_KEY" https://terac.com/api/external/v2/filters
curl -H "Authorization: Bearer $TERAC_API_KEY" "https://terac.com/api/external/v2/filters/multi_select--job_function/options"
```

Pick editor/creator-adjacent values (design/media/marketing roles) → `JOB_FUNCTION_VALUES`. If nothing fits, drop the filter and rely on the screening question alone.

### Poll loop (per launched opp)

```js
setInterval(async () => {
  const subs = await GET(`/opportunities/${oppId}/submissions?status=approved`); // + awaiting_review
  const local = readJson(`../feedback/${oppLocalId}.json`) ?? [];  // review-page ratings
  if (local.length >= 3 || elapsedMin > 45) {
    clearInterval(...);
    const summary = await claudeSummarize(local);   // avg rating + best quotes, 2 sentences
    await POST("localhost:4000/send", { chatId,
      text: `🧑‍🎨 ${local.length} human editors reviewed your cut — ${avg}/5.\n"${quotes[0]}"\n"${quotes[1] ?? ""}"` });
  }
}, 60_000);   // rate limit 100/min — 60s is safe
```

Substantive feedback comes from OUR review page (`feedback/*.json`, written by messaging `POST /review/:id/feedback`) — Terac's own submission objects only carry screening answers + status. Join on participant where possible; don't block on it.

### `POST /terac/launch` + `GET /terac/status/:oppId`
- launch: `{ videoPath, chatId }` → flow above → returns `{ oppId, dashboardHint }`.
- status: returns poll state + collected feedback — open this for judges alongside the Terac dashboard.

## 3. Premiere garnish (ONLY if core loop done by T-90min)

- `npm i -g premiere-pro-mcp && premiere-pro-mcp --install-cep` → open Premiere → MCP Bridge panel "Running".
- Import `editor/output/timeline.xml` (auto-editor `--export premiere`) onto a timeline for the wow shot.
- Flaky (CEP/ExtendScript IPC) — never in the demo critical path. Manual XML import into Premiere is the backup wow shot.

## 4. Demo script (rehearse 2x)

1. Phone on screen. Text the Linq number: *"hey, i have 4 clips from yesterday at a salon, can you cut all the non-talking parts?"*
2. Narrate pipeline logs (webhook → intent → Drive pull → auto-editor).
3. Video arrives back in the thread. Play it.
4. *"and real human editors are reviewing it right now"* → show Terac dashboard + `/terac/status` → show (pre-collected if needed) feedback text arriving in iMessage.
5. Optional: Premiere timeline opens.

## Booth-confirm list (ask Terac table early)
- Exact `task_type` / `review_type` enum values (docs show `"interview"`; we assume `"survey"` exists).
- Completion-code handshake for custom task_url pages — does auto_approve bypass it?
- Available `job_function` option values for editor/creator targeting.
- How the $250 credit applies + realistic response time today.
