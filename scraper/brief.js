import { extractJSONObject } from "../lib/json-utils.mjs";

const TIER_LABELS = {
  1: "Student Union / Commercial — contract gatekeeper",
  2: "Student Life — internal champion",
  3: "Student Government — board advocate",
  4: "Entrepreneurship — credibility builder",
  5: "Cultural Center — South Asian audience",
  6: "Sustainability — vendor database listing",
  7: "Food Truck Coordinator — fast placement path",
  8: "Campus Dining — approach last",
  9: "EHS / Food Safety — pre-clearance step",
};

export async function generateBrief(contact, geminiClient) {
  if (!geminiClient) return contact;
  const prompt = `You are writing a one-line briefing for a Biryani Blitz sales rep who is about to cold email this university contact.

Biryani Blitz context:
- Automated hot food vending machine serving fresh biryani bowls
- ~90 second prep time, ~$8 per bowl, bagasse sustainable packaging
- Already deployed at UC Berkeley Student Union (MLK building)
- Founded by students at UNC and Wharton
- Seeking: vendor placement approvals, food safety pre-clearance, student champions, sustainability database listings

Contact:
  Name: ${contact.name}
  Title: ${contact.title}
  Department: ${contact.department || ""}
  University: ${contact.university}
  Page context: ${contact.pageContext || ""}
  Source URL: ${contact.source_url}
  Tier: ${contact.tier} (${TIER_LABELS[contact.tier] || "Unknown"})

Return ONLY JSON:
{
  "relevance_to_biryani_blitz": "One specific sentence",
  "outreach_angle": "One sentence",
  "suggested_subject_line": "Specific cold email subject line"
}`;

  try {
    const raw = await geminiClient.complete(prompt, { temperature: 0.2, maxTokens: 900 });
    const brief = extractJSONObject(raw) || {};
    return {
      ...contact,
      tier_label: TIER_LABELS[contact.tier] || contact.tier_label || "",
      relevance_to_biryani_blitz: String(brief.relevance_to_biryani_blitz || "").trim() || null,
      outreach_angle: String(brief.outreach_angle || "").trim() || null,
      suggested_subject_line: String(brief.suggested_subject_line || "").trim() || null,
      relevance_note:
        String(brief.relevance_to_biryani_blitz || "").trim() ||
        String(contact.relevance_note || "").trim() ||
        null,
    };
  } catch {
    return {
      ...contact,
      tier_label: TIER_LABELS[contact.tier] || contact.tier_label || "",
      relevance_to_biryani_blitz: contact.relevance_to_biryani_blitz || null,
      outreach_angle: contact.outreach_angle || null,
      suggested_subject_line: contact.suggested_subject_line || null,
    };
  }
}

