// Runware LLM client (OpenAI-compatible chat completions).
const BASE = process.env.RUNWARE_BASE || "https://api.runware.ai/v1";

async function complete({ system, user, maxTokens = 300 }) {
  if (process.env.MOCK_LLM === "1") {
    return (
      process.env.MOCK_LLM_RESPONSE ||
      '{"action":"cut_nontalking","source":"unspecified","marginSec":0.2}'
    );
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.RUNWARE_MODEL || "anthropic:claude@sonnet-4-6",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`runware ${res.status}: ${text}`);
  return JSON.parse(text).choices[0].message.content;
}

module.exports = { complete };
