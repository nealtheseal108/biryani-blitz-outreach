import { extractJSONObject } from "../lib/json-utils.mjs";

const TIER_DESCRIPTIONS = {
  1: "Student Union / Commercial",
  2: "Student Life / Experience",
  3: "Student Government",
  4: "Entrepreneurship",
  5: "Cultural / South Asian",
  6: "Sustainability",
  7: "Food Truck / Mobile Vendor",
  8: "Campus Dining",
  9: "EHS / Food Safety",
};

export async function resolvePersonForTier(university, domain, tier, llmClient) {
  const fallback = {
    likely_title: "",
    likely_department: "",
    likely_subdomain: domain,
    known_person: null,
    search_queries: [],
    confirmationQueries: [],
    domain,
  };
  if (!llmClient) return fallback;
  const prompt = `
You are a researcher finding the right person to contact at a university about placing a food vending machine in their student union.

University: ${university?.name || ""} (${university?.city || ""})
Primary domain: ${domain}
Outreach tier: ${TIER_DESCRIPTIONS[tier] || "Unknown"}

Return ONLY JSON:
{
  "likely_title": "title",
  "likely_department": "department name",
  "likely_subdomain": "subdomain or empty",
  "known_person": { "name": "Person Name", "title": "Role" } or null,
  "search_queries": ["query1", "query2", "query3"]
}`;
  try {
    const raw = await llmClient.complete(prompt, { temperature: 0.1, maxTokens: 700 });
    const parsed = extractJSONObject(raw) || {};
    const knownPerson = parsed.known_person && parsed.known_person.name ? parsed.known_person : null;
    const likelyTitle = String(parsed.likely_title || "").trim();
    const confirmationQueries = [
      knownPerson ? `"${knownPerson.name}" "${domain}"` : null,
      likelyTitle ? `"${likelyTitle}" site:${domain}` : null,
      likelyTitle ? `site:linkedin.com "${likelyTitle}" "${university?.name || ""}"` : null,
    ].filter(Boolean);
    return {
      likely_title: likelyTitle,
      likely_department: String(parsed.likely_department || "").trim(),
      likely_subdomain: String(parsed.likely_subdomain || "").trim() || domain,
      known_person: knownPerson,
      search_queries: Array.isArray(parsed.search_queries) ? parsed.search_queries.map((q) => String(q || "").trim()).filter(Boolean) : [],
      confirmationQueries,
      domain,
    };
  } catch {
    return fallback;
  }
}

export function buildNameFirstQueries(hypothesis, university, domain) {
  const shortName = String(university?.searchName || university?.name || "").trim();
  const likelyTitle = String(hypothesis?.likely_title || "").trim();
  const likelyDepartment = String(hypothesis?.likely_department || "").trim();
  const known = hypothesis?.known_person;
  return [
    known?.name ? `"${known.name}" "${shortName}" email` : null,
    likelyTitle ? `"${likelyTitle}" "${shortName}" email` : null,
    likelyTitle ? `"@${domain}" "${likelyTitle}"` : null,
    likelyTitle ? `site:linkedin.com "${likelyTitle}" "${shortName}"` : null,
    likelyDepartment ? `"${likelyDepartment}" "${shortName}" (staff OR team OR people OR directory)` : null,
    likelyTitle ? `site:${domain} "${likelyTitle}" (announcement OR welcome OR appointed OR named)` : null,
    ...(Array.isArray(hypothesis?.search_queries) ? hypothesis.search_queries : []),
    ...(Array.isArray(hypothesis?.confirmationQueries) ? hypothesis.confirmationQueries : []),
  ].filter(Boolean);
}

