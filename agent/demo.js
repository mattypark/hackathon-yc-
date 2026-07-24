// Scripted demo flow: staged replies with realistic delays, ends by sending
// the Premiere Pro screen recording. Triggered by keyword (see server.js).
// Drop your screen recording at output/demo.mp4 (or set DEMO_VIDEO in agent/.env).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEMO_VIDEO = process.env.DEMO_VIDEO || "./output/demo.mp4";
const FALLBACK_VIDEO = "./output/final.mp4";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = [
  { delayMs: 1500, text: "got it — pulling your clips from Google Drive 📂" },
  { delayMs: 5000, text: "found your clips · analyzing audio for non-talking sections 🔍" },
  { delayMs: 6000, text: "cutting the dead air and assembling the timeline in Premiere Pro ✂️" },
  { delayMs: 7000, text: "rendering the final cut 🎬" },
];

async function run(chatId, sendToMessaging) {
  for (const step of SCRIPT) {
    await sleep(step.delayMs);
    await sendToMessaging({ chatId, text: step.text });
  }
  await sleep(4000);
  const video = fs.existsSync(path.join(ROOT, DEMO_VIDEO)) ? DEMO_VIDEO : FALLBACK_VIDEO;
  await sendToMessaging({
    chatId,
    videoPath: video,
    caption: "completed ✅ here's your edit — non-talking sections removed:",
  });
}

module.exports = { run };
