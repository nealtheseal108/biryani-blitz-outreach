const IDEAL_CONTACT_EMBEDDINGS = {
  1: "A person whose job requires evaluating and approving external food vendors and commercial partnerships within a university student union building",
  2: "A director or coordinator who designs student experience programs and is looking for novel services that improve campus life",
  3: "An elected student representative whose role is to advocate for student interests, evaluate new campus services, and influence university board decisions",
  4: "A program director at a university entrepreneurship center who works directly with student-founded startups and helps them access campus resources",
  5: "A director of multicultural student affairs or South Asian cultural programming who organizes events and manages vendor relationships for cultural programs",
  6: "A sustainability coordinator who manages a university food vendor database and approves vendors based on environmental criteria",
  7: "A coordinator who manages food truck permits and mobile vendor scheduling within university union spaces",
  8: "A catering or special events coordinator within campus dining who handles outside vendor approvals for specific events",
  9: "An environmental health and safety coordinator who processes food safety permits and inspects food equipment for compliance",
};

function parseJsonObject(text) {
  const clean = String(text || "").replace(/```json\n?|```\n?/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(clean.slice(s, e + 1));
  } catch {
    return null;
  }
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function isElectedStudentRole(title, url) {
  const titleMatch = /\b(president|vice president|vp|chair|representative)\b/i.test(title || "");
  const urlMatch = /studentgov|student-gov|asuc|sg\.|stu-gov|student-association/i.test(url || "");
  return titleMatch && urlMatch;
}

function scoreExcludeReason(contact, similarity) {
  const title = String(contact.title || "").toLowerCase();
  if (/professor|faculty|instructor|lecturer|researcher/.test(title)) return "academic/faculty";
  if (/^(vice chancellor|provost|president|chancellor|dean)/.test(title)) return "too senior";
  if (/\bassistant to\b/.test(title)) return "gatekeeper role";
  if (!contact.email) return "email not found on page";
  if (similarity < 0.5) return "no external vendor mandate";
  return "below similarity threshold";
}

function fallbackBioScore(contact, embeddingSimilarity) {
  const title = String(contact.title || "").toLowerCase();
  const vendorish =
    /\b(vendor|commercial|partnership|student union|auxiliar|dining|events|engagement|student government|ehs|food safety|permits?)\b/i.test(
      `${contact.title || ""} ${contact.department || ""} ${contact.pageContext || ""}`
    );
  const include = vendorish && embeddingSimilarity >= 0.52;
  return {
    vendor_decision_role: include ? "yes" : "unclear",
    right_person: include ? "yes" : "no",
    forward_to_title: include ? null : /assistant|coordinator/.test(title) ? "Director of Commercial Services" : null,
    specific_reason: include
      ? "Role appears student-facing or vendor-facing based on title/context."
      : "Role does not clearly indicate external vendor or student-facing ownership.",
    include,
    externality_score: Number(Math.max(0, Math.min(1, embeddingSimilarity)).toFixed(4)),
    decision_proximity: Number(Math.max(0, Math.min(1, embeddingSimilarity * 0.85)).toFixed(4)),
  };
}

export class ContactScorer {
  constructor(embeddingClient, threshold = Number(process.env.EMBEDDING_INCLUDE_THRESHOLD || 0.72)) {
    this.client = embeddingClient;
    this.threshold = threshold;
    this.idealEmbeddings = null;
  }

  async initialize() {
    const texts = Object.values(IDEAL_CONTACT_EMBEDDINGS);
    const embeddings = await this.client.embedBatch(texts);
    this.idealEmbeddings = Object.fromEntries(
      Object.keys(IDEAL_CONTACT_EMBEDDINGS).map((k, i) => [k, embeddings[i]])
    );
  }

  async scoreContact(contact) {
    const contactText = [contact.title, contact.department, contact.pageContext].filter(Boolean).join(". ");
    if (!contactText.trim()) {
      return { ...contact, include: false, exclude_reason: "no title or context", embedding_similarity: 0 };
    }

    const contactEmbedding = await this.client.embed(contactText);
    let bestTier = null;
    let bestSimilarity = 0;
    for (const [tier, idealEmb] of Object.entries(this.idealEmbeddings || {})) {
      const sim = cosineSimilarity(contactEmbedding, idealEmb);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestTier = parseInt(tier, 10);
      }
    }

    const isElectedStudent = isElectedStudentRole(contact.title, contact.source_url);
    const include = isElectedStudent || bestSimilarity >= this.threshold;
    return {
      ...contact,
      tier: bestTier || contact.tier || null,
      embedding_similarity: Number(bestSimilarity.toFixed(4)),
      externality_score: Number(Math.max(0, Math.min(1, bestSimilarity)).toFixed(4)),
      decision_proximity: Number(Math.max(0, Math.min(1, bestSimilarity * 0.85 + (isElectedStudent ? 0.12 : 0))).toFixed(4)),
      include,
      exclude_reason: include ? null : scoreExcludeReason(contact, bestSimilarity),
    };
  }
}

export async function scoreBioRelevance(contact, llmClient) {
  const emb = Number(contact.embedding_similarity || 0);
  if (!llmClient) return fallbackBioScore(contact, emb);
  const prompt = `
You are a business development researcher for Biryani Blitz assessing whether to cold email this university staff member.

Biryani Blitz seeks student union/commercial placement approvals, food safety pre-clearance, and student champions.

Person:
Name: ${contact.name || ""}
Title: ${contact.title || ""}
Department: ${contact.department || ""}
Bio / page context: ${contact.bio || contact.pageContext || ""}
University: ${contact.university || ""}
Page URL: ${contact.source_url || ""}

Return ONLY JSON:
{
  "vendor_decision_role": "yes|no|unclear",
  "right_person": "yes|forward|no",
  "forward_to_title": "title or null",
  "specific_reason": "one sentence citing this person's role/context",
  "include": true|false,
  "externality_score": 0.0-1.0,
  "decision_proximity": 0.0-1.0
}`;
  try {
    const raw = await llmClient.complete(prompt, { temperature: 0.1, maxTokens: 700 });
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== "object") return fallbackBioScore(contact, emb);
    return {
      vendor_decision_role: parsed.vendor_decision_role || "unclear",
      right_person: parsed.right_person || "no",
      forward_to_title: parsed.forward_to_title || null,
      specific_reason: parsed.specific_reason || "",
      include: parsed.include === true,
      externality_score: Number(parsed.externality_score ?? emb) || 0,
      decision_proximity: Number(parsed.decision_proximity ?? emb * 0.8) || 0,
    };
  } catch {
    return fallbackBioScore(contact, emb);
  }
}

