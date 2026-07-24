// Linq helpers: text + video sends. Video uses the pre-upload flow
// (POST /v3/attachments -> PUT presigned URL -> send attachment_id),
// which supports files up to 100MB. URL-based media parts cap at 10MB.
import LinqAPIV3 from "@linqapp/sdk";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const client = new LinqAPIV3({
  apiKey: process.env.LINQ_API_KEY || process.env.LINQ_API_V3_API_KEY,
  webhookSecret: process.env.LINQ_WEBHOOK_SECRET,
});

const FROM = process.env.LINQ_FROM_NUMBER;
const MAX_BYTES = 95 * 1024 * 1024; // Linq hard cap is 100MB; leave headroom

// chatId beginning with "+" = phone number (cold start a chat);
// anything else = existing chat id from a webhook (reply in-thread).
async function sendParts(chatId, parts, effect) {
  const message = { parts };
  if (effect) message.effect = effect;
  message.idempotency_key = crypto
    .createHash("sha1")
    .update(chatId + JSON.stringify(parts))
    .digest("hex");

  if (chatId.startsWith("+")) {
    const res = await client.chats.create({ from: FROM, to: [chatId], message });
    return { chatId: res.chat_id ?? chatId, messageId: res.message?.id };
  }
  const res = await client.chats.messages.send(chatId, { message });
  return { chatId, messageId: res.message?.id };
}

export function sendText(chatId, text) {
  return sendParts(chatId, [{ type: "text", value: text }]);
}

function transcodeToFit(videoPath) {
  const durationSec = parseFloat(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]).toString(),
  );
  // target ~88MB total; subtract audio (128kbps) from the video budget
  const videoKbps = Math.floor((88 * 1024 * 8) / durationSec) - 128;
  const out = videoPath.replace(/\.\w+$/, "") + ".fit.mp4";
  execFileSync("ffmpeg", [
    "-y", "-i", videoPath,
    "-c:v", "libx264", "-b:v", `${videoKbps}k`, "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "128k", out,
  ], { stdio: "ignore" });
  return out;
}

// Relative paths (e.g. "./output/final.mp4" from the agent's EditResult)
// resolve against the repo root, not this server's cwd.
const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

export async function uploadVideo(videoPath) {
  let filePath = path.isAbsolute(videoPath)
    ? videoPath
    : path.resolve(REPO_ROOT, videoPath);
  if (fs.statSync(filePath).size > MAX_BYTES) {
    console.log(`[linq] ${filePath} exceeds ${MAX_BYTES} bytes — transcoding down`);
    filePath = transcodeToFit(filePath);
  }
  const att = await client.attachments.create({
    filename: path.basename(filePath),
    content_type: "video/mp4",
    size_bytes: fs.statSync(filePath).size,
  });
  const put = await fetch(att.upload_url, {
    method: "PUT",
    headers: att.required_headers,
    body: fs.readFileSync(filePath),
  });
  if (!put.ok) throw new Error(`attachment PUT failed: ${put.status} ${await put.text()}`);
  return att.attachment_id;
}

export async function sendVideo(chatId, videoPath, caption) {
  try {
    const attachmentId = await uploadVideo(videoPath);
    const parts = [];
    if (caption) parts.push({ type: "text", value: caption });
    parts.push({ type: "media", attachment_id: attachmentId });
    return await sendParts(chatId, parts, { name: "confetti", type: "screen" });
  } catch (err) {
    // Fallback per IMPLEMENTATION.md: text with a link to /media
    console.error("[linq] video send failed, falling back to link:", err.message);
    const url = `${process.env.PUBLIC_URL}/media/${path.basename(videoPath)}`;
    return sendParts(chatId, [
      { type: "text", value: `${caption || "your cut is ready"} — ${url}` },
    ]);
  }
}
