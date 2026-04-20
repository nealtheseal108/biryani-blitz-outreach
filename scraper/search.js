import {
  dedupeUrlStrings,
  searchBing,
  searchDuckDuckGo,
  searchGoogle,
  sleep,
  withTimeout,
} from "../lib/serp.mjs";
import { extractJSONObject } from "../lib/json-utils.mjs";
import { buildNameFirstQueries, resolvePersonForTier } from "./resolve.mjs";

const TIER_TERMS = {
  1: ["commercial activities", "vendor partnerships", "auxiliary enterprises"],
  2: ["student experience", "student engagement", "student affairs"],
  3: ["student government", "student body president"],
  4: ["entrepreneurship", "innovation center", "venture"],
  5: ["multicultural affairs", "south asian", "cultural center"],
  6: ["sustainability", "zero waste", "green programs"],
  7: ["food truck", "mobile vendor", "union events"],
  8: ["dining services", "catering", "food service"],
  9: ["environmental health", "food safety", "permits"],
};

export async function resolveUniversityDomain(university, llmClient) {
  const fallbackName = String(university?.name || "").trim();
  const fallbackDomain = `${fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, "")}.edu`;
  if (!llmClient) return { domain: fallbackDomain, searchName: fallbackName };
  const prompt = `Return ONLY JSON:
{ "domain": "primary .edu domain", "searchName": "best search phrase" }
University: ${fallbackName}, City: ${String(university?.city || "").trim() || "unknown"}`;
  try {
    const raw = await llmClient.complete(prompt, { temperature: 0, maxTokens: 300 });
    const parsed = extractJSONObject(raw);
    const domain = String(parsed?.domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").trim();
    const searchName = String(parsed?.searchName || fallbackName).trim() || fallbackName;
    return {
      domain: domain || fallbackDomain,
      searchName,
    };
  } catch {
    return { domain: fallbackDomain, searchName: fallbackName };
  }
}

export function buildDomainAnchoredQueries(domain, tier) {
  const terms = TIER_TERMS[tier] || [];
  const safeDomain = String(domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const queries = [];
  for (const term of terms) {
    queries.push(`"@${safeDomain}" "${term}" site:${safeDomain}`);
    queries.push(`site:${safeDomain} "${term}" email director coordinator`);
    queries.push(`site:${safeDomain} "${term}" "email" OR "contact"`);
  }
  return queries;
}

export async function discoverUrlsForUniversity({ browser, university, tiers, llmClient, pagesPerSchool = 8 }) {
  const { domain, searchName } = await resolveUniversityDomain(university, llmClient);
  const enrichedUni = { ...university, searchName };
  const context = await browser.newContext();
  const page = await context.newPage();
  const useDuckDuckGo = process.env.SEARCH_DDG === "1";
  const urls = [];
  try {
    for (const t of tiers || []) {
      const hypothesis = await resolvePersonForTier(enrichedUni, domain, t, llmClient);
      let queries = buildNameFirstQueries(hypothesis, enrichedUni, domain);
      if (!queries.length) queries = buildDomainAnchoredQueries(domain, t);
      for (const q of queries) {
        let links = [];
        try {
          links = await withTimeout(searchGoogle(page, q), 30000, "Google search");
        } catch {
          links = [];
        }
        if (links.length < 2) {
          try {
            links = await withTimeout(searchBing(page, q), 20000, "Bing search");
          } catch {
            links = [];
          }
        }
        if (links.length < 2 && useDuckDuckGo) {
          try {
            links = await withTimeout(searchDuckDuckGo(page, q), 15000, "DuckDuckGo search");
          } catch {
            links = [];
          }
        }
        urls.push(...links.map((url) => ({ url, tier: t, query: q, university: searchName })));
        await sleep(500);
      }
    }
  } finally {
    await context.close();
  }
  const deduped = dedupeUrlStrings(urls.map((u) => u.url));
  const firstByUrl = new Map();
  for (const u of urls) {
    const k = dedupeUrlStrings([u.url])[0] || u.url;
    if (!firstByUrl.has(k)) firstByUrl.set(k, u);
  }
  return deduped
    .slice(0, pagesPerSchool)
    .map((url) => firstByUrl.get(url) || { url, tier: null, query: "", university: searchName });
}

