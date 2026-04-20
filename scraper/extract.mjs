import { extractJSONArray } from "../lib/json-utils.mjs";

function normalizeEmail(s) {
  const e = String(s || "").trim().toLowerCase();
  return e.includes("@") ? e : null;
}

export async function extractCandidates(snapshot, geminiClient) {
  if (!geminiClient) return [];
  const prompt = `Extract all people with professional roles from this university web page.
Prioritize email-first mapping:
1) Start from explicit emails on page/mailtos and identify who each email belongs to.
2) If one candidate is relevant, check nearby names/titles in the same list/block since contacts are grouped.
3) Include everyone you find in this page section; relevance filtering is a separate step.

University: ${snapshot.university}
URL: ${snapshot.finalUrl || snapshot.url} (tier ${snapshot.tier || "unknown"} page)
Known emails found on page: ${JSON.stringify((snapshot.mailtos || []).map((m) => m.email))}

Page text:
---
${String(snapshot.bodyText || "").slice(0, 60000)}
---

Return ONLY a JSON array. Each item:
{
  "name": "string or null",
  "title": "exact title as written on page or null",
  "department": "department name if found",
  "email": "email — ONLY if explicitly present on this page or in mailtos list. null otherwise.",
  "email_source": "mailto|page_text|null",
  "confidence": "high|medium|low"
}

Rules:
- If email not found on page: set email null
- Do not infer or guess email formats
- Include everyone from the same relevant directory block`;

  const raw = await geminiClient.complete(prompt, { temperature: 0.1, maxTokens: 8192 });
  const parsed = extractJSONArray(raw) || [];
  return parsed.map((c) => {
    const email = normalizeEmail(c.email);
    return {
      ...c,
      email,
      source_url: snapshot.finalUrl || snapshot.url,
      university: snapshot.university,
      tier_from_url: snapshot.tier,
      pageContext: email ? snapshot.contextWindows?.[email] || "" : "",
    };
  });
}

