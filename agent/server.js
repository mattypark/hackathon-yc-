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
const FALLBACK = { action: "cut_nontalking", source: "unspecified", marginSec: 0.2 };

const SYSTEM = `You parse video-editing requests from iMessage into JSON. Output ONLY JSON:
{ "action": "cut_nontalking" | "status" | "review" | "unknown",
  "source": "drive" | "uploaded" | "unspecified",
  "marginSec": 0.2 }
"cut the non-talking parts / dead air / silence" → cut_nontalking.
"how's it going / done yet" → status. "get feedback / have editors look" → review.
Anything else → unknown.`;

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
    return intent.action && intent.action !== "unknown" ? intent : FALLBACK;
  } catch (e) {
    console.log("intent parse failed, using fallback:", e.message);
    return FALLBACK;
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
