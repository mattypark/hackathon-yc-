require("dotenv").config({ path: __dirname + "/.env" });
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const llm = require("./llm");
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

const SYSTEM = `You are jptr, a friendly video-editing agent people text over iMessage.
Parse each message into JSON. Output ONLY JSON:
{ "action": "chat" | "cut_nontalking" | "status" | "review",
  "reply": "short friendly reply, REQUIRED when action is chat",
  "source": "drive" | "uploaded" | "unspecified",
  "marginSec": 0.2 }
Anything about editing/cutting/trimming videos, removing silence/dead air/non-talking
parts, or their clips/Drive footage → cut_nontalking.
"how's it going / done yet" → status. "get feedback / have editors look" → review.
Everything else (greetings, questions, small talk) → chat, with a warm 1-2 sentence
"reply" that mentions you can auto-edit videos from their Google Drive if relevant.`;

// No-LLM fallback: keyword routing + canned replies keeps the thread conversational.
function keywordIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(status|progress|done yet|how'?s it going)\b/.test(t)) return { action: "status" };
  if (/\b(review|feedback|human editors?)\b/.test(t)) return { action: "review" };
  if (/\b(cut|edit|trim|clips?|videos?|footage|silence|dead air|non.?talking|drive)\b/.test(t))
    return { action: "cut_nontalking", source: "unspecified", marginSec: 0.2 };
  return {
    action: "chat",
    reply:
      "hey! I'm jptr 🎬 — text me something like \"cut the non-talking parts from my clips\" and I'll grab the footage from your Google Drive, edit it, and send the video back here.",
  };
}

const app = express();
app.use(express.json());

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

async function parseIntent(text) {
  try {
    const raw = await llm.complete({ system: SYSTEM, user: text });
    const intent = JSON.parse(raw.replace(/```(json)?/g, "").trim());
    if (!intent.action || intent.action === "unknown") return keywordIntent(text);
    return intent;
  } catch (e) {
    console.log("intent parse failed, using keyword fallback:", e.message);
    return keywordIntent(text);
  }
}

function runEditor(editRequest) {
  if (process.env.MOCK_EDITOR === "1") {
    // ponytail: editor cut.py lives on teammate's machine; mock until integration
    return new Promise((r) =>
      setTimeout(() => r({ ok: true, videoPath: "./output/final.mp4", durationSec: 42 }), 1000)
    );
  }
  const root = path.join(__dirname, "..");
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(root, "editor", "cut.py"), JSON.stringify(editRequest)],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`bad EditResult: ${stdout}`));
        }
      }
    );
  });
}

async function runEdit(chatId, editRequest) {
  try {
    console.log("edit →", editRequest);
    const result = await runEditor(editRequest);
    if (!result.ok) throw new Error(result.error || "unknown editor error");
    await sendToMessaging({
      chatId,
      videoPath: result.videoPath,
      caption: `done — cut to ${result.durationSec}s 🎬`,
    });
    console.log("terac → launching review for", result.videoPath);
    terac.launchReview({ videoPath: result.videoPath, chatId }).catch(console.error);
  } catch (err) {
    console.error("edit failed", err);
    await sendToMessaging({ chatId, text: `sorry, editing failed: ${err.message || err}` });
  }
}

app.post("/handle", async (req, res) => {
  const { chatId, text } = req.body || {};
  console.log("webhook →", req.body);
  const intent = await parseIntent(text || "");
  console.log("intent →", intent);

  if (intent.action === "chat") {
    await sendToMessaging({
      chatId,
      text:
        intent.reply ||
        "hey! I'm jptr 🎬 — I auto-edit videos. Ask me to cut the non-talking parts from your clips.",
    });
    return res.json({ ok: true });
  }

  if (intent.action === "status") {
    await sendToMessaging({ chatId, text: "still working on it 🎬" });
    return res.json({ ok: true });
  }

  if (intent.action === "review") {
    terac.launchReview({ videoPath: "./output/final.mp4", chatId }).catch(console.error);
    await sendToMessaging({ chatId, text: "on it — real human editors are reviewing your cut now 🧑‍🎨" });
    return res.json({ ok: true });
  }

  const editRequest = {
    clipsDir: "./clips",
    instruction: text,
    marginSec: intent.marginSec ?? 0.2,
  };
  if (process.env.DRIVE_FOLDER_ID) editRequest.driveFolderId = process.env.DRIVE_FOLDER_ID;
  res.json({ ok: true, accepted: true });
  // Ack immediately so the thread isn't silent while the edit runs.
  sendToMessaging({
    chatId,
    text: "on it 🎬 — checking your Google Drive for new clips and cutting the dead air. I'll text the finished video here.",
  }).catch(console.error);
  runEdit(chatId, editRequest);
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

app.listen(4001, () => console.log("agent listening on :4001"));
