// messaging :4000 — Person 1. Endpoint map is canonical in ../ARCHITECTURE.md
import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, sendText, sendVideo } from "./linq.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, "..", "clips");
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const FEEDBACK_DIR = path.join(__dirname, "..", "feedback");
for (const d of [CLIPS_DIR, OUTPUT_DIR, FEEDBACK_DIR]) fs.mkdirSync(d, { recursive: true });

const AGENT_URL = process.env.AGENT_URL || "http://localhost:4001/handle";
const PORT = process.env.PORT || 4000;

const app = express();

// ---------------------------------------------------------------- 1. webhook
// Raw body on this route ONLY — unwrap() verifies the signature over raw bytes.
const seenEvents = new Set(); // Linq delivery is at-least-once; dedupe by event id
app.post("/webhook/linq", express.raw({ type: "*/*" }), (req, res) => {
  let event;
  try {
    event = client.webhooks.unwrap(req.body.toString("utf8"), { headers: req.headers });
  } catch (err) {
    console.error("[webhook] bad signature:", err.message);
    return res.status(401).end();
  }
  res.status(200).end(); // ack fast (10s timeout); process async below

  if (event.event_type !== "message.received") return;
  if (seenEvents.has(event.event_id)) return;
  seenEvents.add(event.event_id);
  if (seenEvents.size > 5000) seenEvents.clear();

  const msg = event.data;
  if (msg.direction !== "inbound") return; // never react to our own sends

  const text = (msg.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.value)
    .join(" ")
    .trim();
  if (!text) return; // media-only message; nothing for the agent to parse yet

  const payload = { chatId: msg.chat.id, text, from: msg.sender_handle?.handle };
  console.log("[webhook] inbound:", payload);
  fetch(AGENT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => console.error("[webhook] agent forward failed:", err.message));
});

app.use(express.json());

// ------------------------------------------------------------------ 2. /send
// CONTRACT surface: { chatId, text?, videoPath?, caption? }
app.post("/send", async (req, res) => {
  const { chatId, text, videoPath, caption } = req.body || {};
  if (!chatId) return res.status(400).json({ ok: false, error: "chatId required" });
  try {
    const result = videoPath
      ? await sendVideo(chatId, videoPath, caption)
      : await sendText(chatId, text || caption || "");
    console.log("[send] ok:", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[send] failed:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------- 3. /upload
const upload = multer({
  storage: multer.diskStorage({
    destination: CLIPS_DIR,
    filename: (_req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, /\.(mp4|mov|m4v)$/i.test(file.originalname)),
});

app.get("/upload", (req, res) => {
  const chat = typeof req.query.chat === "string" ? req.query.chat : "";
  res.type("html").send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>jptr — drop your clips</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0b0b0f;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
  #zone{border:2px dashed #555;border-radius:16px;padding:60px 40px;text-align:center;max-width:420px}
  #zone.over{border-color:#4af;background:#14141c}
  input{display:none} label{color:#4af;cursor:pointer;text-decoration:underline}
  #status{margin-top:16px;color:#8f8}
</style>
<div id="zone">
  <h2>🎬 drop your clips</h2>
  <p>drag files here or <label for="f">browse</label></p>
  <input id="f" type="file" multiple accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">
  <div id="status"></div>
</div>
<script>
const chat=${JSON.stringify(chat)};
const zone=document.getElementById('zone'),status=document.getElementById('status');
async function send(files){
  const fd=new FormData();[...files].forEach(f=>fd.append('clips',f));
  if(chat) fd.append('chatId',chat);
  status.textContent='uploading '+files.length+' file(s)…';
  const r=await fetch('/upload',{method:'POST',body:fd});
  const j=await r.json();
  status.textContent=j.ok?j.count+' clip(s) ready ✅ — back to iMessage':'upload failed';
}
zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('over')});
zone.addEventListener('dragleave',()=>zone.classList.remove('over'));
zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('over');send(e.dataTransfer.files)});
document.getElementById('f').addEventListener('change',e=>send(e.target.files));
</script>`);
});

app.post("/upload", upload.array("clips"), async (req, res) => {
  const count = (req.files || []).length;
  const chatId = req.body?.chatId || req.query.chat;
  console.log("[upload]", (req.files || []).map((f) => f.filename), "chat=", chatId || "(none)");
  res.json({ ok: true, count });
  // Tell the agent which chat owns these clips so session-scoped footage works.
  if (chatId && count > 0) {
    fetch(AGENT_URL.replace(/\/handle$/, "") + "/uploaded", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, count }),
    }).catch((err) => console.error("[upload] agent notify failed:", err.message));
  }
});

// ---------------------------------------------------------------- 4. /review
app.get("/review/:id", (req, res) => {
  const id = path.basename(req.params.id);
  res.type("html").send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review this edit</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0b0b0f;color:#eee;max-width:560px;margin:0 auto;padding:24px}
  video{width:100%;border-radius:12px}
  .stars{font-size:36px;cursor:pointer;user-select:none}
  .stars span.on{color:gold}.stars span{color:#444}
  textarea{width:100%;min-height:80px;border-radius:8px;background:#14141c;color:#eee;border:1px solid #333;padding:10px;box-sizing:border-box}
  button{background:#4af;color:#000;border:0;border-radius:8px;padding:12px 28px;font-size:16px;margin-top:12px;cursor:pointer}
  #done{color:#8f8;font-size:20px}
</style>
<h2>Rate this auto-edited cut</h2>
<video controls src="/media/final.mp4"></video>
<form id="form">
  <p>How good is this edit?</p>
  <div class="stars" id="stars">${"<span>★</span>".repeat(5)}</div>
  <p><textarea id="comments" placeholder="What would you change?"></textarea></p>
  <button type="submit">Submit review</button>
</form>
<p id="done" hidden>Thanks — your feedback was recorded ✅</p>
<script>
let rating=0;
const stars=[...document.querySelectorAll('#stars span')];
stars.forEach((s,i)=>s.onclick=()=>{rating=i+1;stars.forEach((x,j)=>x.classList.toggle('on',j<=i))});
document.getElementById('form').onsubmit=async e=>{
  e.preventDefault();
  await fetch('/review/${id}/feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({rating,comments:document.getElementById('comments').value})});
  document.getElementById('form').hidden=true;
  document.getElementById('done').hidden=false;
};
</script>`);
});

app.post("/review/:id/feedback", (req, res) => {
  const id = path.basename(req.params.id);
  const file = path.join(FEEDBACK_DIR, `${id}.json`);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  entries.push({
    oppId: id,
    participantId: req.body.participantId ?? null,
    rating: req.body.rating,
    comments: req.body.comments || "",
    submittedAt: new Date().toISOString(),
  });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  console.log(`[review] ${id}: ${req.body.rating}★ "${req.body.comments || ""}"`);
  res.json({ ok: true, n: entries.length });
});

// ----------------------------------------------------------------- 5. /media
app.use("/media", express.static(OUTPUT_DIR)); // review page video src + send fallback

app.listen(PORT, () => {
  console.log(`[messaging] up on :${PORT}`);
  console.log(`[messaging] PUBLIC_URL=${process.env.PUBLIC_URL || "(set after tunnel up)"}`);
});
