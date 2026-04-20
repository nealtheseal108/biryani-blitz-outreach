import { discoverUrlsForUniversity } from "./search.mjs";
import { fetchWithEmailExtraction, resolveEmailForPerson } from "./fetch.mjs";
import { extractCandidates } from "./extract.mjs";
import { ContactScorer, scoreBioRelevance } from "./score.mjs";
import { generateBrief } from "./brief.mjs";
import { resolveUniversityDomain } from "./search.mjs";

function dedupeByEmail(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const e = String(row.email || "").trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(row);
  }
  return out;
}

function dedupeLoose(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key =
      String(row.email || "").trim().toLowerCase() ||
      `${String(row.university || "").toLowerCase()}|${String(row.source_url || "").toLowerCase()}|${String(
        row.name || ""
      ).toLowerCase()}|${String(row.title || "").toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function runPipeline(university, opts) {
  const { browser, llmClient, embeddingClient, tiers, maxPages } = opts;
  const { domain } = await resolveUniversityDomain(university, llmClient);
  const urls = await discoverUrlsForUniversity({
    browser,
    university,
    tiers,
    llmClient,
    pagesPerSchool: maxPages,
  });

  const scorer = new ContactScorer(embeddingClient);
  await scorer.initialize();

  const confirmed = [];
  const excluded = [];
  const inferred = [];
  const leads = [];

  for (const u of urls) {
    const snapshot = await fetchWithEmailExtraction(browser, u.url, u.tier, university.name);
    const candidates = await extractCandidates(snapshot, llmClient);
    for (const candidate of candidates) {
      let working = { ...candidate };
      if (!working.email && working.name) {
        const resolved = await resolveEmailForPerson(working, domain, snapshot);
        if (resolved.email) {
          working = {
            ...working,
            email: resolved.email,
            confidence: resolved.confidence,
            email_source: resolved.source,
          };
        }
      }

      const scored = await scorer.scoreContact(working);
      const bioScore = await scoreBioRelevance(scored, llmClient);
      const merged = {
        ...scored,
        include: bioScore.include === true && scored.include !== false,
        externality_score: Number(bioScore.externality_score ?? scored.externality_score ?? 0),
        decision_proximity: Number(bioScore.decision_proximity ?? scored.decision_proximity ?? 0),
        specific_reason: bioScore.specific_reason || scored.exclude_reason || "",
      };

      if (!merged.include) {
        excluded.push({
          ...merged,
          exclude_reason: merged.exclude_reason || merged.specific_reason || "scored out",
        });
        if (bioScore.forward_to_title) {
          leads.push({
            university: university.name,
            domain,
            title: bioScore.forward_to_title,
            discoveredVia: merged.name || merged.email || merged.title || "unknown",
            source_url: merged.source_url || snapshot.finalUrl,
          });
        }
        continue;
      }
      if (!merged.email) {
        inferred.push({ ...merged, confidence: merged.confidence || "inferred" });
        continue;
      }
      const briefed = await generateBrief(merged, llmClient);
      confirmed.push(briefed);
    }
  }

  return {
    confirmed: dedupeByEmail(confirmed),
    excluded: dedupeLoose(excluded),
    inferred: dedupeLoose(inferred),
    leads: dedupeLoose(leads),
  };
}

