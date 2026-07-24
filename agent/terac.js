/**
 * jptr — Terac human-in-the-loop client.
 * Terac recruits + screens verified human editors; they review the cut on OUR
 * hosted page (messaging GET /review/:id), which stores feedback locally.
 * Terac is poll-only (no webhooks). See ../ARCHITECTURE.md.
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://terac.com/api/external/v2';
const ROOT = path.join(__dirname, '..');
const FEEDBACK_DIR = path.join(ROOT, 'feedback');
const PROJECT_CACHE = path.join(__dirname, 'terac-project.json');
const POLL_INTERVAL_MS = 60_000;
const MAX_POLL_MINUTES = 45;
const TARGET_REVIEWS = 3;

const polls = {}; // localId -> { oppId, startedAt, entries, done }

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TERAC_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`terac ${method} ${route} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function getProjectId() {
  if (fs.existsSync(PROJECT_CACHE)) {
    return JSON.parse(fs.readFileSync(PROJECT_CACHE, 'utf8')).id;
  }
  const project = await api('POST', '/projects', { name: 'jptr edit review' });
  fs.writeFileSync(PROJECT_CACHE, JSON.stringify(project, null, 2));
  return project.id;
}

/** Enumerate job_function options once so we can pick editor/creator values. */
async function listJobFunctions() {
  return api('GET', '/filters/multi_select--job_function/options');
}

async function launchReview() {
  const projectId = await getProjectId();
  const localId = `r${Date.now().toString(36)}`;
  const taskUrl = `${process.env.PUBLIC_URL}/review/${localId}`;

  const opportunity = await api('POST', '/opportunities', {
    title: 'Rate a short auto-edited video clip',
    project_id: projectId,
    num_participants: TARGET_REVIEWS,
    business_type: 'b2c',
    description:
      'Watch a short auto-edited video and give a star rating plus one concrete suggestion. About 4 minutes.',
    screening_questions: [
      {
        key: 'edits_video',
        text: 'Do you edit or post short-form video at least weekly?',
        pick: 'one',
        answers: [
          { text: 'Yes', qualify_logic: 'must' },
          { text: 'No', qualify_logic: 'reject' },
        ],
      },
    ],
    tasks: [
      {
        sequence: 1,
        task_type: 'survey',
        review_type: 'auto_approve',
        task_url: taskUrl,
        duration_minutes: 4,
      },
    ],
  });

  await api('POST', `/opportunities/${opportunity.id}/launch`);
  console.log(`[terac] launched opportunity ${opportunity.id} -> ${taskUrl}`);
  return { localId, oppId: opportunity.id, taskUrl };
}

/** Poll local feedback store (review page writes it) + Terac submission stats.
 * Calls onDone(entries) once TARGET_REVIEWS collected or timer expires. */
function pollUntilDone({ localId, oppId }, onDone) {
  const state = (polls[localId] = { oppId, startedAt: Date.now(), entries: [], done: false });
  const timer = setInterval(async () => {
    try {
      const file = path.join(FEEDBACK_DIR, `${localId}.json`);
      state.entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      const elapsedMin = (Date.now() - state.startedAt) / 60_000;
      // side info for logs/judges — not required for completion
      api('GET', `/opportunities/${oppId}`).then((o) =>
        console.log(`[terac] ${oppId} stats:`, JSON.stringify(o.submission_stats ?? {})),
      ).catch(() => {});
      if (state.entries.length >= TARGET_REVIEWS || elapsedMin > MAX_POLL_MINUTES) {
        clearInterval(timer);
        state.done = true;
        if (state.entries.length > 0) onDone(state.entries);
        else console.log(`[terac] ${localId} expired with no feedback`);
      }
    } catch (err) {
      console.error('[terac] poll error:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

function status(localId) {
  const state = polls[localId];
  if (!state) return { ok: false, error: 'unknown opportunity' };
  return {
    ok: true,
    oppId: state.oppId,
    reviews: state.entries.length,
    target: TARGET_REVIEWS,
    elapsedMin: Math.round((Date.now() - state.startedAt) / 60_000),
    done: state.done,
    entries: state.entries,
  };
}

module.exports = { launchReview, pollUntilDone, status, listJobFunctions };
