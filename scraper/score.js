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

