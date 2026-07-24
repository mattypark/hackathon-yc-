/*
 * dev-mock.js: mock messaging service (:4000) for testing agent/server.js in isolation.
 *
 * Standalone test walkthrough:
 * 1. node agent/dev-mock.js
 * 2. POSIX:      MOCK_TERAC=1 MOCK_EDITOR=1 MOCK_LLM=1 TERAC_POLL_MS=3000 node agent/server.js
 *    PowerShell: $env:MOCK_TERAC="1"; $env:MOCK_EDITOR="1"; $env:MOCK_LLM="1"; $env:TERAC_POLL_MS="3000"; node agent/server.js
 * 3. curl -X POST localhost:4001/handle -H "Content-Type: application/json" -d '{"chatId":"test","text":"cut the non-talking parts","from":"+15550100"}'
 * 4. curl -X POST localhost:4000/mock/feedback/<localId printed in agent logs>
 * 5. Watch the [MOCK iMESSAGE OUT] lines for the video send and then the review summary.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Log every request the agent makes so nothing is invisible.
app.use((req, res, next) => {
  console.log(`[MOCK ${req.method}] ${req.path}`, req.body && Object.keys(req.body).length ? req.body : "");
  next();
});

// POST /send: what messaging would receive from the agent — print it clearly.
app.post("/send", (req, res) => {
  const { chatId, text, videoPath, caption } = req.body || {};
  console.log(`
[MOCK iMESSAGE OUT] ---------------------------------
  chatId:    ${chatId}
  text:      ${text || "(none)"}
  videoPath: ${videoPath || "(none)"}
  caption:   ${caption || "(none)"}
-----------------------------------------------------
`);
  res.json({ ok: true });
});

// POST /mock/feedback/:localId: write 3 fake reviews to feedback/{localId}.json
// at the repo root (terac.js reads path.join(__dirname, "..", "feedback", ...)
// relative to agent/, so this must resolve to the same place).
app.post("/mock/feedback/:localId", (req, res) => {
  const { localId } = req.params;
  const feedbackDir = path.join(__dirname, "..", "feedback");
  fs.mkdirSync(feedbackDir, { recursive: true });

  const reviews = [
    { oppId: localId, participantId: "p_1", rating: 5, comments: "tighten the intro", submittedAt: new Date().toISOString() },
    { oppId: localId, participantId: "p_2", rating: 4, comments: "great pacing", submittedAt: new Date().toISOString() },
    { oppId: localId, participantId: "p_3", rating: 4, comments: "", submittedAt: new Date().toISOString() },
  ];

  const feedbackFile = path.join(feedbackDir, `${localId}.json`);
  fs.writeFileSync(feedbackFile, JSON.stringify(reviews, null, 2));
  console.log(`[MOCK FEEDBACK] wrote 3 reviews to ${feedbackFile}`);
  res.json({ ok: true });
});

// Catch-all for anything unhandled.
app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

app.listen(4000, () => console.log("[MOCK MESSAGING] listening on :4000"));
