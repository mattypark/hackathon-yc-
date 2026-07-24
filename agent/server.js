require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const llm = require("./llm");
const demo = require("./demo");
// ponytail: terac.js is a teammate's file; stub it so the demo boots before it lands.
let terac;
try {
  terac = require("./terac");
} catch (e) {
  console.log("terac.js missing — using stub", e.message);
  terac = {
    launchReview: async () => ({ oppId: null, localId: null, dashboardHint: "terac.js not wired yet" }),
    getStatus: () => ({ error: "terac.js not wired yet" }),
  };
}

const MESSAGING_URL = process.env.MESSAGING_URL || "http://localhost:4000";
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const ROOT = path.join(__dirname, "..");
const CLIPS_DIR = path.join(ROOT, "clips");
const EDITOR_TIMEOUT_MS = 30 * 60 * 1000; // 4K clips take a while
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);

// chatId -> { driveFolderId, lastVideoPath, greeted, pendingEdit, history: [{role, content}] }
const sessions = {};

const SYSTEM = `You are jptr — a sharp, fun creative video editor people text over iMessage.
Personality: enthusiastic collaborator, talks like a friend who happens to be a pro editor.
Short punchy texts (1-2 sentences), lowercase-casual, an emoji here and there, never corporate.

What you can ACTUALLY do (never promise more):
- pull clips from a Google Drive folder the user links (or they upload at the upload link)
- cut out the non-talking parts / dead air / silence, with adjustable breathing room
- concat everything into one final video and text it back
- get real human editors to review the cut ("get feedback")

Each user message comes with a CONTEXT line telling you if footage is available.
Parse the message and reply with ONLY JSON:
{
  "action": "chat" | "edit" | "status" | "review",
  "reply": "<the exact iMessage to send back — ALWAYS required, in your voice>",
  "marginSec": 0.2,        // breathing room: "tight/snappy" -> 0.1, default 0.2, "relaxed/breathing room" -> 0.4
  "audioThreshold": null   // noisy footage ("music playing", "loud", "salon/bar") -> 0.04, else null
}
Rules:
- editing/cutting/trimming/removing silence intent -> action "edit".
  - if CONTEXT says footage available: reply = a fun "on it" ack that sets expectations.
  - if NOT: reply must ask for their Drive folder link (shared "anyone with link") or the upload page.
- "how's it going / done yet" -> "status". "get feedback / human review" -> "review".
- everything else -> "chat": be genuinely conversational, riff on what they said, and if natural,
  steer toward what you can do. Never repeat the same intro twice — vary it using the conversation history.`;

// ------------------------------------------------------------------ helpers

function extractFolderId(text) {
  const m = String(text || "").match(/drive\.google\.com\/drive\/folders\/([\w-]+)/);
  return m ? m[1] : null;
}

// Footage is session-scoped: only a Drive link THIS chat sent, or clips THIS
// chat uploaded, count. Stale files in clips/ never trigger an edit.
function hasFootage(session) {
  return Boolean(session.driveFolderId || session.clipsUploaded);
}

function uploadHint(chatId) {
  if (!PUBLIC_URL) return "the upload page (ask us for the link)";
  return `${PUBLIC_URL}/upload${chatId ? `?chat=${encodeURIComponent(chatId)}` : ""}`;
}

// No-LLM fallback: keyword routing + canned replies keeps the thread alive.
function keywordIntent(text, footageAvailable, chatId) {
  const t = (text || "").toLowerCase();
  if (/\b(status|progress|done yet|how'?s it going)\b/.test(t)) return { action: "status", reply: "" };
  if (/\b(review|feedback|human editors?)\b/.test(t)) return { action: "review", reply: "" };
  if (/\b(cut|edit|trim|clips?|videos?|footage|silence|dead air|non.?talking|drive)\b/.test(t)) {
    return {
      action: "edit",
      marginSec: 0.2,
      reply: footageAvailable
        ? "on it 🎬 — pulling your clips and cutting the dead air. finished video lands here."
        : `love it — where's the footage? text me your Google Drive folder link (shared "anyone with link"), or drop the files here: ${uploadHint(chatId)}`,
    };
  }
  return {
    action: "chat",
    reply: `hey! i'm jptr 🎬 — your video editor over text. send me a Drive folder link and say "cut the non-talking parts" and i'll send back the finished cut.`,
  };
}

async function parseIntent(text, session, chatId) {
  const footageAvailable = hasFootage(session);
  try {
    const raw = await llm.complete({
      system: SYSTEM,
      history: session.history.slice(-10),
      user: `CONTEXT: footage ${footageAvailable ? "IS" : "is NOT"} available. upload page: ${uploadHint(chatId)}\n\n${text}`,
    });
    const intent = JSON.parse(raw.replace(/```(json)?/g, "").trim());
    if (!intent.action || !intent.reply) return keywordIntent(text, footageAvailable, chatId);
    return intent;
  } catch (e) {
    console.log("intent parse failed, using keyword fallback:", e.message);
    return keywordIntent(text, footageAvailable, chatId);
  }
}

async function sendToMessaging(payload) {
  console.log("send →", payload);
  try {
    const res = await fetch(`${MESSAGING_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("send failed", res.status, await res.text());
  } catch (e) {
    console.error("send failed", e.message);
  }
}

// ------------------------------------------------------------------- editor

const ERROR_REPLIES = {
  NOT_SHARED: () =>
    `hmm, i can't see that folder — flip it to "anyone with link" in Drive sharing and send it again 🙏`,
  EMPTY_FOLDER: () => `that folder's empty (no videos anyway) — drop your clips in and resend the link`,
  NO_CREDENTIALS: () => `having a moment with Drive auth — make the folder "anyone with link" and resend?`,
  DOWNLOAD_FAILED: () => `Drive hiccuped mid-download — send the link once more and i'll retry`,
};

function runEditor(editRequest) {
  if (process.env.MOCK_EDITOR === "1") {
    return new Promise((r) =>
      setTimeout(() => r({ ok: true, videoPath: "./output/final.mp4", durationSec: 42 }), 1000)
    );
  }
  return new Promise((resolve) => {
    execFile(
      PYTHON_BIN,
      [path.join(ROOT, "editor", "cut.py"), JSON.stringify(editRequest)],
      { cwd: ROOT, timeout: EDITOR_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        try {
          resolve(JSON.parse(stdout.trim().split("\n").pop()));
        } catch {
          resolve({ ok: false, error: err?.message ?? "editor produced no JSON", code: "ERROR" });
        }
      }
    );
  });
}

async function runEdit(chatId, session, intent) {
  const editRequest = { clipsDir: "./clips", marginSec: intent.marginSec ?? 0.2 };
  if (intent.audioThreshold) editRequest.audioThreshold = intent.audioThreshold;
  if (session.driveFolderId) {
    // Fresh per-chat dir for Drive pulls — stale files never join the cut.
    const driveDir = `./clips/drive-${chatId.slice(0, 8)}`;
    fs.rmSync(path.join(ROOT, driveDir), { recursive: true, force: true });
    editRequest.clipsDir = driveDir;
    // public-link path (gdown) — zero-setup; SA path kicks in when sa-key.json exists
    editRequest.driveUrl = `https://drive.google.com/drive/folders/${session.driveFolderId}`;
  }
  console.log("edit →", editRequest);
  session.editing = true;
  try {
    const result = await runEditor(editRequest);
    if (!result.ok) {
      console.error("edit failed", result);
      const reply =
        ERROR_REPLIES[result.code]?.() ??
        `hit a snag mid-edit (${String(result.error || "unknown").slice(0, 120)}) — try me again?`;
      return sendToMessaging({ chatId, text: reply });
    }
    session.lastVideoPath = result.videoPath;
    await sendToMessaging({
      chatId,
      videoPath: result.videoPath,
      caption: `done — cut it down to ${result.durationSec}s 🎬 want real human editors to rate it? just say "get feedback"`,
    });
    showInPremiere();
  } finally {
    session.editing = false;
  }
}

// Surface the cut in Premiere Pro (MCP Bridge panel must be Running).
// Non-fatal — demo garnish, never blocks the reply.
function showInPremiere() {
  const send = path.join(ROOT, "premiere", "send-jsx.sh");
  execFile(send, [path.join(ROOT, "premiere", "import-cut.jsx")], { cwd: ROOT }, (err) => {
    if (err) return console.log("[premiere] import skipped:", err.message);
    execFile(send, [path.join(ROOT, "premiere", "open-cut.jsx")], { cwd: ROOT }, (err2, stdout) => {
      console.log("[premiere]", err2 ? `open skipped: ${err2.message}` : String(stdout).trim());
    });
  });
}

// -------------------------------------------------------------------- routes

const app = express();
app.use(express.json());

app.post("/handle", async (req, res) => {
  const { chatId, text } = req.body || {};
  console.log("webhook →", req.body);
  if (!chatId) return res.status(400).json({ ok: false, error: "chatId required" });

  // Scripted demo: trigger word, or DEMO_MODE=1 forces it for edit-looking texts.
  const wantsEdit = /edit|cut|non.?talking|dead air/i.test(text || "");
  if (/jptr demo/i.test(text || "") || (process.env.DEMO_MODE === "1" && wantsEdit)) {
    res.json({ ok: true, demo: true });
    demo.run(chatId, sendToMessaging).catch(console.error);
    return;
  }

  res.json({ ok: true }); // ack fast, work async
  const session = (sessions[chatId] ??= { history: [] });

  // Trust regex over the model for folder ids; a bare link also unblocks a pending edit.
  const folderId = extractFolderId(text);
  if (folderId) session.driveFolderId = folderId;

  const intent = await parseIntent(text || "", session, chatId);
  console.log("intent →", intent);
  session.history.push({ role: "user", content: text || "" });
  session.history.push({ role: "assistant", content: intent.reply || intent.action });
  if (session.history.length > 20) session.history.splice(0, session.history.length - 20);

  const footageAvailable = hasFootage(session);

  // A fresh Drive link while an edit was waiting = green light, whatever the intent.
  if (folderId && session.pendingEdit) {
    if (session.editing) {
      return sendToMessaging({ chatId, text: "already cutting — hang tight, video's coming ✂️" });
    }
    const pending = session.pendingEdit;
    session.pendingEdit = null;
    await sendToMessaging({ chatId, text: "got the folder 📂 — on it, cutting the dead air now ✂️" });
    return runEdit(chatId, session, pending);
  }

  switch (intent.action) {
    case "status":
      return sendToMessaging({
        chatId,
        text: session.editing
          ? "still cutting your video ✂️ — almost there"
          : session.lastVideoPath
            ? "your cut's done — sent it above ☝️"
            : "nothing cooking yet — send me a Drive link or clips and say the word 🎬",
      });

    case "review": {
      if (!session.lastVideoPath) {
        return sendToMessaging({ chatId, text: "nothing to review yet — send me clips first!" });
      }
      terac.launchReview({ videoPath: session.lastVideoPath, chatId }).catch(console.error);
      return sendToMessaging({
        chatId,
        text: "on it — recruiting real human editors to review your cut 🧑‍🎨 feedback lands here",
      });
    }

    case "edit": {
      if (session.editing) {
        return sendToMessaging({ chatId, text: "already cutting — hang tight, video's coming ✂️" });
      }
      if (!footageAvailable) {
        session.pendingEdit = { marginSec: intent.marginSec ?? 0.2, audioThreshold: intent.audioThreshold };
        return sendToMessaging({ chatId, text: intent.reply });
      }
      await sendToMessaging({ chatId, text: intent.reply });
      return runEdit(chatId, session, intent);
    }

    default:
      return sendToMessaging({ chatId, text: intent.reply });
  }
});

// Messaging calls this after a chat-scoped drag-drop upload.
app.post("/uploaded", async (req, res) => {
  const { chatId, count } = req.body || {};
  if (!chatId) return res.status(400).json({ ok: false, error: "chatId required" });
  const session = (sessions[chatId] ??= { history: [] });
  session.clipsUploaded = true;
  res.json({ ok: true });
  if (session.editing) {
    return sendToMessaging({ chatId, text: "already cutting — hang tight, video's coming ✂️" });
  }
  if (session.pendingEdit) {
    const pending = session.pendingEdit;
    session.pendingEdit = null;
    await sendToMessaging({
      chatId,
      text: `got ${count || "your"} clip(s) 📂 — on it, cutting the dead air now ✂️`,
    });
    return runEdit(chatId, session, pending);
  }
  return sendToMessaging({
    chatId,
    text: `got ${count || "your"} clip(s) ✅ — say the word and i'll cut the dead air`,
  });
});

app.post("/terac/launch", async (req, res) => {
  const { videoPath, chatId } = req.body || {};
  try {
    res.json(await terac.launchReview({ videoPath, chatId }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/terac/status/:oppId", (req, res) => {
  res.json(terac.getStatus(req.params.oppId));
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "jptr-agent" }));

app.listen(4001, () => {
  console.log("agent listening on :4001");
  if (!process.env.RUNWARE_API_KEY) console.warn("[boot] RUNWARE_API_KEY missing — keyword fallback active");
  if (process.env.MOCK_EDITOR === "1") console.warn("[boot] MOCK_EDITOR=1 — edits return the seeded demo video");
});
