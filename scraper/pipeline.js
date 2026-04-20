import { discoverUrlsForUniversity } from "./search.mjs";
import { fetchWithEmailExtraction, resolveEmailForPerson } from "./fetch.mjs";
import { extractCandidates } from "./extract.mjs";
import { ContactScorer, scoreBioRelevance } from "./score.mjs";
import { generateBrief } from "./brief.mjs";
import { resolveUniversityDomain } from "./search.mjs";
import { buildNameFirstQueries, resolvePersonForTier } from "./resolve.mjs";

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

function dedupeUrlRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = String(row?.url || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(4));
}

export async function runPipeline(university, opts) {
  const { browser, llmClient, embeddingClient, tiers, maxPages } = opts;
  console.log(`  → resolve university domain`);
  const fallbackDomain = `${String(university?.name || "campus")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")}.edu`;
  let domain = fallbackDomain;
  try {
    const resolved = await resolveUniversityDomain(university, llmClient);
    domain = String(resolved?.domain || fallbackDomain).trim() || fallbackDomain;
  } catch (e) {
    console.log(`  ↪ domain resolve fallback: ${String(e?.message || e).slice(0, 140)}`);
    domain = fallbackDomain;
  }
  console.log(`  → domain: ${domain || "(unknown)"}`);
  const allUrls = [];
  const perTierPages = Math.max(1, Math.ceil(maxPages / Math.max(1, (tiers || []).length)));
  for (const tier of tiers || []) {
    console.log(`  → tier T${tier}: hypothesis + name-first search`);
    try {
      const hypothesis = await resolvePersonForTier(university, domain, tier, llmClient);
      const tierNameFirst = buildNameFirstQueries(hypothesis, university, domain);
      const tierUrls = await discoverUrlsForUniversity({
        browser,
        university,
        tiers: [tier],
        llmClient,
        pagesPerSchool: perTierPages,
        primaryDomain: domain,
        nameFirstQueries: tierNameFirst,
        hypothesis: { ...hypothesis, tier },
      });
      console.log(`    T${tier} URLs: ${tierUrls.length}`);
      allUrls.push(...tierUrls);
    } catch (e) {
      console.log(`    ↪ tier T${tier} search failed: ${String(e?.message || e).slice(0, 180)}`);
    }
  }
  const urls = dedupeUrlRows(allUrls);
  console.log(`  → total deduped URLs: ${urls.length}`);

  const scorer = new ContactScorer(embeddingClient);
  await scorer.initialize();

  const confirmed = [];
  const excluded = [];
  const inferred = [];
  const leads = [];

  for (const u of urls) {
    console.log(`    scrape: ${u.url}`);
    const snapshot = await fetchWithEmailExtraction(browser, u.url, u.tier, university.name);
    const candidates = await extractCandidates(snapshot, llmClient);
    console.log(`      candidates: ${candidates.length}`);
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
      const similarity = Number(scored.embedding_similarity || 0);
      const isElectedStudent =
        /\b(president|vice president|vp|chair|representative)\b/i.test(String(scored.title || "")) &&
        /studentgov|student-gov|asuc|sg\.|stu-gov|student-association/i.test(String(scored.source_url || ""));
      const needsBioScorer = similarity >= 0.55 && similarity < 0.85;
      const isDefiniteInclude = similarity >= 0.85 || (scored.include && isElectedStudent);
      const isDefiniteExclude = similarity < 0.45;

      let bioScore = null;
      let finalInclude = scored.include;
      if (!isDefiniteInclude && !isDefiniteExclude && needsBioScorer) {
        bioScore = await scoreBioRelevance(scored, llmClient);
        finalInclude = bioScore.include === true;
      } else if (isDefiniteExclude) {
        finalInclude = false;
      } else {
        finalInclude = scored.include;
      }

      const merged = {
        ...scored,
        include: finalInclude,
        externality_score: round4(bioScore?.externality_score ?? scored.externality_score ?? 0),
        decision_proximity: round4(bioScore?.decision_proximity ?? scored.decision_proximity ?? 0),
        specific_reason: bioScore?.specific_reason || scored.exclude_reason || "",
      };

      if (!merged.include) {
        excluded.push({
          ...merged,
          exclude_reason: merged.exclude_reason || merged.specific_reason || "scored out",
        });
        if (bioScore?.forward_to_title) {
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

