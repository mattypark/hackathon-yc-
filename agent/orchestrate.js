/**
 * jptr agent — Person 3 brain (port 4001)
 * Claude intent parse -> editor pipeline -> reply via messaging.
 * Terac human-in-the-loop client lives in ./terac.js.
 * See ../ARCHITECTURE.md for the canonical endpoint map.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execFile } = require('child_process');
const path = require('path');
const express = require('express');
const terac = require('./terac');

const PORT = 4001;
const MESSAGING_URL = 'http://localhost:4000';
const ROOT = path.join(__dirname, '..');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MARGIN_SEC = 0.2;
const EDITOR_TIMEOUT_MS = 30 * 60 * 1000; // 4K clips take a while

// chatId -> { driveFolderId, driveUrl, lastVideoPath, oppLocalId, greeted }
const sessions = {};

const SYSTEM_PROMPT = `You parse video-editing requests from iMessage into JSON. Output ONLY JSON, no prose:
{ "action": "cut_nontalking" | "status" | "review" | "unknown",
  "driveFolderId": "<ID extracted from any drive.google.com/drive/folders/<ID> URL in the message, else null>",
  "marginSec": 0.2 }
"cut the non-talking parts / dead air / silence / edit my clips" -> cut_nontalking.
"how's it going / done yet" -> status. "get feedback / have editors look at it" -> review.
If the message contains a Google Drive folder link, extract the folder ID (strip any ?usp=... suffix).
Anything else -> unknown.`;

// ---------------------------------------------------------------- claude

async function parseIntent(text) {
  const fallback = { action: 'cut_nontalking', driveFolderId: extractFolderId(text), marginSec: DEFAULT_MARGIN_SEC };
  if (!ANTHROPIC_KEY) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });
    const json = await res.json();
    const raw = json?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    // trust regex over model for the folder id
    parsed.driveFolderId = extractFolderId(text) ?? parsed.driveFolderId ?? null;
    return parsed;
  } catch (err) {
    console.error('[intent] claude parse failed, using fallback:', err.message);
    return fallback;
  }
}

function extractFolderId(text) {
  const m = String(text).match(/drive\.google\.com\/drive\/folders\/([\w-]+)/);
  return m ? m[1] : null;
}

async function summarizeFeedback(entries) {
  const avg = (entries.reduce((s, e) => s + (e.rating || 0), 0) / entries.length).toFixed(1);
  const quotes = entries.map((e) => e.comments).filter(Boolean).slice(0, 2);
  if (!ANTHROPIC_KEY) {
    return `🧑‍🎨 ${entries.length} human editors reviewed your cut — ${avg}/5.` +
      quotes.map((q) => `\n“${q}”`).join('');
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'Summarize video-edit reviews into ONE friendly iMessage (max 2 sentences + up to 2 short quotes). Include the average rating.',
        messages: [{ role: 'user', content: JSON.stringify(entries) }],
      }),
    });
    const json = await res.json();
    return json?.content?.[0]?.text ?? `${entries.length} reviews in — ${avg}/5`;
  } catch {
    return `🧑‍🎨 ${entries.length} human editors reviewed your cut — ${avg}/5.`;
  }
}

// ---------------------------------------------------------------- messaging

async function send(chatId, payload) {
  return fetch(`${MESSAGING_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, ...payload }),
  }).catch((err) => console.error('[send] failed:', err.message));
}

// ------------------------------------------------------------------- editor

function runEditor(editRequest) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [path.join(ROOT, 'editor', 'cut.py'), JSON.stringify(editRequest)],
      { cwd: ROOT, timeout: EDITOR_TIMEOUT_MS, env: { ...process.env, PATH: `${process.env.HOME}/Library/Python/3.9/bin:${process.env.PATH}` } },
      (err, stdout) => {
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch {
          resolve({ ok: false, error: err?.message ?? 'editor produced no JSON', code: 'ERROR' });
        }
      },
    );
  });
}

const ERROR_REPLIES = {
  NOT_SHARED: (sa) => `i can't see that folder yet — in Drive, share it to ${sa ?? 'our service account'} (Viewer) or set “anyone with link”, then text me again 🙏`,
  EMPTY_FOLDER: () => `that folder has no videos — drop your clips in and resend the link`,
  NO_CREDENTIALS: () => `having a moment with Drive auth — try sharing the folder as “anyone with link” and resend`,
  DOWNLOAD_FAILED: () => `Drive hiccuped mid-download — send the link once more`,
};

// -------------------------------------------------------------------- routes

const app = express();
app.use(express.json());

app.post('/handle', async (req, res) => {
  res.json({ ok: true }); // ack fast, work async
  const { chatId, text } = req.body ?? {};
  if (!chatId || !text) return;
  console.log(`[handle] ${chatId}: ${text}`);
  const session = (sessions[chatId] ??= {});

  if (!session.greeted) {
    session.greeted = true;
    await send(chatId, {
      text: `hey! i'm jptr 🎬 send me a Google Drive folder link (shared “anyone with link”), or drop clips at ${process.env.PUBLIC_URL ?? ''}/upload — then tell me what to cut.`,
    });
    // fall through — the same first message may already contain instructions
  }

  const intent = await parseIntent(text);
  if (intent.driveFolderId) session.driveFolderId = intent.driveFolderId;
  console.log('[handle] intent:', JSON.stringify(intent));

  if (intent.action === 'status') {
    return send(chatId, { text: session.lastVideoPath ? 'your cut is done — sent above ☝️' : 'still working on it 🎬' });
  }

  if (intent.action === 'review') {
    return launchReview(chatId, session);
  }

  if (intent.action === 'cut_nontalking' || intent.action === 'unknown') {
    await send(chatId, { text: 'on it — pulling your clips and cutting the dead air ✂️' });
    const editRequest = { clipsDir: './clips', marginSec: intent.marginSec ?? DEFAULT_MARGIN_SEC };
    if (session.driveFolderId) {
      // multi-user: try public link first (no setup), SA download handles shared-to-SA folders
      editRequest.driveUrl = `https://drive.google.com/drive/folders/${session.driveFolderId}`;
    }
    const result = await runEditor(editRequest);
    if (!result.ok) {
      const reply = ERROR_REPLIES[result.code]?.(process.env.SA_EMAIL) ?? `hit a snag: ${result.error}`;
      return send(chatId, { text: reply });
    }
    session.lastVideoPath = result.videoPath;
    await send(chatId, {
      videoPath: result.videoPath,
      caption: `done — cut to ${result.durationSec}s 🎬 want real human editors to review it? just say “get feedback”`,
    });
  }
});

async function launchReview(chatId, session) {
  if (!session.lastVideoPath) {
    return send(chatId, { text: 'nothing to review yet — send me clips first!' });
  }
  try {
    const opp = await terac.launchReview();
    session.oppLocalId = opp.localId;
    await send(chatId, { text: `🧑‍🎨 recruiting verified human editors to review your cut — feedback lands here soon` });
    terac.pollUntilDone(opp, async (entries) => {
      const summary = await summarizeFeedback(entries);
      await send(chatId, { text: summary });
    });
  } catch (err) {
    console.error('[terac] launch failed:', err);
    await send(chatId, { text: `couldn't launch the human review (${err.message}) — will retry shortly` });
  }
}

app.get('/terac/status/:oppId', (req, res) => res.json(terac.status(req.params.oppId)));

app.post('/terac/launch', async (req, res) => {
  try {
    const opp = await terac.launchReview();
    res.json({ ok: true, ...opp });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jptr-agent' }));

app.listen(PORT, () => {
  console.log(`[boot] jptr-agent on :${PORT}`);
  if (!ANTHROPIC_KEY) console.warn('[boot] ANTHROPIC_API_KEY missing — hardcoded intent fallback active');
  if (!process.env.TERAC_API_KEY) console.warn('[boot] TERAC_API_KEY missing — review flow disabled');
});
