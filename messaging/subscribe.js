// Run ONCE after the tunnel is up (re-run only when PUBLIC_URL changes):
//   node subscribe.js
// Prints the whsec_ signing secret — put it in .env as LINQ_WEBHOOK_SECRET,
// then (re)start server.js. Recreating the subscription rotates the secret,
// so this deliberately lives outside the server boot path.
import "dotenv/config";
import { client } from "./linq.js";

const PUBLIC_URL = process.env.PUBLIC_URL;
if (!PUBLIC_URL) {
  console.error("Set PUBLIC_URL in .env first (cloudflared output)");
  process.exit(1);
}

// Pin the payload version so the shape never changes under us.
const target = `${PUBLIC_URL}/webhook/linq?version=2026-02-03`;

const existing = await client.webhookSubscriptions.list();
const subs = existing.data ?? existing.webhook_subscriptions ?? existing;
for (const s of Array.isArray(subs) ? subs : []) {
  console.log(`deleting stale subscription ${s.id} -> ${s.target_url}`);
  await client.webhookSubscriptions.delete(s.id);
}

const sub = await client.webhookSubscriptions.create({
  target_url: target,
  subscribed_events: ["message.received"],
});

console.log("\nsubscription created:");
console.log(JSON.stringify(sub, null, 2));
console.log("\n--> copy the whsec_ secret above into .env as LINQ_WEBHOOK_SECRET, restart server.js");
