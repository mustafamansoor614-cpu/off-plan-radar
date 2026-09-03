// netlify/functions/analyze.js
//
// Turns a batch of fetched ads into a short competitive analysis using an
// LLM. Needs ONE of these set as a Netlify environment variable:
//   ANTHROPIC_API_KEY   (uses Claude — checked first)
//   OPENAI_API_KEY      (uses GPT — used if no Anthropic key is set)
//
// The key never touches the browser — it's read server-side from
// process.env inside this function only.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function buildPrompt(query, country, ads) {
  const lines = ads.slice(0, 30).map((a, i) => {
    const body = (a.body || "").replace(/\s+/g, " ").trim().slice(0, 500);
    return `${i + 1}. [${a.pageName}] ${a.isActive ? "Active" : "Inactive"} | platforms: ${(a.platforms || []).join(
      ","
    )} | cta: ${a.ctaText || "-"} | started: ${a.startDate ? new Date(a.startDate).toISOString().slice(0, 10) : "?"}\n   "${body}"`;
  });

  return `You are a sharp, concise real-estate marketing analyst. Below are ${ads.length} live Meta ads for "${query}" in ${country}, pulled just now from Meta's public Ad Library.

${lines.join("\n\n")}

Write a competitive analysis in plain text with light markdown (short paragraphs, **bold** for emphasis, "-" for lists only where genuinely list-shaped). Cover, in this order: (1) core messaging themes and price positioning actually visible in the ad text, (2) offer and urgency tactics used, (3) creative format mix (video vs image, language/localization), (4) what a competing agent or developer should react to. Stay under 350 words. Do not invent facts the ad text above doesn't support — if pricing isn't mentioned, say so rather than guessing.`;
}

async function callAnthropic(apiKey, prompt) {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic API error (${r.status})`);
  return (data.content || []).map((c) => c.text || "").join("\n").trim();
}

async function callOpenAI(apiKey, prompt) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI API error (${r.status})`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  try {
    const payload = JSON.parse(event.body || "{}");
    const { query, country, ads } = payload;

    if (!Array.isArray(ads) || ads.length === 0) {
      return json(400, { error: "No ads provided to analyze." });
    }

    const prompt = buildPrompt(query || "this advertiser", country || "the selected market", ads);

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    let text;
    if (anthropicKey) {
      text = await callAnthropic(anthropicKey, prompt);
    } else if (openaiKey) {
      text = await callOpenAI(openaiKey, prompt);
    } else {
      return json(400, {
        error:
          "No API key configured. Add ANTHROPIC_API_KEY (or OPENAI_API_KEY) in your Netlify site's Environment variables, then redeploy.",
      });
    }

    return json(200, { analysis: text });
  } catch (err) {
    return json(500, { error: "Analysis failed: " + (err?.message || String(err)) });
  }
};
