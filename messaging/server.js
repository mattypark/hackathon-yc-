/**
 * jptr messaging — Person 1 surface (port 4000)
 * Linq iMessage I/O + drag-drop upload + Terac review page + media serving.
 * See ../ARCHITECTURE.md for the canonical endpoint map.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const PORT = 4000;
const AGENT_URL = 'http://localhost:4001';
const ROOT = path.join(__dirname, '..');
const CLIPS_DIR = path.join(ROOT, 'clips');
const OUTPUT_DIR = path.join(ROOT, 'output');
const FEEDBACK_DIR = path.join(ROOT, 'feedback');
const LINQ_BASE = 'https://api.linqapp.com/api/partner/v3';
const ACCEPTED_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const { LINQ_API_KEY, LINQ_FROM_NUMBER, PUBLIC_URL } = process.env;

for (const dir of [CLIPS_DIR, OUTPUT_DIR, FEEDBACK_DIR]) fs.mkdirSync(dir, { recursive: true });

const app = express();

// ---------------------------------------------------------------- linq client

async function linq(method, route, body) {
  const res = await fetch(`${LINQ_BASE}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${LINQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`[linq] ${method} ${route} -> ${res.status}`, text.slice(0, 500));
  }
  return { status: res.status, body: json };
}

async function sendMessage({ to, text, videoPath, caption }) {
  const parts = [];
  if (text || caption) parts.push({ type: 'text', value: text || caption });
  if (videoPath) {
    const filename = path.basename(videoPath);
    parts.push({ type: 'media', url: `${PUBLIC_URL}/media/${filename}` });
  }
  return linq('POST', '/chats', {
    from: LINQ_FROM_NUMBER,
    to: [to],
    message: { parts },
  });
}

// ------------------------------------------------------- webhook subscription

async function ensureWebhookSubscription() {
  if (!PUBLIC_URL) {
    console.warn('[boot] PUBLIC_URL unset — skipping webhook subscribe (set it after tunnel is up)');
    return;
  }
  const target = `${PUBLIC_URL}/webhook/linq`;
  const existing = await linq('GET', '/webhook-subscriptions');
  const subs = existing.body?.data ?? existing.body?.webhook_subscriptions ?? [];
  if (Array.isArray(subs) && subs.some((s) => s.target_url === target)) {
    console.log('[boot] webhook subscription already exists');
    return;
  }
  const created = await linq('POST', '/webhook-subscriptions', {
    target_url: target,
    subscribed_events: ['message.received'],
  });
  console.log('[boot] webhook subscribe ->', created.status);
}

// --------------------------------------------------------------------- routes

// Inbound Linq webhook. Raw body for HMAC; verification is best-effort —
// if LINQ_WEBHOOK_SECRET is unset we accept (hackathon mode).
app.post('/webhook/linq', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200); // ack immediately, process async
  try {
    const secret = process.env.LINQ_WEBHOOK_SECRET;
    if (secret) {
      const signed = `${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${req.body}`;
      const expected = crypto
        .createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
        .update(signed)
        .digest('base64');
      const given = String(req.headers['webhook-signature'] || '')
        .split(' ')
        .map((s) => s.split(',').pop());
      if (!given.includes(expected)) {
        console.warn('[webhook] signature mismatch — dropping');
        return;
      }
    }
    const event = JSON.parse(req.body.toString('utf8'));
    console.log('[webhook] event:', JSON.stringify(event).slice(0, 400));
    const payload = event.data ?? event.payload ?? event;
    const message = payload.message ?? payload;
    const text = message?.text
      ?? message?.parts?.filter((p) => p.type === 'text').map((p) => p.value).join(' ')
      ?? '';
    const from = payload.from ?? message?.from ?? payload.sender ?? '';
    const chatId = payload.chat_id ?? payload.chatId ?? from;
    if (!text) return;
    await fetch(`${AGENT_URL}/handle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text, from }),
    }).catch((err) => console.error('[webhook] agent forward failed:', err.message));
  } catch (err) {
    console.error('[webhook] error:', err);
  }
});

app.use(express.json());

// Outbound send (agent calls this)
app.post('/send', async (req, res) => {
  const { chatId, text, videoPath, caption } = req.body ?? {};
  if (!chatId || (!text && !videoPath)) {
    return res.status(400).json({ ok: false, error: 'chatId and text or videoPath required' });
  }
  const result = await sendMessage({ to: chatId, text, videoPath, caption });
  res.status(result.status < 400 ? 200 : 502).json({ ok: result.status < 400, linq: result.body });
});

// Drag-drop upload page
const upload = multer({
  storage: multer.diskStorage({
    destination: CLIPS_DIR,
    filename: (_req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) =>
    cb(null, ACCEPTED_EXTS.has(path.extname(file.originalname).toLowerCase())),
});

app.get('/upload', (_req, res) => {
  res.type('html').send(UPLOAD_PAGE);
});

app.post('/upload', upload.array('clips', 10), (req, res) => {
  const count = (req.files ?? []).length;
  console.log(`[upload] received ${count} clip(s)`);
  res.json({ ok: true, count });
});

// Terac review page
app.get('/review/:id', (req, res) => {
  const id = path.basename(req.params.id);
  res.type('html').send(reviewPage(id));
});

app.post('/review/:id/feedback', (req, res) => {
  const id = path.basename(req.params.id);
  const file = path.join(FEEDBACK_DIR, `${id}.json`);
  const entry = {
    oppId: id,
    participantId: req.body?.participantId ?? null,
    rating: Number(req.body?.rating) || null,
    comments: String(req.body?.comments ?? '').slice(0, 2000),
    submittedAt: new Date().toISOString(),
  };
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  fs.writeFileSync(file, JSON.stringify([...existing, entry], null, 2));
  console.log(`[review] feedback for ${id}: ${entry.rating}★`);
  res.json({ ok: true });
});

// Static media (Linq media parts + review page video src)
app.use('/media', express.static(OUTPUT_DIR));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jptr-messaging' }));

// ---------------------------------------------------------------------- pages

const UPLOAD_PAGE = /* html */ `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jptr — drop your clips</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 8vh auto; padding: 0 20px; }
  h1 { font-size: 1.5rem; }
  #zone { border: 2px dashed #888; border-radius: 16px; padding: 48px 24px; text-align: center;
          cursor: pointer; transition: border-color 150ms, background 150ms; }
  #zone.drag { border-color: #0a84ff; background: rgba(10,132,255,.08); }
  #status { margin-top: 16px; font-weight: 600; }
</style>
<h1>jptr 🎬</h1>
<p>Drop your clips (.mp4 / .mov / .m4v, max 500MB each) — then text me what you want.</p>
<div id="zone">drag & drop here<br>or tap to choose</div>
<input id="picker" type="file" accept="video/mp4,video/quicktime" multiple hidden>
<div id="status"></div>
<script>
  const zone = document.getElementById('zone');
  const picker = document.getElementById('picker');
  const status = document.getElementById('status');
  zone.onclick = () => picker.click();
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = () => zone.classList.remove('drag');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('drag'); send(e.dataTransfer.files); };
  picker.onchange = () => send(picker.files);
  async function send(files) {
    const form = new FormData();
    for (const f of files) form.append('clips', f);
    status.textContent = 'uploading ' + files.length + ' clip(s)…';
    const res = await fetch('/upload', { method: 'POST', body: form });
    const json = await res.json();
    status.textContent = json.ok ? json.count + ' clip(s) ready ✅ — go text me!' : 'upload failed, retry';
  }
</script>`;

function reviewPage(id) {
  return /* html */ `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rate this edit</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, sans-serif; max-width: 520px; margin: 6vh auto; padding: 0 20px; }
  video { width: 100%; border-radius: 12px; }
  .stars { display: flex; gap: 8px; font-size: 2rem; margin: 16px 0; }
  .stars button { background: none; border: none; cursor: pointer; font-size: inherit; opacity: .35; }
  .stars button.on { opacity: 1; }
  textarea { width: 100%; min-height: 90px; border-radius: 8px; padding: 10px; font: inherit; }
  #submit { margin-top: 12px; padding: 12px 28px; border-radius: 10px; border: none;
            background: #0a84ff; color: #fff; font-weight: 600; font-size: 1rem; cursor: pointer; }
  #done { font-weight: 700; }
</style>
<h2>Watch this auto-edited clip, then rate it</h2>
<video controls src="/media/final.mp4"></video>
<div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}">★</button>`).join('')}</div>
<textarea id="comments" placeholder="What would you change? One concrete suggestion."></textarea>
<br><button id="submit">Submit review</button>
<p id="done"></p>
<script>
  let rating = 0;
  document.querySelectorAll('.stars button').forEach((b) => {
    b.onclick = () => {
      rating = Number(b.dataset.n);
      document.querySelectorAll('.stars button').forEach((x) =>
        x.classList.toggle('on', Number(x.dataset.n) <= rating));
    };
  });
  document.getElementById('submit').onclick = async () => {
    if (!rating) { alert('pick a star rating'); return; }
    await fetch('/review/${id}/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comments: document.getElementById('comments').value }),
    });
    document.getElementById('done').textContent = 'Thanks — review recorded ✅';
  };
</script>`;
}

// ----------------------------------------------------------------------- boot

app.listen(PORT, async () => {
  console.log(`[boot] jptr-messaging on :${PORT}`);
  if (!LINQ_API_KEY) console.warn('[boot] LINQ_API_KEY missing');
  if (!LINQ_FROM_NUMBER) console.warn('[boot] LINQ_FROM_NUMBER missing — sends will fail');
  await ensureWebhookSubscription();
});
