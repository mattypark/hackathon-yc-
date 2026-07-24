// Terac human-in-the-loop client: create opportunity, launch, poll, summarize, send.
const fs = require("fs");
const path = require("path");

const BASE = process.env.TERAC_BASE || "https://terac.com/api/external/v2";
const PROJECT_CACHE = path.join(__dirname, "terac-project.json");
const MOCK = process.env.MOCK_TERAC === "1";
const state = new Map(); // ponytail: in-memory, dies with the process — fine for a demo

async function terac(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.TERAC_API_KEY}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`terac ${opts.method || "GET"} ${p} -> ${res.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

const readJson = (f, dflt) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; }
};

async function ensureProject() {
  // set TERAC_PROJECT_ID to launch into an existing dashboard project instead of making a new one
  if (process.env.TERAC_PROJECT_ID) return console.log("[terac] project (env)", process.env.TERAC_PROJECT_ID), process.env.TERAC_PROJECT_ID;
  const cached = readJson(PROJECT_CACHE, null);
  if (cached && cached.id) return console.log("[terac] project (cached)", cached.id), cached.id;
  const out = await terac("/projects", { method: "POST", body: JSON.stringify({ name: "jptr edit review" }) });
  const id = out.id || (out.data && out.data.id);
  fs.writeFileSync(PROJECT_CACHE, JSON.stringify({ id }));
  console.log("[terac] project created", id);
  return id;
}

async function send(chatId, text) {
  const url = `${process.env.MESSAGING_URL || "http://localhost:4000"}/send`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, text }),
    });
    console.log("[terac] summary sent", res.status, JSON.stringify(text));
  } catch (e) {
    console.error("[terac] send failed:", e.message);
  }
}

async function summarize(feedback) {
  const n = feedback.length;
  if (!n) return "still waiting on the human editors — reviews are still coming in, i'll ping you the moment they land 🧑‍🎨";
  const ratings = feedback.map((f) => Number(f.rating)).filter((r) => !isNaN(r));
  const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
  const quotes = feedback.map((f) => (f.comments || "").trim()).filter(Boolean).slice(0, 2);
  const fallback = `🧑‍🎨 ${n} human editors reviewed your cut — ${avg}/5.` +
    quotes.map((q) => `\n"${q}"`).join("");
  try {
    const out = await require("./llm").complete({
      system: "Summarize video review feedback in 2 friendly sentences for an iMessage.",
      user: JSON.stringify(feedback),
      maxTokens: 150,
    });
    // ponytail: a JSON-looking reply means the llm mock/misfire leaked — use the template
    return out && out.trim() && !out.trim().startsWith("{")
      ? `🧑‍🎨 ${n} human editors reviewed your cut — ${avg}/5.\n${out.trim()}`
      : fallback;
  } catch (e) {
    console.log("[terac] llm summary failed, using template:", e.message);
    return fallback;
  }
}

async function launchReview({ videoPath, chatId }) {
  const localId = Math.random().toString(36).slice(2, 8);
  if (!process.env.PUBLIC_URL) console.warn("[terac] PUBLIC_URL unset — reviewers can't reach the page from outside");
  const taskUrl = `${process.env.PUBLIC_URL || "http://localhost:4000"}/review/${localId}`;
  const num = Number(process.env.TERAC_NUM_PARTICIPANTS || 3);
  console.log("[terac] launchReview", { videoPath, chatId, localId, taskUrl, mock: MOCK });

  let oppId;
  if (MOCK) {
    oppId = "mock_opp_" + Date.now();
    console.log("[terac] MOCK_TERAC=1 — skipping network, oppId", oppId);
  } else {
    const opp = await terac("/opportunities", {
      method: "POST",
      body: JSON.stringify({
        title: "Rate a 60-second auto-edited salon clip",
        project_id: await ensureProject(),
        num_participants: num,
        business_type: "b2c",
        description: "Watch a short auto-edited video and give a rating + one suggestion. ~4 minutes.",
        // creator-adjacent roles, confirmed live from GET /filters/multi_select--job_function/options
        filters: [{ "multi_select--job_function": { "$in":
          (process.env.TERAC_JOB_FUNCTIONS || "art-creative,design,marketing,production,writing-editing,advertising").split(",") } }],
        screening_questions: [{
          key: "edits_video",
          text: "Do you edit or post short-form video at least weekly?",
          pick: "one",
          answers: [{ text: "Yes", qualify_logic: "must" }, { text: "No", qualify_logic: "reject" }],
        }],
        tasks: [{
          sequence: 1,
          // verified live 2026-07-24: valid enums are interview | file_upload | activity
          task_type: process.env.TERAC_TASK_TYPE || "activity",
          review_type: process.env.TERAC_REVIEW_TYPE || "auto_approve",
          task_url: taskUrl,
          duration_minutes: 4,
        }],
      }),
    }).catch((e) => {
      if (/task_type/i.test(e.message)) console.error("[terac] HINT: task_type rejected — retry with TERAC_TASK_TYPE=interview");
      throw e;
    });
    oppId = opp.id || (opp.data && opp.data.id);
    console.log("[terac] opportunity created", oppId);
    await terac(`/opportunities/${oppId}/launch`, { method: "POST", body: "{}" });
    console.log("[terac] opportunity LAUNCHED", oppId, "->", taskUrl);
  }

  const st = { oppId, localId, chatId, taskUrl, launchedAt: Date.now(), lastPollAt: null, submissionCounts: {}, feedbackCount: 0, done: false, summarySent: false };
  state.set(oppId, st);
  state.set(localId, st);

  const timeoutMs = Number(process.env.TERAC_TIMEOUT_MIN || 45) * 60_000;
  const timer = setInterval(async () => {
    st.lastPollAt = Date.now();
    const local = readJson(path.join(__dirname, "..", "feedback", `${localId}.json`), []);
    st.feedbackCount = local.length;
    if (!MOCK) {
      try {
        const subs = await terac(`/opportunities/${oppId}/submissions?status=approved&limit=100`);
        st.submissionCounts.approved = (subs.data || []).length;
      } catch (e) {
        console.error("[terac] poll (submissions) failed, continuing:", e.message);
      }
    }
    const elapsed = Date.now() - st.launchedAt;
    console.log(`[terac] poll ${oppId} local=${local.length}/${num} approved=${st.submissionCounts.approved ?? "?"} elapsed=${Math.round(elapsed / 60000)}m`);
    if (local.length < num && elapsed < timeoutMs) return;
    clearInterval(timer);
    st.done = true;
    await send(chatId, await summarize(local));
    st.summarySent = true;
  }, Number(process.env.TERAC_POLL_MS || 60_000));

  return { oppId, localId, dashboardHint: "https://terac.com dashboard → opportunities" };
}

const getStatus = (id) => state.get(id) || { error: "unknown opportunity" };

module.exports = { launchReview, getStatus };
