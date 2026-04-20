import { discoverUrlsForUniversity } from "./search.mjs";
import { fetchWithEmailExtraction } from "./fetch.mjs";
import { extractCandidates } from "./extract.mjs";
import { ContactScorer } from "./score.mjs";
import { generateBrief } from "./brief.mjs";

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

  for (const u of urls) {
    const snapshot = await fetchWithEmailExtraction(browser, u.url, u.tier, university.name);
    const candidates = await extractCandidates(snapshot, llmClient);
    for (const candidate of candidates) {
      const scored = await scorer.scoreContact(candidate);
      if (!scored.include) {
        excluded.push(scored);
        continue;
      }
      if (!scored.email) {
        inferred.push({ ...scored, confidence: scored.confidence || "inferred" });
        continue;
      }
      const briefed = await generateBrief(scored, llmClient);
      confirmed.push(briefed);
    }
  }

  return {
    confirmed: dedupeByEmail(confirmed),
    excluded: dedupeLoose(excluded),
    inferred: dedupeLoose(inferred),
  };
}

