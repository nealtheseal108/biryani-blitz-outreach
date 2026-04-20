/**
 * Playwright + Gemini — single URLs OR full batch over all universities.
 *
 * Batch mode (--batch): reads data/universities.json, runs web search per school (DuckDuckGo HTML,
 * fallback Bing), opens top result pages, extracts contacts with Gemini. Checkpoints after each school.
 *
 * Env:
 *   GOOGLE_API_KEY or GEMINI_API_KEY — https://aistudio.google.com/apikey
 *   GEMINI_MODEL — default gemini-2.0-flash (1.5 models were removed from the API)
 *   GEMINI_RESOLVE_UNIVERSITY=1 — optional extra Gemini call per school to expand abbreviations (uses quota; default off)
 *   LLM_PROVIDER=gemini|openrouter — extraction provider (default gemini)
 *   OPENROUTER_API_KEY — OpenRouter for canonical names, terminology, domain resolve, extraction fallback
 *   OPENROUTER_MODEL — default meta-llama/llama-3.1-8b-instruct:free
 *   MULTI_STAGE_SEARCH=0 — disable per-category office resolution + people/directory crawl (default on)
 *   DOMAIN_ANCHORED_SEARCH=0 — disable "@domain.edu" / site:domain title queries (default on)
 *   CRAWL_PEOPLE_DEPTH — BFS depth for people/staff link crawl (default 2)
 *   CRAWL_PEOPLE_MAX_PAGES — max pages opened in that crawl (default 24)
 *   SUBDOMAIN_CONTACT_CAP — max contacts to collect per hostname before skipping more URLs (default 3)
 *   VERIFY_MX=1 — drop contacts whose email domain has no MX record (optional)
 *   CONTACT_SCORER=auto|llm|regex — post-extract mandate filter (externality vs seniority; default auto: LLM if keys set)
 *   ENRICH_OUTREACH_CARDS=0 — skip second LLM pass that fills bio_snippet + relevance_note for the dashboard
 *
 * Examples:
 *   npm run scrape:batch -- --max 3
 *   npm run scrape:batch
 *   npm run scrape -- --url https://a.edu/staff --university "A"
 */

import fs from "fs";
import path from "path";
import { promises as dns } from "node:dns";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase();
const EMBEDDING_INCLUDE_THRESHOLD = Number(process.env.EMBEDDING_INCLUDE_THRESHOLD || "0.72");
const SEARCH_LLM_TERMS = process.env.SEARCH_LLM_TERMS !== "0";
const MULTI_STAGE_SEARCH = process.env.MULTI_STAGE_SEARCH !== "0";
/** Expand "UT Austin" → full official name for search + contact rows (OpenRouter). Set CANONICAL_UNIVERSITY_NAMES=0 to disable. */
const CANONICAL_UNIVERSITY_NAMES = process.env.CANONICAL_UNIVERSITY_NAMES !== "0";
/** Prefer "@domain.edu" + title queries over generic department searches (set DOMAIN_ANCHORED_SEARCH=0 to disable). */
const DOMAIN_ANCHORED_SEARCH = process.env.DOMAIN_ANCHORED_SEARCH !== "0";
const CRAWL_PEOPLE_DEPTH = Math.min(4, Math.max(1, parseInt(process.env.CRAWL_PEOPLE_DEPTH || "2", 10) || 2));
const CRAWL_PEOPLE_MAX_PAGES = Math.min(48, Math.max(6, parseInt(process.env.CRAWL_PEOPLE_MAX_PAGES || "24", 10) || 24));
const SUBDOMAIN_CONTACT_CAP = Math.max(1, parseInt(process.env.SUBDOMAIN_CONTACT_CAP || "3", 10) || 3);
const VERIFY_MX = process.env.VERIFY_MX === "1";
/** auto = LLM when OPENROUTER_API_KEY or GOOGLE_API_KEY; regex = keyword mandate filter only; llm = require scorer call */
const CONTACT_SCORER = (process.env.CONTACT_SCORER || "auto").toLowerCase();
/** After mandate filter, LLM fills name/title/bio/relevance for the dashboard (set ENRICH_OUTREACH_CARDS=0 to skip). */
const ENRICH_OUTREACH_CARDS = process.env.ENRICH_OUTREACH_CARDS !== "0";

const DEFAULT_DATA = path.join("data", "universities.json");
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
const IDEAL_CONTACT_EMBEDDING_TEXT = {
  1: "A person whose job requires evaluating and approving external food vendors and commercial partnerships within a university student union building.",
  2: "A director or coordinator who designs student experience programs and is looking for novel services that improve campus life.",
  3: "An elected student representative whose role is to advocate for student interests, evaluate new campus services, and influence university board decisions.",
  4: "A program director at a university entrepreneurship center who works directly with student-founded startups and helps them access campus resources.",
  5: "A director of multicultural student affairs or South Asian cultural programming who organizes events and manages vendor relationships for cultural programs.",
  6: "A sustainability coordinator who manages a university food vendor database and approves vendors based on environmental criteria.",
  7: "A coordinator who manages food truck permits and mobile vendor scheduling within university union spaces.",
  8: "A catering or special events coordinator within campus dining who handles outside vendor approvals for specific events.",
  9: "An environmental health and safety coordinator who processes food safety permits and inspects food equipment for compliance.",
};

/** Verbatim outreach mandate + tier routing guidance for the post-extract LLM scorer (job externality, not org-chart seniority). */
const BIRYANI_MANDATE_TIER_GUIDANCE = `
The real filter criterion

A contact is worth targeting if their role exists to deal with people outside their department. That's a fundamentally different question from "are they senior enough." A Facilities Coordinator like Makossa at Berkeley responded constantly and was operationally critical — she's not a VP. Ryan responded because vendor partnerships is literally his job. Kim the dietitian responded because food policy review is literally her job.

The question to ask for each role is: does this person's job description include processing inbound requests from external parties or students? If yes, they will respond. If their job is purely internal operations or academic, they won't.

Reworked tier logic by response-likelihood reasoning:

C1 — Student Union / Commercial Keep anyone with "commercial," "vendor," "partnerships," "business development," or "auxiliary enterprises" in their title. These people have an explicit mandate to evaluate and onboard external vendors. Even a coordinator-level person in this category will respond and can escalate. Drop: facilities managers who don't touch vendor contracts, IT, administrative assistants.

C2 — Student Life / Experience Narrow this significantly. VPs of Student Affairs almost never respond to cold vendor outreach — they're too senior and too internal. The sweet spot is Director of Student Experience or Director of Student Engagement — mid-level, externally facing, responsible for making campus life better and therefore incentivized to say yes to novel student-relevant products. Drop: deans, VPs, anyone with "assessment" or "compliance" in their title.

C3 — Student Government Completely rethink this one. Elected student government presidents and VPs are actually high response rate targets because they're students, they check their email constantly, they're actively looking for things to champion, and their entire job is constituent-facing. The mistake is targeting the staff advisor to student government (internal-facing) instead of the elected officers themselves. Target: President, VP Internal Affairs, VP Student Services — the elected students, not the staff.

C4 — Entrepreneurship Good response rates but for the wrong reason — they'll meet with you but can't approve placement. Target the program coordinator or associate director level, not the executive director. The program coordinator runs day-to-day student programming and is looking for startups to feature. The executive director is a fundraiser who doesn't have time. Drop: faculty directors, research associates.

C5 — Cultural / South Asian Split this into two separate contacts per university: the staff director of the multicultural center (externally facing, approves vendor partnerships for events) and the president of the South Asian student association (a student, will respond immediately, is your grassroots channel). These are different outreach tracks — the staff director is a formal partner, the student president is a word-of-mouth amplifier.

C6 — Sustainability The right contact is whoever manages the food vendor sustainability database or approved vendor list — not the director of sustainability generally. At UT Austin this was a specific email alias (sustainability@austin.utexas.edu) that handles vendor inclusion requests. This is a form-filling exercise more than a relationship, but getting listed means passive inbound from student orgs planning events. Target: zero waste coordinator, food vendor database coordinator, green events coordinator.

C7 — Food Truck / Mobile Highest response rate of any tier because there's almost always a named inbox or coordinator specifically for this and the approval process is lighter than a full vending contract. This is your fastest path to any physical campus presence. Target: whoever manages foodtrucks@university.edu equivalent — usually a coordinator-level person within University Unions, not a director.

C8 — Campus Dining Lowest response rate and most hostile tier. These are Aramark/Sodexo-contracted operations people who see you as competition. The only useful contact here is the catering or special events coordinator within dining — they handle outside vendor approvals for specific events and are accustomed to saying yes to things their main dining operation doesn't cover. Drop: directors, AVPs, anyone with "operations" or "procurement" in title.

C9 — EHS / Food Safety Don't treat this as an outreach target — treat it as a pre-clearance step. Email them before you pitch anyone else at that school, introduce Biryani Blitz, attach your certifications proactively, and ask what permits a hot food vending machine requires. This is the Berkeley lesson: EHS blindsided you because they weren't looped in early. An EHS coordinator who gets a proactive compliance inquiry will almost always respond, because it's a simple administrative task for them and it's their literal job. Response rate is high precisely because you're not asking them for anything they'd resist.

The unified decision rule for whether to include a contact:

Include if ALL of:
  1. Title contains an external-facing verb or noun:
     coordinator, partnerships, vendor, commercial, outreach,
     engagement, events, programs, services, development
  2. OR the role is elected student-facing (student gov, cultural org president)
  3. OR the role is a named compliance/permit processor (EHS, food safety)

(When scoring: treat items 1–3 as alternatives — a contact qualifies if at least one of these positive patterns applies, and none of the exclusions below apply.)

Exclude if ANY of:
  1. Title is purely internal: assessment, analytics, research, budget,
     compliance (non-food), HR, IT, facilities (non-vendor)
  2. Title is VP or Dean or Associate Vice Chancellor — too senior,
     wrong entry point
  3. Title contains "assistant to" — gatekeeper not decision-maker
  4. Role is academic/faculty

The insight: target job mandate externality, not org chart seniority. A coordinator whose job is to process vendor applications is worth more than a VP whose job is strategic oversight. Tier is a secondary label for routing rather than a raw quality signal.
`;

/** Short hints for LLM: real campus office / program names (e.g. Carolina Union, Division of Student Affairs). */
const TIER_OFFICE_HINT = {
  1: "student union, campus commercial services, auxiliary enterprises, event services",
  2: "student affairs, division of student affairs, dean of students, student life, student experience",
  3: "student government, student assembly, student senate, student executive, student body president",
  4: "entrepreneurship center, innovation, venture, startup programs",
  5: "multicultural affairs, cultural resource centers, diversity and inclusion (student-facing)",
  6: "sustainability office, campus sustainability, green programs",
  7: "food trucks, mobile vending, union or campus life events",
  8: "campus dining, dining services, auxiliary dining, food services",
  9: "environmental health and safety, EHS, food safety permits, temporary event permits",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const envResolve =
    process.env.GEMINI_RESOLVE_UNIVERSITY === "1" ||
    process.env.GEMINI_RESOLVE_UNIVERSITY === "true";
  const opts = {
    batch: false,
    urls: [],
    university: "",
    dataPath: DEFAULT_DATA,
    out: path.join("output", "contacts.json"),
    excludedOut: path.join("output", "excluded.json"),
    inferredOut: path.join("output", "inferred.json"),
    max: null,
    start: 0,
    pagesPerSchool: 5,
    delayMs: 2800,
    searchesPerSchool: 2,
    tiers: null,
    /** Off by default — saves Gemini quota; enable via env or --resolve-university */
    resolveUniversity: envResolve,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--batch") opts.batch = true;
    else if (a === "--url") opts.urls.push(args[++i]);
    else if (a === "--university") opts.university = args[++i] || "";
    else if (a === "--out") opts.out = args[++i] || opts.out;
    else if (a === "--excluded-out") opts.excludedOut = args[++i] || opts.excludedOut;
    else if (a === "--inferred-out") opts.inferredOut = args[++i] || opts.inferredOut;
    else if (a === "--data") opts.dataPath = args[++i] || opts.dataPath;
    else if (a === "--max") opts.max = parseInt(args[++i], 10);
    else if (a === "--start") opts.start = parseInt(args[++i], 10) || 0;
    else if (a === "--pages-per-school") opts.pagesPerSchool = parseInt(args[++i], 10) || 5;
    else if (a === "--delay") opts.delayMs = parseInt(args[++i], 10) || 0;
    else if (a === "--searches-per-school" || a === "--searchs-per-school")
      opts.searchesPerSchool = parseInt(args[++i], 10) || 2;
    else if (a === "--tiers") {
      const raw = args[++i] || "";
      opts.tiers = raw
        .split(",")
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => n >= 1 && n <= 9);
    } else if (a === "--resolve-university") opts.resolveUniversity = true;
    else if (a === "--no-resolve-university") opts.resolveUniversity = false;
    else if (a?.startsWith("http")) opts.urls.push(a);
  }
  return opts;
}

/** Default batch tiers when --tiers omitted (legacy behavior) */
const DEFAULT_TIERS = [1, 2, 4, 8];

function normalizeTiers(tiers) {
  if (!tiers || tiers.length === 0) return [...DEFAULT_TIERS];
  return [...new Set(tiers)].filter((n) => n >= 1 && n <= 9).sort((a, b) => a - b);
}

function buildTierQueries(shortName, entrepreneurship, tiers, tierAliasesByNumber = {}, primaryDomain = "") {
  const domain =
    DOMAIN_ANCHORED_SEARCH && normalizeDomainHint(primaryDomain) ? normalizeDomainHint(primaryDomain) : "";
  if (domain) {
    const queries = [];
    for (const t of tiers) {
      const aliases = Array.isArray(tierAliasesByNumber?.[String(t)])
        ? tierAliasesByNumber[String(t)]
        : Array.isArray(tierAliasesByNumber?.[t])
          ? tierAliasesByNumber[t]
          : [];
      const officeLike = {
        office_names: aliases.length ? [String(aliases[0]).trim()] : [],
        seed_queries: [],
      };
      queries.push(...buildDomainAnchoredQueries(shortName, entrepreneurship, t, officeLike, domain));
    }
    if (queries.length) return queries;
  }
  const s = shortName.replace(/\s*\([^)]+\)\s*/g, " ").trim();
  const ent = (entrepreneurship || "entrepreneurship center").trim();
  const tierPhrase = {
    1: "student union commercial",
    2: "student affairs",
    3: "student government",
    4: ent,
    5: "multicultural center",
    6: "sustainability",
    7: "food truck",
    8: "dining services",
    9: "environmental health and safety",
  };
  const queries = [];
  for (const t of tiers) {
    const base = tierPhrase[t];
    if (!base) continue;
    const aliases = Array.isArray(tierAliasesByNumber?.[String(t)])
      ? tierAliasesByNumber[String(t)]
      : Array.isArray(tierAliasesByNumber?.[t])
        ? tierAliasesByNumber[t]
        : [];
    const phrases = [base, ...aliases.map((x) => String(x || "").trim()).filter(Boolean)].slice(0, 2);
    for (const phrase of phrases) {
      queries.push({ tier: t, phrase, query: `${s} ${phrase} staff email site:edu` });
      queries.push({ tier: t, phrase, query: `${s} ${phrase} directory email site:edu` });
    }
  }
  return queries;
}

/** Multi-stage: LLM office names + domain-anchored or legacy category queries. */
function buildQueriesForTierWithOffices(shortName, entrepreneurship, tier, tierAliasesByNumber, officeInfo, primaryDomain = "") {
  const mergedDomain =
    DOMAIN_ANCHORED_SEARCH &&
    (normalizeDomainHint(primaryDomain) || normalizeDomainHint(officeInfo?.primary_domain_hint))
      ? normalizeDomainHint(primaryDomain) || normalizeDomainHint(officeInfo?.primary_domain_hint)
      : "";
  if (mergedDomain) {
    const anchored = buildDomainAnchoredQueries(shortName, entrepreneurship, tier, officeInfo, mergedDomain);
    if (anchored.length) return anchored;
  }
  const s = shortName.replace(/\s*\([^)]+\)\s*/g, " ").trim();
  const ent = (entrepreneurship || "entrepreneurship center").trim();
  const tierPhrase = {
    1: "student union commercial",
    2: "student affairs",
    3: "student government",
    4: ent,
    5: "multicultural center",
    6: "sustainability",
    7: "food truck",
    8: "dining services",
    9: "environmental health and safety",
  };
  const base = tierPhrase[tier];
  if (!base) return [];
  const aliases = Array.isArray(tierAliasesByNumber?.[String(tier)])
    ? tierAliasesByNumber[String(tier)]
    : Array.isArray(tierAliasesByNumber?.[tier])
      ? tierAliasesByNumber[tier]
      : [];
  const phrases = [base, ...aliases.map((x) => String(x || "").trim()).filter(Boolean)].slice(0, 2);
  const queries = [];
  const names = (officeInfo?.office_names || []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
  const seeds = (officeInfo?.seed_queries || []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);

  for (const name of names) {
    queries.push({ tier, phrase: base, query: `${s} ${name} staff email site:edu` });
    queries.push({ tier, phrase: base, query: `${s} ${name} directory site:edu` });
    queries.push({ tier, phrase: base, query: `${name} ${s} leadership email site:edu` });
  }
  for (const sq of seeds) {
    queries.push({ tier, phrase: base, query: sq });
  }
  for (const phrase of phrases) {
    queries.push({ tier, phrase, query: `${s} ${phrase} staff email site:edu` });
    queries.push({ tier, phrase, query: `${s} ${phrase} directory email site:edu` });
  }
  return queries;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 2000, label = "op", isRetryable = () => true } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!isRetryable(msg) || attempt === maxAttempts) throw e;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 1000;
      console.log(`  ⏳ ${label}: retry in ${Math.round(delay / 1000)}s (${attempt}/${maxAttempts})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function normalizeDomainHint(h) {
  let d = String(h || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (d.startsWith("www.")) d = d.slice(4);
  return d.replace(/^mailto:/, "").split("?")[0].trim();
}

/** URL path/host signal for outreach tier (stronger than title-only guessing). */
function classifyUrlTier(url) {
  const s = String(url || "").toLowerCase();
  const rules = [
    [/studentunion|\.union\.|unions\.|carolina union|campus.?union|auxiliary|commercial.?service|vendor/, 1],
    [/studentaffairs|studentlife|student-affairs|deanofstudents|student-life|student experience/, 2],
    [/studentgov|student-gov|studentgovernment|\.sg\.|asuc|student senate|student assembly/, 3],
    [/entrepreneurship|innovation|venture|startup|incubator/, 4],
    [/multicultural|diversity|cultural|south.?asian|intercultural/, 5],
    [/sustainab|climate action|green\.|zero.?waste/, 6],
    [/food.?truck|mobile.?vend|street.?food|vending/, 7],
    [/dining|foodservice|auxiliary.?dining|culinary|campus.?dish/, 8],
    [/environmental.?health|ehs|eh&s|food.?safety|permit/, 9],
  ];
  for (const [re, tier] of rules) {
    if (re.test(s)) return tier;
  }
  return null;
}

/** Fast-path: elected student officers on student-org URLs (skip externality/decision scoring). */
function isElectedStudentOrgFastPath(title, sourceUrl) {
  const t = String(title || "");
  const hasRole =
    /\b(president|vice\s*president|\bvp\b|chair|vice-?\s*chair|chief\s+of\s+staff)\b/i.test(t) ||
    /\bvp\s+(internal|external|student|academic|affairs)\b/i.test(t);
  if (!hasRole) return false;
  const u = String(sourceUrl || "").toLowerCase();
  const orgHost =
    /studentgov|student-gov|studentgovernment|\.sg\.|asuc|asg|student-org|studentorg|senate|assembly|involvement|orgs\.|sao\.|studentactivities|student-life|studentlife|sga|studentassociation/.test(
      u
    );
  return orgHost;
}

function shouldUseLlmMandateScorer() {
  if (CONTACT_SCORER === "regex") return false;
  if (CONTACT_SCORER === "llm") return true;
  return !!(OPENROUTER_API_KEY || API_KEY);
}

/** Regex fallback for mandate rules when LLM is off or fails. */
function filterContactsByRegexMandate(rows) {
  const out = [];
  let dropped = 0;
  const positive =
    /coordinator|partnerships?|vendor|commercial|outreach|engagement|events?|programs?|services?|development|permit|compliance|ehs|food\s*safety|environmental\s*health|sustainability|zero\s*waste|green\s*events|dining|truck|mobile|vend|auxiliary|entrepreneur|multicultural|student\s*gov|senate/i;
  const negative =
    /\b(vp|vice\s*president|dean|associate\s+vice\s+chancellor|avp)\b|assistant\s+to\b|assessment|analytics|research|facilit|budget\s+analyst|human\s+resources|\bhr\b|\bit\b|faculty|professor|lecturer|assistant\s+professor/i;
  const internalOnly =
    /\bassessment\b|\banalytics\b|\bresearch\b(?!\s+associate)|\bcompliance\b(?!\s+food)|facilities(?!\s+.*vendor)/i;

  for (const c of rows || []) {
    const title = String(c.title || c.name || "");
    const em = String(c.email || "").toLowerCase();
    if (
      /anderson\.|@business\.|kenan-flagler|\.gsb\.|wharton|sloan|@mba\./i.test(em) &&
      !positive.test(title) &&
      /mailto contact|^contact \(from directory/i.test(String(c.title || "").trim())
    ) {
      dropped++;
      continue;
    }
    if (c.evidence === "literal" && positive.test(title)) {
      out.push({
        ...c,
        mandate_include: true,
        mandate_scorer: "regex_fallback",
        mandate_exclude_reason: null,
        mandate_externality: 0.75,
        mandate_decision_proximity: 0.5,
        mandate_tier_suggested: c.tier ?? null,
      });
      continue;
    }
    if (negative.test(title) || internalOnly.test(title)) {
      dropped++;
      continue;
    }
    if (positive.test(title)) {
      out.push({
        ...c,
        mandate_include: true,
        mandate_scorer: "regex_fallback",
        mandate_exclude_reason: null,
        mandate_externality: 0.72,
        mandate_decision_proximity: 0.45,
        mandate_tier_suggested: c.tier ?? null,
      });
      continue;
    }
    if (c.evidence === "literal") {
      out.push({
        ...c,
        mandate_include: true,
        mandate_scorer: "regex_fallback_literal",
        mandate_exclude_reason: null,
        mandate_externality: 0.65,
        mandate_decision_proximity: 0.42,
        mandate_tier_suggested: c.tier ?? null,
      });
      continue;
    }
    dropped++;
  }
  console.log(`      ↪ mandate filter (regex): kept ${out.length}, dropped ${dropped}`);
  return out;
}

function mergeMandateScores(contacts, results) {
  const byIdx = new Map();
  for (const r of results || []) {
    const i = Number(r.index);
    if (Number.isFinite(i)) byIdx.set(i, r);
  }
  return contacts.map((c, i) => {
    const r = byIdx.get(i);
    if (!r) {
      return {
        ...c,
        mandate_include: false,
        mandate_scorer: "llm",
        mandate_exclude_reason: "scorer_missing",
        mandate_externality: null,
        mandate_decision_proximity: null,
        mandate_tier_suggested: c.tier ?? null,
      };
    }
    const ext = Number(r.externality);
    const dp = Number(r.decision_proximity);
    let tier = r.tier;
    if (tier != null && tier !== "") tier = Number(tier);
    else tier = null;
    if (!Number.isFinite(tier)) tier = c.tier ?? null;
    return {
      ...c,
      mandate_include: !!r.include,
      mandate_scorer: "llm",
      mandate_exclude_reason: r.exclude_reason ?? null,
      mandate_externality: Number.isFinite(ext) ? ext : null,
      mandate_decision_proximity: Number.isFinite(dp) ? dp : null,
      mandate_tier_suggested: tier,
    };
  });
}

async function scoreContactsMandateLLM(contacts, pageContext, sourceUrl) {
  if (!contacts.length) return [];
  const payload = contacts.map((c, i) => ({
    index: i,
    name: c.name,
    title: c.title,
    department: c.department || null,
    email: c.email,
    existing_tier_hint: c.tier ?? null,
  }));

  const prompt = `Score each university staff or student contact for Biryani Blitz outreach.

Biryani Blitz places automated hot food vending machines in university student unions and similar campus locations. We need contacts whose job mandate includes processing inbound requests from external parties or students — not raw org-chart seniority.

${BIRYANI_MANDATE_TIER_GUIDANCE}

Source page URL: ${sourceUrl}
Page context (truncated):
---
${String(pageContext || "").slice(0, 4000)}
---

Contacts to score (use title + page context; titles alone are often ambiguous):
${JSON.stringify(payload, null, 2)}

For EACH contact, return:
- externality (0.0–1.0): does this role face outward to vendors, students, or external partners?
- decision_proximity (0.0–1.0): can they initiate or meaningfully influence a vendor placement, event approval, or the correct approval path?
- exclude_reason: null OR one of "too senior" | "internal only" | "academic" | "wrong dept" | "gatekeeper" | "hostile_dining_ops" | "business_school_unrelated" | "other"
- tier: integer 1–9 or null (routing label only)
- include: boolean

Decision rules:
- Include if (externality > 0.7 AND decision_proximity > 0.4), EXCEPT use judgment below.
- Elected student government or cultural org officers: high include when title is elected role (President, VP, Chair) and student-facing; staff advisors to those bodies are often internal-only (exclude).
- EHS / food safety / permit: include (true) for pre-clearance channel even if placement decision_proximity is low — they are mandatory early contacts.
- Campus dining (tier 8): only include catering/special-events style roles that approve outside vendors for events; drop directors/ops/procurement per guidance.
- EXCLUDE graduate business school / MBA faculty-staff directories (e.g. email @anderson.*.edu, @business.*.edu) unless the role clearly supports campus-wide auxiliary services, commercial partnerships, or student-union-adjacent vendor programs — not generic faculty or program staff unrelated to main-campus vending.

Return ONLY valid JSON (no markdown):
{ "results": [ { "index": 0, "externality": 0.0, "decision_proximity": 0.0, "exclude_reason": null, "tier": null, "include": false } ] }
The results array MUST have one object per contact, same index order as input, length ${contacts.length}.`;

  if (OPENROUTER_API_KEY) {
    const resp = await withRetry(
      async () => {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.1,
            messages: [
              { role: "system", content: "Return only strict JSON. No markdown." },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (r.status === 429 || r.status === 503) {
          const t = await r.text().catch(() => "");
          throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 120)}`);
        }
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 220)}`);
        }
        return r;
      },
      { label: "OpenRouter mandate score", maxAttempts: 3, isRetryable: (msg) => /429|503|rate|quota/i.test(String(msg)) }
    );
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSONObject(text);
    const results = parsed?.results;
    if (!Array.isArray(results)) throw new Error("OpenRouter mandate: missing results array");
    return mergeMandateScores(contacts, results);
  }

  if (!API_KEY) throw new Error("No OPENROUTER_API_KEY or GOOGLE_API_KEY for mandate scoring");
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
  });
  const result = await withRetry(() => model.generateContent(prompt), {
    label: "Gemini mandate score",
    isRetryable: isGeminiQuotaError,
    maxAttempts: 4,
  });
  const text = result.response.text();
  const parsed = extractJSONObject(text);
  const results = parsed?.results;
  if (!Array.isArray(results)) throw new Error("Gemini mandate: missing results array");
  return mergeMandateScores(contacts, results);
}

async function filterContactsByMandate(rows, pageContext, sourceUrl) {
  if (!rows?.length) return [];

  const briefing = [];
  const elected = [];
  const rest = [];
  for (const c of rows) {
    if (String(c.relevance_to_biryani_blitz || "").trim().length > 15) {
      briefing.push({
        ...c,
        mandate_include: true,
        mandate_scorer: "extraction_briefing",
        mandate_exclude_reason: null,
        mandate_externality: Number.isFinite(Number(c.externality_score)) ? Number(c.externality_score) : null,
        mandate_decision_proximity: Number.isFinite(Number(c.decision_proximity_score))
          ? Number(c.decision_proximity_score)
          : null,
        mandate_tier_suggested: c.tier ?? null,
      });
    } else if (isElectedStudentOrgFastPath(c.title, sourceUrl)) {
      elected.push({
        ...c,
        is_elected_student_role: true,
        mandate_include: true,
        mandate_scorer: "elected_student_fast_path",
        mandate_exclude_reason: null,
        mandate_externality: 1,
        mandate_decision_proximity: 0.85,
        mandate_tier_suggested: c.tier ?? 3,
      });
    } else {
      rest.push(c);
    }
  }

  if (rest.length === 0) {
    const merged = [...elected, ...briefing];
    console.log(
      `      ↪ mandate filter: kept ${merged.length} (${elected.length} elected, ${briefing.length} briefing), 0 scored`
    );
    return merged;
  }

  const useLlm = shouldUseLlmMandateScorer();
  let scored = [];

  if (useLlm && (OPENROUTER_API_KEY || API_KEY)) {
    try {
      scored = await scoreContactsMandateLLM(rest, pageContext, sourceUrl);
    } catch (e) {
      console.warn(`      ⚠ mandate LLM failed, regex fallback: ${String(e?.message || e).slice(0, 140)}`);
      scored = filterContactsByRegexMandate(rest);
    }
  } else {
    scored = filterContactsByRegexMandate(rest);
  }

  const keptFromScored = scored.filter((c) => c.mandate_include !== false);
  let dropped = 0;
  let dropLog = 0;
  for (const c of scored) {
    if (c.mandate_include === false) {
      dropped++;
      if (dropLog < 8 && c.mandate_exclude_reason) {
        console.log(`      ↪ mandate drop: ${c.email || c.name || "?"} — ${c.mandate_exclude_reason}`);
        dropLog++;
      }
    }
  }

  const out = [...elected, ...briefing, ...keptFromScored];
  console.log(
    `      ↪ mandate filter: kept ${out.length} (${elected.length} elected, ${briefing.length} briefing, ${keptFromScored.length} scored), dropped ${dropped}`
  );
  return out;
}

function extractEmailsFromRawHtml(html) {
  const stripped = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ");
  const emails = new Set();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const e = m[0].toLowerCase();
    if (e.length < 6 || e.length > 120) continue;
    emails.add(e);
  }
  return [...emails];
}

function extractContextWindow(bodyText, marker, radius = 150) {
  const text = String(bodyText || "");
  const needle = String(marker || "").trim();
  if (!text || !needle) return "";
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return "";
  return text.slice(Math.max(0, idx - radius), Math.min(text.length, idx + needle.length + radius));
}

function fallbackHashEmbedding(text, dims = 192) {
  const vec = new Array(dims).fill(0);
  const toks = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    vec[idx] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

async function embedText(text) {
  const provider = EMBEDDING_PROVIDER;
  if (provider === "openai" && OPENAI_API_KEY) {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: String(text || "").slice(0, 8000),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`OpenAI embeddings ${resp.status}: ${t.slice(0, 180)}`);
    }
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length === 0) throw new Error("OpenAI embeddings: missing vector");
    return emb;
  }
  return fallbackHashEmbedding(text);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    ma += av * av;
    mb += bv * bv;
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom > 0 ? dot / denom : 0;
}

let cachedIdealTierEmbeddings = null;
async function getIdealTierEmbeddings() {
  if (cachedIdealTierEmbeddings) return cachedIdealTierEmbeddings;
  const out = {};
  for (const [tier, text] of Object.entries(IDEAL_CONTACT_EMBEDDING_TEXT)) {
    out[String(tier)] = await embedText(text);
  }
  cachedIdealTierEmbeddings = out;
  return out;
}

function scoreExcludeReason(contact, similarity) {
  const title = String(contact?.title || "").toLowerCase();
  if (/professor|faculty|instructor|lecturer|researcher/.test(title)) return "academic / faculty";
  if (/^(vice chancellor|provost|president|chancellor|dean)\b/.test(title)) return "too senior / wrong entry point";
  if (/\bassistant to\b/.test(title)) return "internal ops only";
  if (!normalizeEmail(contact?.email)) return "email not found on page";
  if (similarity < 0.5) return "no external vendor mandate";
  return "below similarity threshold";
}

async function scoreContactsByEmbedding(rows, pageText) {
  if (!rows?.length) return [];
  const ideal = await getIdealTierEmbeddings();
  const scored = [];
  for (const c of rows) {
    const pageContext =
      String(c.pageContext || "").trim() ||
      extractContextWindow(pageText, c.email || c.name || "", 150);
    const contactText = [c.title, c.department, pageContext].filter(Boolean).join(". ");
    if (!String(contactText).trim()) {
      scored.push({
        ...c,
        pageContext,
        embedding_similarity: 0,
        externality_score: 0,
        decision_proximity_score: 0,
        include: false,
        exclude_reason: "no external vendor mandate",
      });
      continue;
    }
    const emb = await embedText(contactText);
    let bestTier = null;
    let best = -1;
    for (const [tier, idealEmb] of Object.entries(ideal)) {
      const sim = cosineSimilarity(emb, idealEmb);
      if (sim > best) {
        best = sim;
        bestTier = Number(tier);
      }
    }
    const elected = isElectedStudentOrgFastPath(c.title, c.source_url || "");
    const ext = Math.max(0, Math.min(1, best));
    const decision = Math.max(0, Math.min(1, 0.55 * ext + (elected ? 0.35 : 0)));
    const hasEmail = !!normalizeEmail(c.email);
    const include =
      elected ||
      (hasEmail &&
        !["too senior / wrong entry point", "academic / faculty"].includes(scoreExcludeReason(c, best)) &&
        best >= EMBEDDING_INCLUDE_THRESHOLD);
    scored.push({
      ...c,
      pageContext,
      tier: bestTier ?? c.tier ?? null,
      embedding_similarity: Number(best.toFixed(4)),
      externality_score: Number(ext.toFixed(4)),
      decision_proximity_score: Number(decision.toFixed(4)),
      include,
      exclude_reason: include ? null : scoreExcludeReason(c, best),
    });
  }
  return scored;
}

function dedupeContactsStable(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const email = normalizeEmail(row?.email);
    const key =
      email ||
      `${String(row?.university || "").toLowerCase()}|${String(row?.source_url || "").toLowerCase()}|${String(row?.name || "").toLowerCase()}|${String(row?.title || "").toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function emailLooksLiteral(email, bodyText, mailtos, htmlEmails) {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return false;
  for (const m of mailtos || []) {
    if (normalizeEmail(m?.email) === e) return true;
  }
  if (bodyText && bodyText.toLowerCase().includes(e)) return true;
  if (htmlEmails && htmlEmails.includes(e)) return true;
  return false;
}

async function verifyEmailMx(email) {
  const domain = email.split("@")[1];
  if (!domain) return true;
  try {
    const mx = await dns.resolveMx(domain);
    return mx && mx.length > 0;
  } catch {
    return false;
  }
}

function hostnameKey(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function resolvePrimaryEduDomain(universityName) {
  const uni = String(universityName || "").trim();
  if (!uni) return "";
  const prompt = `What is the primary public .edu domain for this U.S. university's main campus (the domain used for official sites and email, e.g. unc.edu, berkeley.edu)?

University: ${JSON.stringify(uni)}

Return ONLY JSON: {"domain":"unc.edu"}
Rules: hostname only, no www, no path. If unknown, {"domain":""}.`;

  const parseDomain = (text) => {
    const parsed = extractJSONObject(text);
    const d = normalizeDomainHint(parsed?.domain);
    if (d && /\.edu/i.test(d)) return d;
    return "";
  };

  if (OPENROUTER_API_KEY) {
    try {
      const resp = await withTimeout(
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0,
            messages: [
              { role: "system", content: "Return only strict JSON." },
              { role: "user", content: prompt },
            ],
          }),
        }),
        14000,
        "OpenRouter primary domain"
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || "";
        const d = parseDomain(text);
        if (d) return d;
      }
    } catch {
      /* empty */
    }
  }

  if (!API_KEY) return "";
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    });
    const result = await withRetry(() => withTimeout(model.generateContent(prompt), 20000, "Gemini primary domain"), {
      label: "primary .edu domain",
      isRetryable: isGeminiQuotaError,
    });
    const text = result.response.text();
    return parseDomain(text);
  } catch {
    return "";
  }
}

/** Tier-specific phrases for "@domain" and site: searches (people + email in same SERP snippet). */
function domainAnchoredPhrasesForTier(tier, entrepreneurship) {
  const ent = (entrepreneurship || "entrepreneurship").trim();
  const map = {
    1: [
      ["director", "student union"],
      ["commercial", "student union"],
      ["business development", "union"],
      ["vendor", "auxiliary"],
    ],
    2: [
      ["director", "student affairs"],
      ["dean", "students"],
      ["associate vice president", "student affairs"],
    ],
    3: [
      ["student government", "president"],
      ["student senate", "email"],
      ["student body president", ""],
    ],
    4: [
      ["director", ent],
      ["innovation", "venture"],
      ["startup", "program"],
    ],
    5: [
      ["director", "multicultural"],
      ["diversity", "student affairs"],
    ],
    6: [
      ["sustainability", "director"],
      ["zero waste", "campus"],
    ],
    7: [
      ["food truck", "coordinator"],
      ["mobile vending", "campus"],
    ],
    8: [
      ["director", "dining"],
      ["food service", "director"],
      ["auxiliary", "dining services"],
    ],
    9: [
      ["environmental health", "safety"],
      ["food safety", "permit"],
      ["EHS", "director"],
    ],
  };
  return map[tier] || [["director", "staff"]];
}

function buildDomainAnchoredQueries(shortName, entrepreneurship, tier, officeInfo, domain) {
  const d = normalizeDomainHint(domain);
  if (!d) return [];
  const atDom = `"@${d}"`;
  const phrases = domainAnchoredPhrasesForTier(tier, entrepreneurship);
  const names = (officeInfo?.office_names || []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
  const seeds = (officeInfo?.seed_queries || []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3);
  const queries = [];

  for (const name of names) {
    queries.push({ tier, phrase: name, query: `${name} email ${atDom}` });
    queries.push({ tier, phrase: name, query: `site:${d} "${name}" staff email` });
    queries.push({ tier, phrase: name, query: `site:${d} "${name}" directory` });
  }
  for (const sq of seeds) {
    if (/site:|@/.test(sq)) queries.push({ tier, phrase: "seed", query: sq });
    else queries.push({ tier, phrase: "seed", query: `${sq} ${atDom}` });
  }
  for (const [a, b] of phrases) {
    const p1 = String(a || "").trim();
    const p2 = String(b || "").trim();
    if (p1 && p2) {
      queries.push({ tier, phrase: `${p1} ${p2}`, query: `"${p1}" "${p2}" ${atDom}` });
      queries.push({ tier, phrase: `${p1} ${p2}`, query: `site:${d} "${p1}" "${p2}" email` });
    } else if (p1) {
      queries.push({ tier, phrase: p1, query: `"${p1}" ${atDom}` });
      queries.push({ tier, phrase: p1, query: `site:${d} "${p1}" email` });
    }
  }
  const uniq = [];
  const seen = new Set();
  for (const q of queries) {
    const k = q.query;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(q);
  }
  return uniq.slice(0, 14);
}

function atomicWriteJson(targetPath, value) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, targetPath);
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chromiumLaunchOptions() {
  const auto = ["--disable-blink-features=AutomationControlled"];
  const o = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_ARGS === "1" || process.env.RENDER) {
    o.args = [...auto, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
  } else {
    o.args = auto;
  }
  return o;
}

function isLikelyCampusPage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (
      /google\.|bing\.|duckduckgo\.|facebook\.|linkedin\.|youtube\.|instagram\.|twitter\.|x\.com|tiktok\.|reddit\.|pinterest\./.test(
        h
      )
    ) {
      return false;
    }
    return /\.edu$|\.edu\.|\.ac\.uk|\.gov/.test(h) || h.endsWith(".edu");
  } catch {
    return false;
  }
}

function unwrapSearchRedirect(raw) {
  const decodeBingU = (val) => {
    const s = String(val || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    const uriDecoded = (() => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })();
    if (/^https?:\/\//i.test(uriDecoded)) return uriDecoded;
    // Bing "u=" often looks like "a1aHR0cHM6Ly9..." (a1 + base64url(http...))
    const base = uriDecoded.replace(/^a1/i, "");
    const normalized = base.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
      const decoded = Buffer.from(normalized + pad, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* empty */
    }
    return "";
  };

  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();

    // DuckDuckGo HTML results often use /l/?uddg=<encoded target>
    if (h.includes("duckduckgo.com")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }

    // Google redirect: /url?q=, /url?url= (common when q is empty)
    if (h.includes("google.")) {
      const q = u.searchParams.get("q");
      if (q && /^https?:\/\//i.test(q)) return q;
      const urlParam = u.searchParams.get("url");
      if (urlParam && /^https?:\/\//i.test(urlParam)) {
        try {
          return decodeURIComponent(urlParam);
        } catch {
          return urlParam;
        }
      }
      if ((u.pathname === "/url" || u.pathname.endsWith("/url")) && q) return q;
    }

    // Bing redirect wrappers: /ck/a?...&u=<encoded-target>
    if (h.includes("bing.com")) {
      const viaU = decodeBingU(u.searchParams.get("u"));
      if (viaU) return viaU;
      const viaUrl = decodeBingU(u.searchParams.get("url"));
      if (viaUrl) return viaUrl;
      const viaR = decodeBingU(u.searchParams.get("r"));
      if (viaR) return viaR;
    }
  } catch {
    /* empty */
  }
  return raw;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw0 of urls) {
    const raw = unwrapSearchRedirect(raw0);
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    u.hash = "";
    if (u.searchParams.has("utm_source")) u.searchParams.delete("utm_source");
    const key = u.href;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isLikelyCampusPage(key)) out.push(key);
  }
  return out;
}

async function searchDuckDuckGo(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://html.duckduckgo.com/html/?q=${enc}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await sleep(900);
  const links = await page
    .$$eval("a.result__a, a[href]", (as) =>
      as
        .map((a) => a.href)
        .filter(Boolean)
        .filter((href) => /uddg=|^https?:\/\//i.test(href))
    )
    .catch(() => []);
  return links;
}

async function searchBing(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://www.bing.com/search?q=${enc}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await sleep(900);
  const links = await page
    .$$eval("li.b_algo h2 a, h2 a, a[href]", (as) =>
      as
        .map((a) => a.href)
        .filter(Boolean)
        .filter((href) => /^https?:\/\//i.test(href))
    )
    .catch(() => []);
  return links;
}

/** EU/consent screens — click through so real results load. */
async function dismissGoogleConsent(page) {
  const tryClick = async (locator) => {
    try {
      if (await locator.isVisible({ timeout: 600 })) {
        await locator.click({ timeout: 3000 });
        await sleep(800);
        return true;
      }
    } catch {
      /* keep going */
    }
    return false;
  };
  await tryClick(page.getByRole("button", { name: /^Accept all$/i }).first());
  await tryClick(page.getByRole("button", { name: /^I agree$/i }).first());
  await tryClick(page.locator("#L2AGLb"));
  await tryClick(page.locator("button").filter({ hasText: /^Accept$/i }).first());
}

/**
 * Google changes SERP markup often; collect links from #rso (and fallbacks), not only "a h3".
 */
async function searchGoogle(page, query) {
  const enc = encodeURIComponent(query);
  await page.goto(`https://www.google.com/search?q=${enc}&num=10&hl=en&gl=us&pws=0`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await dismissGoogleConsent(page);
  await page.locator("#rso").waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  await sleep(900);

  const blockedHint = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  if (/unusual traffic|automated queries|I'm not a robot|reCAPTCHA|can't verify you're not a robot/i.test(blockedHint)) {
    console.log("  (Google blocked or showed CAPTCHA — use Bing/DuckDuckGo fallbacks for this query)");
    return [];
  }

  const links = await page
    .evaluate(() => {
      const skip = (u) =>
        !u ||
        /google\.com\/(search\?|intl\/|maps|imgres|travel|flights|accounts)/i.test(u) ||
        /support\.google|policies\.google|chrome\.google|play\.google/i.test(u);

      const pushUnique = (set, arr, href) => {
        if (!href || skip(href)) return;
        if (set.has(href)) return;
        set.add(href);
        arr.push(href);
      };

      const out = [];
      const seen = new Set();

      const collectFrom = (root) => {
        if (!root) return;
        root.querySelectorAll("a[href]").forEach((a) => {
          pushUnique(seen, out, a.href);
        });
      };

      collectFrom(document.querySelector("#rso"));
      collectFrom(document.querySelector("#center_col"));

      // Legacy layout: title links
      document.querySelectorAll("a h3").forEach((h3) => {
        const a = h3.closest("a");
        if (a?.href) pushUnique(seen, out, a.href);
      });

      if (out.length < 2) {
        collectFrom(document.querySelector("main"));
      }
      if (out.length < 2) {
        collectFrom(document.body);
      }

      return out;
    })
    .catch(() => []);

  return links;
}

function isGenericCampusPage(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "/").toLowerCase().replace(/\/+$/, "") || "/";
    return p === "/" || p === "/about" || p === "/students";
  } catch {
    return false;
  }
}

function urlRelevanceScore(url) {
  const s = String(url || "").toLowerCase();
  let score = 0;
  if (/directory|staff|leadership|team|contact|people/.test(s)) score += 5;
  if (/student[-_]?affairs|student[-_]?life|student[-_]?government|auxiliary|dining/.test(s)) score += 4;
  if (/union|vendor|commercial|partnership|entrepreneur|innovation|sustainab|ehs|safety|permit/.test(s))
    score += 3;
  if (isGenericCampusPage(s)) score -= 6;
  return score;
}

function universityMarkers(universityName) {
  const raw = String(universityName || "").toLowerCase();
  const clean = raw.replace(/[^a-z0-9\s]/g, " ");
  const parts = clean.split(/\s+/).filter(Boolean);
  const stop = new Set(["the", "of", "at", "for", "and", "in"]);
  const markers = new Set();

  // Keep full tokens that can appear in host/path (e.g., nyu, berkeley, carolina).
  for (const p of parts) {
    if (p.length >= 3 && !stop.has(p)) markers.add(p);
  }

  // Acronym catches UW, UNC, NYU, etc.
  const acronymWords = parts.filter((p) => p.length > 0 && !stop.has(p));
  if (acronymWords.length >= 2) {
    const ac = acronymWords.map((w) => w[0]).join("");
    if (ac.length >= 2) markers.add(ac);
  }

  // Two-word slug catches cases like chapelhill, stonybrook.
  if (acronymWords.length >= 2) {
    for (let i = 0; i < acronymWords.length - 1; i++) {
      const a = acronymWords[i];
      const b = acronymWords[i + 1];
      if (a.length >= 3 && b.length >= 3) markers.add(`${a}${b}`);
    }
  }

  return [...markers];
}

function urlMatchesUniversity(url, markers) {
  if (!markers?.length) return true;
  let hay = "";
  try {
    const u = new URL(url);
    hay = `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return false;
  }
  for (const m of markers) {
    if (!m) continue;
    if (m.length <= 3) {
      const re = new RegExp(`(^|[^a-z0-9])${m}([^a-z0-9]|$)`, "i");
      if (re.test(hay)) return true;
    } else if (hay.includes(m)) {
      return true;
    }
  }
  return false;
}

function pickCrawlSeeds(firstTierByUrl, tiers, markers, perTier) {
  const byTier = new Map();
  for (const t of tiers) byTier.set(t, []);
  for (const [u, t] of firstTierByUrl.entries()) {
    if (!byTier.has(t)) continue;
    try {
      if (!isLikelyCampusPage(u)) continue;
      if (markers?.length && !urlMatchesUniversity(u, markers)) continue;
    } catch {
      continue;
    }
    byTier.get(t).push(u);
  }
  const seeds = [];
  for (const t of tiers) {
    const urls = (byTier.get(t) || []).sort((a, b) => urlRelevanceScore(b) - urlRelevanceScore(a)).slice(0, perTier);
    for (const url of urls) seeds.push({ url, tier: t });
  }
  return seeds;
}

/** Breadth-first crawl: hub → staff/people links → deeper directory pages (depth from CRAWL_PEOPLE_DEPTH). */
async function crawlPeopleLinksFromUrl(browser, startUrl, markers, maxLinks) {
  const maxDepth = CRAWL_PEOPLE_DEPTH;
  const pageBudget = CRAWL_PEOPLE_MAX_PAGES;
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const collect = () => {
    const patterns =
      /people|about|staff|directory|team|contact|leadership|officers|board|faculty|our-team|who we are|meet|bios/i;
    const out = [];
    const seen = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      let href = a.getAttribute("href");
      if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:"))
        return;
      let abs;
      try {
        abs = new URL(href, location.href).href;
      } catch {
        return;
      }
      const t = ((a.textContent || "") + " " + abs).toLowerCase();
      if (!patterns.test(t)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    });
    return out;
  };

  const visited = new Set();
  const out = [];
  let frontier = [{ url: startUrl, d: 0 }];

  try {
    while (frontier.length && out.length < maxLinks && visited.size < pageBudget) {
      const nextFront = [];
      for (const { url, d } of frontier) {
        if (visited.has(url)) continue;
        visited.add(url);
        const page = await browser.newPage({ userAgent: ua });
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await sleep(450);
          const raw = await page.evaluate(collect);
          const deduped = dedupeUrls(raw);
          const scoped = markers?.length ? deduped.filter((u) => urlMatchesUniversity(u, markers)) : deduped;
          for (const u of scoped) {
            if (out.length < maxLinks && !out.includes(u)) out.push(u);
          }
          if (d < maxDepth) {
            for (const u of scoped.slice(0, 16)) {
              if (!visited.has(u) && !nextFront.some((x) => x.url === u)) {
                nextFront.push({ url: u, d: d + 1 });
              }
            }
          }
        } catch (e) {
          console.log(`      ↪ people crawl: ${String(e?.message || e).slice(0, 100)}`);
        } finally {
          await page.close();
        }
        if (visited.size >= pageBudget) break;
      }
      frontier = nextFront;
    }
  } catch (e) {
    console.log(`      ↪ people crawl: ${String(e?.message || e).slice(0, 100)}`);
  }
  return out.slice(0, maxLinks);
}

async function discoverUrls(browser, universityName, entrepreneurship, maxPages, opts) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 864 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const tiers = normalizeTiers(opts.tiers);
  const tierAliases = await resolveTierTerminology({ universityName, entrepreneurship, tiers });
  const markers = universityMarkers(universityName);
  const primaryDomain = normalizeDomainHint(opts.primaryDomain || "");
  if (primaryDomain) {
    console.log(`  Primary .edu domain (search anchor): ${primaryDomain}`);
  }
  const crawlPerTier = Math.min(3, Math.max(1, parseInt(process.env.CRAWL_SEEDS_PER_TIER || "2", 10) || 2));
  const crawlMaxLinks = Math.min(12, Math.max(4, parseInt(process.env.CRAWL_MAX_LINKS || "10", 10) || 10));

  let queries = [];
  if (MULTI_STAGE_SEARCH) {
    console.log(`  Multi-stage search: on (campus office names + people/about crawl)`);
    for (const t of tiers) {
      const aliases = Array.isArray(tierAliases?.[String(t)])
        ? tierAliases[String(t)]
        : Array.isArray(tierAliases?.[t])
          ? tierAliases[t]
          : [];
      console.log(`  [T${t}] campus office lookup…`);
      const office = await resolveCampusOfficeForTier({
        universityName,
        tier: t,
        entrepreneurship,
        aliasArr: aliases,
      });
      if (office?.office_names?.length) {
        console.log(`    → offices: ${office.office_names.slice(0, 4).join(" · ")}`);
      } else {
        console.log(`    → offices: (fallback to generic category queries)`);
      }
      const od = normalizeDomainHint(office?.primary_domain_hint);
      if (od && od !== primaryDomain) {
        console.log(`    → office domain hint: ${od}`);
      }
      queries.push(
        ...buildQueriesForTierWithOffices(universityName, entrepreneurship, t, tierAliases, office, primaryDomain)
      );
    }
  } else {
    queries = buildTierQueries(universityName, entrepreneurship, tiers, tierAliases, primaryDomain);
  }

  const interSearchDelay = Math.min(opts.delayMs, 3500);
  // DDG HTML is frequently slow/blocked on hosted infra; keep it optional and last.
  const useDuckDuckGo = process.env.SEARCH_DDG === "1";
  if (Object.keys(tierAliases || {}).length > 0) {
    console.log(`  Search terminology aliases: ${JSON.stringify(tierAliases)}`);
  }

  const collected = [];
  const firstTierByUrl = new Map();
  let totalGoogleLinks = 0;
  let totalBingLinks = 0;
  try {
    for (let i = 0; i < queries.length; i++) {
      const qObj = queries[i];
      const q = qObj.query;
      const qLabel = `${i + 1}/${queries.length}`;
      console.log(`  [search ${qLabel}] [T${qObj.tier}] ${q}`);
      let links = [];
      let googleLinks = [];
      try {
        const t0 = Date.now();
        googleLinks = await withTimeout(searchGoogle(page, q), 30000, "Google search");
        links = googleLinks;
        totalGoogleLinks += googleLinks.length;
        console.log(`    Google: ${googleLinks.length} link(s) in ${Date.now() - t0}ms`);
      } catch (e) {
        console.log(`    Google: failed (${String(e?.message || e).slice(0, 120)})`);
        links = [];
      }
      if (links.length < 2) {
        let bingLinks = [];
        try {
          const t0 = Date.now();
          bingLinks = await withTimeout(searchBing(page, q), 15000, "Bing search");
          links = bingLinks;
          totalBingLinks += bingLinks.length;
          console.log(`    Bing: ${bingLinks.length} link(s) in ${Date.now() - t0}ms`);
        } catch (e) {
          console.log(`    Bing: failed (${String(e?.message || e).slice(0, 120)})`);
        }
      }
      if (links.length < 2 && useDuckDuckGo) {
        try {
          const t0 = Date.now();
          links = await withTimeout(searchDuckDuckGo(page, q), 10000, "DuckDuckGo search");
          console.log(`    DuckDuckGo: ${links.length} link(s) in ${Date.now() - t0}ms`);
        } catch (e) {
          console.log(`    DuckDuckGo: failed (${String(e?.message || e).slice(0, 120)})`);
        }
      }
      for (const raw of links) {
        const key = unwrapSearchRedirect(raw);
        if (!firstTierByUrl.has(key)) firstTierByUrl.set(key, qObj.tier);
      }
      collected.push(...links);
      await sleep(interSearchDelay);
    }
  } finally {
    await context.close();
  }

  const tierPhrase = {
    1: "student union commercial",
    2: "student affairs student life",
    3: "student government",
    4: entrepreneurship || "entrepreneurship center",
    5: "multicultural south asian",
    6: "sustainability",
    7: "food truck mobile vendor",
    8: "dining services",
    9: "environmental health and safety",
  };
  const computeDeduped = (urls) => {
    let d = dedupeUrls(urls).sort((a, b) => urlRelevanceScore(b) - urlRelevanceScore(a));
    const ng = d.filter((u) => !isGenericCampusPage(u));
    if (ng.length > 0) d = ng;
    const sc = d.filter((u) => urlMatchesUniversity(u, markers));
    if (sc.length > 0) d = sc;
    return { deduped: d, nonGeneric: ng };
  };

  let { deduped, nonGeneric } = computeDeduped(collected);
  if (deduped.length === 0 && primaryDomain && totalGoogleLinks === 0 && totalBingLinks > 0) {
    console.log(
      `  ↪ safety net: Google returned 0 while Bing had ${totalBingLinks}; retrying direct site:${primaryDomain} queries`
    );
    const retryContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 864 },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    });
    const retryPage = await retryContext.newPage();
    try {
      for (const t of tiers) {
        const phrase = tierPhrase[t] || "student services";
        const retryQuery = `site:${primaryDomain} "${phrase}" email`;
        let retryLinks = [];
        try {
          retryLinks = await withTimeout(searchBing(retryPage, retryQuery), 15000, "Bing safety-net search");
        } catch {
          retryLinks = [];
        }
        for (const raw of retryLinks) {
          const key = unwrapSearchRedirect(raw);
          if (!firstTierByUrl.has(key)) firstTierByUrl.set(key, t);
        }
        collected.push(...retryLinks);
        await sleep(Math.min(interSearchDelay, 900));
      }
    } finally {
      await retryContext.close();
    }
    ({ deduped, nonGeneric } = computeDeduped(collected));
  }

  if (MULTI_STAGE_SEARCH) {
    const seeds = pickCrawlSeeds(firstTierByUrl, tiers, markers, crawlPerTier);
    console.log(`  People / about crawl: ${seeds.length} seed page(s)`);
    for (const { url: seedUrl, tier: seedTier } of seeds) {
      console.log(`    ↪ crawl hub: [T${seedTier}] ${seedUrl}`);
      const inner = await crawlPeopleLinksFromUrl(browser, seedUrl, markers, crawlMaxLinks);
      for (const raw of inner) {
        const key = unwrapSearchRedirect(raw);
        let normalized;
        try {
          const u = new URL(key);
          u.hash = "";
          if (u.searchParams.has("utm_source")) u.searchParams.delete("utm_source");
          normalized = u.href;
        } catch {
          normalized = key;
        }
        if (!firstTierByUrl.has(normalized)) firstTierByUrl.set(normalized, seedTier);
        collected.push(raw);
      }
      if (inner.length) {
        console.log(`      +${inner.length} internal link(s) (people/directory/about)`);
      }
      await sleep(Math.min(interSearchDelay, 1200));
    }
  }

  ({ deduped, nonGeneric } = computeDeduped(collected));

  // Coverage pass: keep at least one URL per selected tier when available.
  const tierBuckets = new Map();
  for (const t of tiers) tierBuckets.set(t, []);
  for (const u of deduped) {
    const t = firstTierByUrl.get(u);
    if (!t || !tierBuckets.has(t)) continue;
    tierBuckets.get(t).push(u);
  }
  const diversified = [];
  const seen = new Set();
  for (const t of tiers) {
    const bucket = tierBuckets.get(t) || [];
    if (!bucket.length) continue;
    const pick = bucket[0];
    if (!seen.has(pick)) {
      diversified.push(pick);
      seen.add(pick);
    }
  }
  for (const u of deduped) {
    if (seen.has(u)) continue;
    diversified.push(u);
    seen.add(u);
  }
  if (diversified.length) deduped = diversified;

  console.log(`  Scoped URLs for "${universityName}": ${deduped.length}/${nonGeneric.length || deduped.length}`);
  const covered = tiers.filter((t) => (tierBuckets.get(t) || []).length > 0);
  console.log(`  Tier URL coverage: ${covered.length}/${tiers.length} (${covered.map((t) => `T${t}`).join(", ") || "none"})`);
  deduped = deduped.slice(0, maxPages);
  if (deduped.length === 0) {
    console.log("  (search engines returned no usable URLs)");
  }
  return deduped;
}

async function extractMailtos(page) {
  return page.$$eval("a[href^='mailto:'],a[href^='MAILTO:']", (anchors) =>
    anchors.map((a) => {
      const raw = a.getAttribute("href") || "";
      const email = decodeURIComponent(raw.replace(/^mailto:/i, "").split("?")[0]);
      return { email, linkText: (a.textContent || "").trim().slice(0, 200) };
    })
  );
}

async function fetchPage(browser, url) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(700 * attempt);
      }
    }
    await sleep(450);
    await page.evaluate(() => {
      try {
        document.querySelectorAll("[data-email], [data-user], [data-domain]").forEach((el) => {
          const full = (el.dataset.email || "").trim();
          if (full.includes("@")) {
            const t = el.textContent || "";
            if (!t.includes("@")) el.textContent = full;
            return;
          }
          const user = (el.dataset.user || "").trim();
          const domain = (el.dataset.domain || "").trim();
          if (user && domain && !user.includes("@")) {
            const combined = `${user}@${domain}`;
            const t = el.textContent || "";
            if (!t.includes("@")) el.textContent = combined;
          }
        });
      } catch {
        /* empty */
      }
      try {
        if (document.body?.innerHTML) {
          document.body.innerHTML = document.body.innerHTML
            .replace(/\[at\]/gi, "@")
            .replace(/\(at\)/gi, "@")
            .replace(/\[dot\]/gi, ".")
            .replace(/\(dot\)/gi, ".");
        }
      } catch {
        /* empty */
      }
    });
    await page.waitForSelector("a[href^='mailto:']", { timeout: 2000 }).catch(() => {});
    const title = await page.title();
    const bodyText = await page.innerText("body");
    const rawHtml = await page.content();
    const mailtos = await extractMailtos(page);
    const htmlEmails = extractEmailsFromRawHtml(rawHtml);
    const allEmailObjects = [
      ...(mailtos || []).map((m) => ({ email: normalizeEmail(m?.email) })),
      ...htmlEmails.map((e) => ({ email: normalizeEmail(e) })),
    ].filter((x) => x.email && x.email.includes("@"));
    const contextWindows = {};
    for (const e of allEmailObjects) {
      if (contextWindows[e.email]) continue;
      const ctx = extractContextWindow(bodyText, e.email, 150);
      if (ctx) contextWindows[e.email] = ctx;
    }
    return {
      url,
      finalUrl: page.url(),
      title,
      bodyText: bodyText.slice(0, 100000),
      rawHtml: rawHtml.slice(0, 400000),
      mailtos,
      htmlEmails,
      contextWindows,
    };
  } finally {
    await page.close();
  }
}

function extractJSON(text) {
  const clean = text.replace(/```json\n?|```\n?/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractJSONObject(text) {
  const clean = text.replace(/```json\n?|```\n?/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Uses Google AI Studio (Gemini) to fix typos, expand abbreviations (e.g. UNC, UCLA),
 * and disambiguate multi-campus systems so search queries find the right .edu pages.
 */
function isGeminiQuotaError(msg) {
  return /429|Too Many Requests|quota|Quota exceeded|exceeded your current quota|free_tier/i.test(
    String(msg)
  );
}

function inferTierFromUrl(url) {
  const c = classifyUrlTier(url);
  if (c != null) return c;
  const s = String(url || "").toLowerCase();
  if (/dining|food|meal|auxiliary/.test(s)) return 8;
  if (/studentaffairs|students|student-life|studentlife/.test(s)) return 2;
  if (/sustainab|green/.test(s)) return 6;
  if (/government|student-gov|asg|asuc/.test(s)) return 3;
  if (/health|ehs|safety|permit/.test(s)) return 9;
  return 0;
}

function displayNameFromEmailLocal(email) {
  const local = String(email).split("@")[0] || "";
  if (!local) return "";
  const parts = local.split(/[._]+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/** Best-effort title from the line/block containing the email in page text. */
function sniffTitleNearEmail(bodyText, email) {
  const text = String(bodyText || "");
  if (!email || !text.includes(email)) return "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(email)) continue;
    const idx = line.indexOf(email);
    const before = line.slice(0, idx).replace(/[,|•\t]/g, " ").trim();
    if (before.length > 2 && before.length < 180) return before;
    if (i > 0) {
      const prev = lines[i - 1].trim();
      if (prev.length > 2 && prev.length < 180 && !prev.includes("@")) return prev;
    }
  }
  return "";
}

function mailtoFallbackContacts({ mailtos, university, sourceUrl }) {
  const tier = classifyUrlTier(sourceUrl) ?? inferTierFromUrl(sourceUrl);
  const out = [];
  for (const m of mailtos || []) {
    const email = String(m?.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) continue;
    const hint = String(m?.linkText || "").trim();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+$/.test(hint);
    const nameFromHint = hint && !looksLikeEmail ? hint : displayNameFromEmailLocal(email);
    out.push({
      name: nameFromHint || displayNameFromEmailLocal(email) || null,
      title: "mailto contact",
      email,
      tier: tier || undefined,
      confidence: "low",
      source_url: sourceUrl,
      university,
    });
  }
  return dedupeContactsByEmail(out);
}

async function resolveUniversityWithGemini(u) {
  if (!API_KEY) return null;
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  });

  const name = String(u.name || "").trim();
  const city = String(u.city || "").trim();
  const entHint = String(u.entrepreneurship || "").trim();

  const prompt = `You resolve U.S. college/university names for web search and outreach.

User input (may contain typos, nicknames, or ambiguous names like "University of North Carolina" without specifying Chapel Hill vs Charlotte):
- name: ${JSON.stringify(name)}
- city_or_region (optional): ${JSON.stringify(city)}
- entrepreneurship_center_hint (optional): ${JSON.stringify(entHint)}

Return ONLY a single JSON object (no markdown, no commentary) with this shape:
{
  "canonical_name": "Official full institution name for display (e.g. University of North Carolina at Chapel Hill)",
  "search_name": "Short phrase optimized for search engines — include city or well-known abbreviation if it disambiguates (e.g. UNC Chapel Hill or University of North Carolina Chapel Hill)",
  "city": "City, ST if known else empty string",
  "entrepreneurship": "Likely entrepreneurship/innovation center label for searches on this campus, or Entrepreneurship Center",
  "disambiguation": "Empty string if unambiguous; otherwise one short sentence"
}

Rules:
- Fix spelling. Expand common abbreviations when helpful for search (UNC, ASU, UIUC, etc.) while keeping search_name concise.
- If the name matches a multi-campus system and city is empty, choose the flagship/main undergraduate campus that people usually mean unless context clearly indicates otherwise; explain in disambiguation.
- If city is provided, match that campus.
- search_name must stay under 120 characters.`;

  let text;
  try {
    const result = await withRetry(() => model.generateContent(prompt), {
      label: "Gemini university resolve",
      isRetryable: isGeminiQuotaError,
      maxAttempts: 4,
    });
    text = result.response.text();
  } catch (e) {
    const msg = String(e?.message || e);
    console.warn(`  ⚠ Gemini university resolve failed after retries: ${msg.slice(0, 280)}`);
    return null;
  }

  const parsed = extractJSONObject(text);
  if (!parsed || typeof parsed.canonical_name !== "string") {
    return null;
  }

  const canonical_name = parsed.canonical_name.trim() || name;
  const search_name = String(parsed.search_name || canonical_name).trim() || name;
  const outCity = typeof parsed.city === "string" ? parsed.city.trim() : "";
  const entrepreneurship = String(parsed.entrepreneurship || entHint || "Entrepreneurship Center").trim();
  const disambiguation =
    typeof parsed.disambiguation === "string" ? parsed.disambiguation.trim() : "";

  return {
    canonical_name,
    search_name,
    city: outCity || city,
    entrepreneurship,
    disambiguation,
  };
}

/** Quick OpenRouter pass: nicknames / abbreviations → official name + search phrase (for Playwright + dashboard). */
async function resolveUniversityCanonicalOpenRouter(u) {
  if (!CANONICAL_UNIVERSITY_NAMES || !OPENROUTER_API_KEY) return null;
  const name = String(u.name || "").trim();
  if (!name) return null;
  const city = String(u.city || "").trim();
  const prompt = `The user typed a U.S. college or university reference. Return the official full institution name and a good web-search phrase for finding that campus.

Input: ${JSON.stringify(name)}
City/region hint (optional): ${JSON.stringify(city)}

Return ONLY JSON (no markdown):
{
  "canonical_name": "Official full name, e.g. University of Texas at Austin",
  "search_name": "Phrase for Google/Bing — use full name when possible; add city if disambiguation is needed"
}

Rules:
- Expand common abbreviations: UT Austin → University of Texas at Austin; UNC Chapel Hill → University of North Carolina at Chapel Hill when the Chapel Hill campus is meant.
- If input is ambiguous (e.g. "UNC" with no city), prefer the flagship Chapel Hill campus unless the hint suggests otherwise.
- search_name must be under 120 characters.`;

  try {
    const resp = await withTimeout(
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          temperature: 0.1,
          messages: [
            { role: "system", content: "Return only strict JSON objects." },
            { role: "user", content: prompt },
          ],
        }),
      }),
      12000,
      "OpenRouter canonical university"
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSONObject(text);
    if (!parsed || typeof parsed.canonical_name !== "string") return null;
    const canonical_name = parsed.canonical_name.trim() || name;
    const search_name = String(parsed.search_name || canonical_name).trim() || name;
    return {
      canonical_name,
      search_name,
      entrepreneurship: u.entrepreneurship,
      disambiguation: "",
    };
  } catch {
    return null;
  }
}

async function resolveTierTerminology({ universityName, entrepreneurship, tiers }) {
  if (!SEARCH_LLM_TERMS || !tiers?.length) return {};
  const name = String(universityName || "").trim();
  const ent = String(entrepreneurship || "").trim();
  if (!name) return {};

  const defaultTerms = {
    1: "student union commercial",
    2: "student affairs",
    3: "student government",
    4: ent || "entrepreneurship center",
    5: "multicultural center",
    6: "sustainability",
    7: "food truck",
    8: "dining services",
    9: "environmental health and safety",
  };
  const requested = tiers.map((t) => `T${t}=${defaultTerms[t] || "general staff"}`).join(", ");
  const prompt = `Return ONLY JSON object (no markdown) mapping tier numbers to up to 1 campus-specific alias phrase.

University: ${JSON.stringify(name)}
Entrepreneurship hint: ${JSON.stringify(ent)}
Requested tiers: ${requested}

Format:
{
  "1": ["optional alias"],
  "2": [],
  "4": ["Innovate Carolina"]
}

Rules:
- Include only aliases likely used by this campus for that department.
- Max 1 alias string per tier.
- Keep each alias under 40 chars.
- If unknown, return [] for that tier.
- Do not repeat generic words already in default terms unless campus-branded.`;

  if (OPENROUTER_API_KEY) {
    try {
      const resp = await withTimeout(
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.1,
            messages: [
              { role: "system", content: "Return only strict JSON objects." },
              { role: "user", content: prompt },
            ],
          }),
        }),
        14000,
        "OpenRouter search terminology"
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || "";
        const parsed = extractJSONObject(text);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch {
      /* empty */
    }
  }

  if (!API_KEY) return {};
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    });
    const result = await withRetry(
      () => withTimeout(model.generateContent(prompt), 14000, "Gemini search terminology"),
      { label: "Gemini search terminology", isRetryable: isGeminiQuotaError }
    );
    const text = result?.response?.text?.() || "";
    const parsed = extractJSONObject(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* empty */
  }
  return {};
}

/** LLM: real campus office / program names + seed queries for that category (multi-stage URL discovery). */
async function resolveCampusOfficeForTier({ universityName, tier, entrepreneurship, aliasArr }) {
  const uni = String(universityName || "").trim();
  if (!uni) return null;
  const hint = TIER_OFFICE_HINT[tier] || "student-facing university staff";
  const aliases = (aliasArr || []).map((x) => String(x || "").trim()).filter(Boolean);
  const prompt = `You name REAL offices, programs, or student-facing units at one U.S. university — names used on that campus .edu site.

University: ${JSON.stringify(uni)}
Outreach category focus: ${JSON.stringify(hint)}
Optional brand/alias hints: ${JSON.stringify(aliases)}

Return ONLY valid JSON (no markdown):
{
  "office_names": ["2-5 short names as the school lists them (e.g. Carolina Union, Division of Student Affairs, Graduate Student Government)"],
  "seed_queries": ["2-4 full search queries including the university name; use site:edu or site:unc.edu style when it helps"],
  "primary_domain_hint": "unc.edu or empty"
}

Rules:
- office_names must be specific to this campus when possible.
- seed_queries should surface the main .edu hub page (staff, people, directory, about).
- Do not invent email addresses.`;

  if (OPENROUTER_API_KEY) {
    try {
      const resp = await withTimeout(
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.15,
            messages: [
              { role: "system", content: "Return only strict JSON objects." },
              { role: "user", content: prompt },
            ],
          }),
        }),
        16000,
        "OpenRouter campus office resolve"
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || "";
        const parsed = extractJSONObject(text);
        if (parsed && Array.isArray(parsed.office_names)) return parsed;
      }
    } catch {
      /* empty */
    }
  }

  if (!API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: { temperature: 0.15, maxOutputTokens: 700 },
    });
    const result = await withRetry(
      () => withTimeout(model.generateContent(prompt), 16000, "Gemini campus office resolve"),
      { label: "Gemini campus office resolve", isRetryable: isGeminiQuotaError }
    );
    const text = result?.response?.text?.() || "";
    const parsed = extractJSONObject(text);
    if (parsed && Array.isArray(parsed.office_names)) return parsed;
  } catch {
    /* empty */
  }
  return null;
}

function buildBriefingExtractionPrompt({
  university,
  sourceUrl,
  pageTitle,
  bodyText,
  mailtos,
  htmlEmails,
  tierFocus,
  urlTierClass,
}) {
  const tierHint =
    tierFocus && tierFocus.length
      ? `
Outreach tier routing (C1–C9) for this run — assign tier when include is true:
${tierFocus.map((t) => `C${t}`).join(", ")}
C1=student union commercial, C2=student life, C3=student gov, C4=entrepreneurship, C5=cultural/SA, C6=sustainability, C7=food truck/mobile, C8=dining, C9=EHS/food safety
`
      : "";

  const urlTierBlock =
    urlTierClass != null && urlTierClass >= 1 && urlTierClass <= 9
      ? `
URL / site structure: the page strongly suggests category C${urlTierClass}. Prefer tier ${urlTierClass} when the person's role matches this part of campus unless their title clearly belongs elsewhere.
`
      : "";

  return `
You are a business development researcher for Biryani Blitz — a 
student-founded startup that places automated hot food vending machines 
serving fresh biryani bowls (~90 seconds, ~$8) inside university student 
unions. We are seeking placement approvals, vendor contracts, and student 
champions at universities across the US.

You are reviewing a university web page to identify people worth 
cold-emailing. Only set include:true if you can write a specific, 
non-generic sentence explaining exactly why they are relevant to 
getting a biryani vending machine placed on this campus (student union, auxiliary, dining approvals, permits, or student advocacy as applicable).

Page URL: ${sourceUrl}
University: ${university || "unknown"}
Page title: ${pageTitle || ""}
${urlTierBlock}
${tierHint}

Known mailto links (emails must match these or appear verbatim in page text — never guess):
${JSON.stringify(mailtos, null, 2)}

Emails also detected in HTML / attributes (may overlap mailto):
${JSON.stringify((htmlEmails || []).slice(0, 80), null, 2)}

Page text:
---
${String(bodyText || "").slice(0, 120000)}
---

Return ONLY a valid JSON array (no markdown). Include one object per person you seriously evaluate — including people you decide NOT to email — so we can audit exclusions. If nobody appears on the page, return [].

Each object MUST use this shape:
{
  "name": "Full name",
  "title": "Exact title from page",
  "email": "email — only if explicitly on page or in mailto, never guess; else null",
  "tier": 1-9 or null,
  "externality_score": 0.0-1.0,
  "decision_proximity_score": 0.0-1.0,
  "include": true|false,
  "relevance_to_biryani_blitz": "One specific sentence: what this person controls or influences that we need, and why that makes them worth emailing. Must reference their actual title and unit. Bad example: 'May be relevant to food programs.' Good example: 'As Director of Commercial Activities at the Student Union, Sarah approves vendor placement contracts for the building — the approval path we need before deployment.' — or null if include is false",
  "outreach_angle": "One sentence on how to open the cold email to this specific person — what aspect of their role to reference, what problem of theirs Biryani Blitz solves. — or null if include is false",
  "exclude_reason": null | "no external vendor mandate" | "too senior / wrong entry point" | "academic / faculty" | "internal ops only" | "email not found on page" | "business school unrelated" | "other"
}

Rules:
- Use this workflow:
  1) Start from explicit emails on the page (mailto + visible/HTML emails) and identify the person tied to each email.
  2) Determine whether that person is student-facing or external-partner-facing (vendor/commercial/programs/events/permits/student advocacy).
  3) If you find one strong candidate, scan nearby names/titles on the same page section (staff list, directory block, board list) because relevant contacts are often grouped.
- We only want contacts who are student-facing or external-partner-facing. Internal-only admin/research roles should be include:false.
- If include is false, still return the object for audit; set relevance_to_biryani_blitz and outreach_angle to null unless you need a brief justification only in exclude_reason.
- Never fabricate emails. If no email on page, set email null and include false.
- The relevance sentence must be specific to THIS person's role, not generic.
- A facilities coordinator who handles vendor logistics scores higher than a VP of Student Affairs who does not touch contracts or placements.
- Elected student leaders (student government presidents, cultural org chairs) are include:true when found with a verifiable email — they are student advocates.
`.trim();
}

function confidenceFromBriefingScores(c) {
  const e = Number(c.externality_score);
  const d = Number(c.decision_proximity_score);
  if (Number.isFinite(e) && Number.isFinite(d) && e >= 0.75 && d >= 0.6) return "high";
  if (Number.isFinite(e) && Number.isFinite(d) && e >= 0.55 && d >= 0.4) return "medium";
  if (Number.isFinite(e) || Number.isFinite(d)) return "low";
  return "low";
}

function looksStudentOrExternalFacingRole(row) {
  const title = String(row?.title || "").toLowerCase();
  const rel = String(row?.relevance_to_biryani_blitz || "").toLowerCase();
  const hay = `${title} ${rel}`;
  if (!hay.trim()) return false;
  if (isElectedStudentOrgFastPath(title, String(row?.source_url || ""))) return true;
  const positive =
    /\b(student|government|union|engagement|experience|life|programs?|events?|partnerships?|vendor|commercial|auxiliar|dining|food truck|mobile vendor|sustainability|zero waste|multicultural|cultural|ehs|environmental health|food safety|permit|compliance|services?)\b/i;
  const negative =
    /\b(professor|faculty|research|lecturer|instructor|laboratory|lab manager|it support|hr|human resources|payroll|registrar|bursar|accounting|internal audit)\b/i;
  return positive.test(hay) && !negative.test(hay);
}

function normalizeBriefingRows(rows, sourceUrl, universityLabel) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const row = {
      ...r,
      source_url: r.source_url || sourceUrl,
      university: universityLabel || r.university,
      confidence: r.confidence || confidenceFromBriefingScores(r),
    };
    if (row.include === true && !looksStudentOrExternalFacingRole(row)) {
      return {
        ...row,
        include: false,
        exclude_reason: row.exclude_reason || "no external vendor mandate",
        relevance_to_biryani_blitz: null,
        outreach_angle: null,
      };
    }
    return row;
  });
}

async function geminiExtract({
  university,
  sourceUrl,
  pageTitle,
  bodyText,
  mailtos,
  htmlEmails = [],
  tierFocus,
  urlTierClass,
}) {
  if (LLM_PROVIDER !== "openrouter" && !API_KEY) {
    throw new Error("Set GOOGLE_API_KEY (or GEMINI_API_KEY) from https://aistudio.google.com/apikey");
  }
  const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
  const model = genAI
    ? genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      })
    : null;

  const prompt = buildBriefingExtractionPrompt({
    university,
    sourceUrl,
    pageTitle,
    bodyText,
    mailtos,
    htmlEmails,
    tierFocus,
    urlTierClass,
  });

  async function openRouterExtract() {
    if (!OPENROUTER_API_KEY) return null;
    const resp = await withRetry(
      async () => {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.2,
            messages: [
              {
                role: "system",
                content:
                  "You are a business development researcher. Return only valid JSON arrays, never markdown or commentary.",
              },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (r.status === 429 || r.status === 503) {
          const t = await r.text().catch(() => "");
          throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 120)}`);
        }
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 220)}`);
        }
        return r;
      },
      {
        label: "OpenRouter extract",
        maxAttempts: 4,
        isRetryable: (msg) => /429|503|Too Many|rate|quota/i.test(String(msg)),
      }
    );
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed)) throw new Error("OpenRouter did not return a parseable JSON array");
    return normalizeBriefingRows(parsed, sourceUrl, university);
  }

  if (LLM_PROVIDER === "openrouter") {
    try {
      const raw = await openRouterExtract();
      // null = OpenRouter not configured; [] = model found nobody worth emailing (do not mailto-spam)
      if (raw === null) return mailtoFallbackContacts({ mailtos, university, sourceUrl });
      return raw;
    } catch (e) {
      console.warn(`      ⚠ OpenRouter extraction failed; falling back to mailto-only: ${String(e.message || e)}`);
      return mailtoFallbackContacts({ mailtos, university, sourceUrl });
    }
  }

  let text;
  try {
    const result = await withRetry(() => model.generateContent(prompt), {
      label: "Gemini extract",
      isRetryable: isGeminiQuotaError,
      maxAttempts: 4,
    });
    text = result.response.text();
  } catch (e) {
    const msg = String(e?.message || e);
    if (OPENROUTER_API_KEY) {
      try {
        console.warn(`      ⚠ Gemini extract failed (${msg.slice(0, 120)}); trying OpenRouter…`);
        return (await openRouterExtract()) || mailtoFallbackContacts({ mailtos, university, sourceUrl });
      } catch (orErr) {
        console.warn(`      ⚠ OpenRouter fallback failed: ${String(orErr.message || orErr)}`);
      }
    }
    console.warn(`      ↪ mailto-only fallback: ${msg.slice(0, 120)}`);
    return mailtoFallbackContacts({ mailtos, university, sourceUrl });
  }
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) {
    console.error("Gemini raw:", text.slice(0, 1500));
    return mailtoFallbackContacts({ mailtos, university, sourceUrl });
  }
  return normalizeBriefingRows(parsed, sourceUrl, university);
}

function dedupeContactsByEmail(rows) {
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    const e = String(c.email || "")
      .toLowerCase()
      .trim();
    if (!e || e === "null") continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(c);
  }
  return out;
}

function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}

function applyHeuristicEnrichContact(c, bodyText) {
  const email = c.email;
  let name = String(c.name || "").trim();
  if (!name || name === "null") name = displayNameFromEmailLocal(email);
  let title = String(c.title || "").trim();
  if (!title || title === "mailto contact") {
    const sn = sniffTitleNearEmail(bodyText, email);
    title = sn || "Contact (from directory page)";
  }
  const bio_snippet =
    name && title ? `${name} — ${title}`.slice(0, 280) : (title || "").slice(0, 280);
  let relevance_note = "";
  const dom = String(email).split("@")[1] || "";
  if (/anderson\.|\.business\.|mba\.|sloan\.|stanford\.gsb|wharton/i.test(dom)) {
    relevance_note =
      "Possible mismatch: email looks like a graduate business school domain. Biryani Blitz targets student union / auxiliary / dining approvals — verify this person is not only MBA-program staff before emailing.";
  }
  return { ...c, name, title, bio_snippet, relevance_note };
}

async function enrichOutreachCardsLLM(contacts, { pageTitle, bodyText, sourceUrl, university }) {
  if (!contacts.length) return contacts;
  const payload = contacts.map((c, i) => ({
    index: i,
    email: c.email,
    name: c.name,
    title: c.title,
    tier: c.tier,
  }));

  const prompt = `You prepare outreach notes for Biryani Blitz — a student-founded hot food vending venture seeking placement in student unions and campus auxiliary locations.

University: ${JSON.stringify(university)}
Page URL: ${sourceUrl}
Page title: ${pageTitle || ""}

Page text (use to recover real names and job titles; people often appear in lists near emails):
---
${String(bodyText || "").slice(0, 14000)}
---

Contacts (fix missing or generic name/title):
${JSON.stringify(payload, null, 2)}

For EACH contact index, return:
- name: best full name from the page; if impossible, derive a readable name from the email local-part (e.g. aki.fujii → Aki Fujii).
- title: specific job title or role from context — do not leave as "mailto contact" if the page lists a title.
- bio_snippet: one concise sentence describing who they are.
- relevance_note: 1–3 sentences on why they might matter for campus food vending, student union commercial services, auxiliary approvals, permits, or student-facing programs — OR state clearly "Poor fit for Biryani Blitz: ..." for graduate business school faculty/staff directories, research faculty, or roles with no path to main-campus vending or auxiliary partnerships.

Return ONLY valid JSON (no markdown):
{ "results": [ { "index": 0, "name": "", "title": "", "bio_snippet": "", "relevance_note": "" } ] }
The results array MUST have exactly ${contacts.length} entries in the same index order.`;

  const mergeEnrich = (results) => {
    const byIdx = new Map();
    for (const r of results || []) {
      const i = Number(r.index);
      if (Number.isFinite(i)) byIdx.set(i, r);
    }
    return contacts.map((c, i) => {
      const r = byIdx.get(i);
      if (!r) return applyHeuristicEnrichContact(c, bodyText);
      return {
        ...c,
        name: String(r.name || "").trim() || displayNameFromEmailLocal(c.email) || c.name,
        title: String(r.title || "").trim() || c.title,
        bio_snippet: String(r.bio_snippet || "").trim(),
        relevance_note: String(r.relevance_note || "").trim(),
      };
    });
  };

  if (OPENROUTER_API_KEY) {
    const resp = await withRetry(
      async () => {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            temperature: 0.2,
            messages: [
              { role: "system", content: "Return only strict JSON. No markdown." },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`OpenRouter enrich ${r.status}: ${t.slice(0, 200)}`);
        }
        return r;
      },
      { label: "OpenRouter outreach enrich", maxAttempts: 3, isRetryable: (msg) => /429|503|rate|quota/i.test(String(msg)) }
    );
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSONObject(text);
    const results = parsed?.results;
    if (!Array.isArray(results)) throw new Error("OpenRouter enrich: missing results");
    return mergeEnrich(results);
  }

  if (!API_KEY) throw new Error("No API key for outreach enrich");
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  });
  const result = await withRetry(() => model.generateContent(prompt), {
    label: "Gemini outreach enrich",
    isRetryable: isGeminiQuotaError,
    maxAttempts: 3,
  });
  const text = result.response.text();
  const parsed = extractJSONObject(text);
  const results = parsed?.results;
  if (!Array.isArray(results)) throw new Error("Gemini enrich: missing results");
  return mergeEnrich(results);
}

async function enrichOutreachCards(contacts, ctx) {
  if (!contacts.length) return contacts;
  const allBriefed = contacts.every(
    (c) =>
      String(c.relevance_to_biryani_blitz || "").trim().length > 10 &&
      String(c.outreach_angle || "").trim().length > 5
  );
  if (allBriefed) {
    return contacts.map((c) => ({
      ...c,
      relevance_note: String(c.relevance_note || c.relevance_to_biryani_blitz || "").trim(),
      bio_snippet:
        String(c.bio_snippet || "").trim() ||
        [c.name, c.title].filter(Boolean).join(" — ").slice(0, 280),
    }));
  }
  if (!ENRICH_OUTREACH_CARDS) {
    return contacts.map((c) => applyHeuristicEnrichContact(c, ctx.bodyText));
  }
  if (!OPENROUTER_API_KEY && !API_KEY) {
    return contacts.map((c) => applyHeuristicEnrichContact(c, ctx.bodyText));
  }
  try {
    return await enrichOutreachCardsLLM(contacts, ctx);
  } catch (e) {
    console.warn(`      ⚠ outreach enrich failed: ${String(e?.message || e).slice(0, 160)}`);
    return contacts.map((c) => applyHeuristicEnrichContact(c, ctx.bodyText));
  }
}

async function processUrls(browser, urls, universityLabel, allContacts, allExcluded, allInferred, tierFocus, ctx) {
  const seenEmails = ctx.seenEmails;
  const subdomainCounts = ctx.subdomainCounts;
  const cap = SUBDOMAIN_CONTACT_CAP;

  for (const url of urls) {
    let host = "";
    try {
      host = hostnameKey(url);
    } catch {
      host = "";
    }
    if (host && (subdomainCounts.get(host) || 0) >= cap) {
      console.log(`    ↪ skip (subdomain contact cap ${cap}): ${url}`);
      continue;
    }

    console.log(`    → ${url}`);
    let snap;
    try {
      snap = await fetchPage(browser, url);
    } catch (e) {
      console.error(`      ✗ Page failed: ${e.message}`);
      continue;
    }

    const mailtoEmails = (snap.mailtos || []).map((m) => normalizeEmail(m.email)).filter(Boolean);
    const htmlSet = snap.htmlEmails || [];
    const candidates = new Set([...mailtoEmails, ...htmlSet]);
    const allVisibleSeen =
      candidates.size > 0 && [...candidates].every((e) => e && seenEmails.has(e));
    if (allVisibleSeen) {
      console.log(`      ↪ skip LLM (all visible emails already in run)`);
      continue;
    }

    const urlClass = classifyUrlTier(snap.finalUrl);
    const inferredNum = inferTierFromUrl(snap.finalUrl);
    let urlTier = urlClass;
    if (urlTier == null) {
      urlTier = inferredNum > 0 ? inferredNum : tierFocus?.[0] ?? null;
    }

    console.log(
      `      ✓ ${snap.title?.slice(0, 70) || "(no title)"} · mailto: ${snap.mailtos.length} · html emails: ${htmlSet.length}`
    );

    let contacts;
    try {
      contacts = await geminiExtract({
        university: universityLabel,
        sourceUrl: snap.finalUrl,
        pageTitle: snap.title,
        bodyText: snap.bodyText,
        mailtos: snap.mailtos,
        htmlEmails: htmlSet,
        tierFocus,
        urlTierClass: urlClass ?? undefined,
      });
    } catch (e) {
      console.error(`      ✗ Extraction: ${e.message}`);
      continue;
    }

    const withMeta = (contacts || []).map((c) => {
      const email = normalizeEmail(c.email);
      const literal = emailLooksLiteral(email, snap.bodyText, snap.mailtos, htmlSet);
      const tierNum = urlTier != null ? urlTier : c.tier;
      const rel = String(c.relevance_to_biryani_blitz || "").trim();
      const bio =
        String(c.bio_snippet || "").trim() ||
        [c.name, c.title].filter(Boolean).join(" — ").slice(0, 280);
      const pageContext =
        String(c.pageContext || "").trim() ||
        (email && snap.contextWindows?.[email]) ||
        extractContextWindow(snap.bodyText, c.name || c.title || "", 150);
      return {
        ...c,
        email,
        tier: tierNum,
        university: universityLabel,
        tier_label: tierNum ? `Tier ${tierNum}` : null,
        evidence: literal ? "literal" : "inferred",
        source_url: snap.finalUrl,
        pageContext,
        relevance_note: rel || String(c.relevance_note || "").trim(),
        bio_snippet: bio,
      };
    });

    const extractionExcluded = withMeta.filter((c) => c && c.include === false);
    for (const row of extractionExcluded) {
      allExcluded.push({
        ...row,
        include: false,
        exclude_reason: row.exclude_reason || "excluded by extraction prompt",
      });
    }

    const scored = await scoreContactsByEmbedding(
      withMeta.filter((c) => c && c.include !== false),
      snap.bodyText
    );

    const keptForBrief = [];
    for (const row of scored) {
      if (row.include) keptForBrief.push(row);
      else allExcluded.push(row);
    }

    const enriched = await enrichOutreachCards(keptForBrief, {
      pageTitle: snap.title,
      bodyText: snap.bodyText,
      sourceUrl: snap.finalUrl,
      university: universityLabel,
    });

    const routed = enriched.map((row) => {
      const t = row.tier;
      return {
        ...row,
        tier: t,
        tier_label: t != null ? TIER_LABELS[t] || `Tier ${t}` : null,
      };
    });
    let addedConfirmed = 0;
    let addedExcluded = 0;
    let addedInferred = 0;

    for (const row of routed) {
      const email = normalizeEmail(row.email);
      if (!email || !email.includes("@")) {
        allInferred.push({
          ...row,
          email: null,
          confidence: row.confidence || "inferred",
          include: true,
          exclude_reason: null,
        });
        addedInferred++;
        continue;
      }
      if (seenEmails.has(email)) continue;

      if (VERIFY_MX) {
        const ok = await verifyEmailMx(email);
        if (!ok) {
          allExcluded.push({
            ...row,
            email,
            include: false,
            exclude_reason: "email domain has no MX record",
          });
          addedExcluded++;
          console.log(`      ↪ drop (no MX for domain): ${email}`);
          continue;
        }
      }

      const h = hostnameKey(row.source_url || snap.finalUrl);
      allContacts.push({ ...row, email, include: true, exclude_reason: null });
      addedConfirmed++;
      seenEmails.add(email);
      if (h) subdomainCounts.set(h, (subdomainCounts.get(h) || 0) + 1);
    }

    console.log(
      `      ✓ +${addedConfirmed} confirmed · +${addedExcluded} excluded · +${addedInferred} inferred`
    );
  }
}

async function runBatch(opts) {
  if (!fs.existsSync(opts.dataPath)) {
    throw new Error(`Missing ${opts.dataPath} — run from repo root`);
  }
  const raw = JSON.parse(fs.readFileSync(opts.dataPath, "utf8"));
  let list = raw.slice(opts.start);
  if (Number.isFinite(opts.max) && opts.max > 0) list = list.slice(0, opts.max);

  fs.mkdirSync(path.dirname(opts.out) || ".", { recursive: true });
  fs.mkdirSync(path.dirname(opts.excludedOut) || ".", { recursive: true });
  fs.mkdirSync(path.dirname(opts.inferredOut) || ".", { recursive: true });

  const tierList = normalizeTiers(opts.tiers);
  const batchOpts = { ...opts, tiers: tierList };
  console.log(`\nTier filter: ${tierList.map((t) => `T${t}`).join(", ")}`);
  console.log(`LLM extraction provider: ${LLM_PROVIDER}${OPENROUTER_API_KEY ? " (OpenRouter key detected)" : ""}`);
  console.log(`LLM search terminology aliases: ${SEARCH_LLM_TERMS ? "on" : "off (set SEARCH_LLM_TERMS=1 to enable)"}`);
  console.log(
    `Canonical university names (OpenRouter): ${CANONICAL_UNIVERSITY_NAMES && OPENROUTER_API_KEY ? "on" : CANONICAL_UNIVERSITY_NAMES ? "off (add OPENROUTER_API_KEY)" : "off (set CANONICAL_UNIVERSITY_NAMES=0 to disable)"}`
  );
  console.log(
    `AI university name expansion (Gemini): ${batchOpts.resolveUniversity ? "on (extra Gemini call per school)" : "off (set GEMINI_RESOLVE_UNIVERSITY=1 or --resolve-university to enable)"}`
  );
  console.log(`Domain-anchored @.edu search: ${DOMAIN_ANCHORED_SEARCH ? "on (DOMAIN_ANCHORED_SEARCH=0 to disable)" : "off"}`);
  console.log(`DNS MX check (drop bad domains): ${VERIFY_MX ? "on" : "off (VERIFY_MX=1)"}`);
  console.log(
    `Embedding scorer: ${EMBEDDING_PROVIDER}${EMBEDDING_PROVIDER === "openai" && !OPENAI_API_KEY ? " (OPENAI_API_KEY missing; using local fallback vectors)" : ""}`
  );
  console.log(`People crawl: depth ${CRAWL_PEOPLE_DEPTH}, max ${CRAWL_PEOPLE_MAX_PAGES} page(s); subdomain cap ${SUBDOMAIN_CONTACT_CAP} contact(s)/host\n`);

  let all = [];
  let allExcluded = [];
  let allInferred = [];
  if (opts.start > 0 && fs.existsSync(opts.out)) {
    try {
      all = JSON.parse(fs.readFileSync(opts.out, "utf8"));
      if (!Array.isArray(all)) all = [];
      console.log(`\nResuming: loaded ${all.length} contacts from ${opts.out} (--start ${opts.start})\n`);
    } catch {
      all = [];
    }
  }
  if (opts.start > 0 && fs.existsSync(opts.inferredOut)) {
    try {
      allInferred = JSON.parse(fs.readFileSync(opts.inferredOut, "utf8"));
      if (!Array.isArray(allInferred)) allInferred = [];
      console.log(`Resuming: loaded ${allInferred.length} inferred → ${opts.inferredOut}\n`);
    } catch {
      allInferred = [];
    }
  }
  if (opts.start > 0 && fs.existsSync(opts.excludedOut)) {
    try {
      allExcluded = JSON.parse(fs.readFileSync(opts.excludedOut, "utf8"));
      if (!Array.isArray(allExcluded)) allExcluded = [];
      console.log(`Resuming: loaded ${allExcluded.length} excluded → ${opts.excludedOut}\n`);
    } catch {
      allExcluded = [];
    }
  }

  const seenEmails = new Set();
  const subdomainCounts = new Map();
  for (const c of all) {
    const e = normalizeEmail(c.email);
    if (e) seenEmails.add(e);
  }
  for (const c of allInferred) {
    const e = normalizeEmail(c.email);
    if (e) seenEmails.add(e);
  }

  const browser = await chromium.launch(chromiumLaunchOptions());

  try {
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      let resolved = null;
      if (CANONICAL_UNIVERSITY_NAMES && OPENROUTER_API_KEY) {
        resolved = await resolveUniversityCanonicalOpenRouter(u);
      }
      if (batchOpts.resolveUniversity) {
        const g = await resolveUniversityWithGemini(u);
        if (g) {
          resolved = {
            ...(resolved || {}),
            ...g,
            canonical_name: g.canonical_name || resolved?.canonical_name,
            search_name: g.search_name || resolved?.search_name,
            entrepreneurship: g.entrepreneurship || resolved?.entrepreneurship || u.entrepreneurship,
            disambiguation: g.disambiguation || resolved?.disambiguation || "",
          };
        }
      }
      const displayName = resolved?.canonical_name || u.name;
      const searchName = resolved?.search_name || resolved?.canonical_name || u.name;
      const entForSearch = resolved?.entrepreneurship || u.entrepreneurship || "Entrepreneurship Center";

      const label = `${i + 1}/${list.length} ${displayName}`;
      console.log(`\n━━ ${label} ━━`);
      if (String(u.name || "").trim() !== String(displayName).trim()) {
        console.log(`  → Canonical: "${displayName}" (you entered: "${u.name}")`);
      }
      if (resolved && (resolved.search_name !== u.name || resolved.canonical_name !== u.name)) {
        console.log(
          `  → Search as: "${searchName}"` + (resolved.disambiguation ? ` (${resolved.disambiguation})` : "")
        );
      }

      let primaryDomain = "";
      try {
        primaryDomain = await resolvePrimaryEduDomain(displayName);
        if (primaryDomain) console.log(`  → Primary .edu domain: ${primaryDomain}`);
      } catch (e) {
        console.log(`  (primary .edu domain lookup failed: ${String(e?.message || e).slice(0, 100)})`);
      }

      let urls = [];
      try {
        urls = await discoverUrls(browser, searchName, entForSearch, opts.pagesPerSchool, {
          ...batchOpts,
          primaryDomain,
        });
      } catch (e) {
        console.error(`  ✗ Search failed: ${e.message}`);
      }

      if (urls.length === 0) {
        console.log("  (no result URLs — try again later or increase searches)");
      } else {
        console.log(`  Found ${urls.length} page(s) to scrape`);
        await processUrls(browser, urls, displayName, all, allExcluded, allInferred, tierList, {
          seenEmails,
          subdomainCounts,
        });
      }

      const deduped = dedupeContactsByEmail(all);
      const dedupExc = dedupeContactsStable(allExcluded);
      const dedupInf = dedupeContactsStable(allInferred);
      atomicWriteJson(opts.out, deduped);
      atomicWriteJson(opts.excludedOut, dedupExc);
      atomicWriteJson(opts.inferredOut, dedupInf);
      console.log(
        `  💾 ${deduped.length} confirmed → ${opts.out}; ${dedupExc.length} excluded → ${opts.excludedOut}; ${dedupInf.length} inferred → ${opts.inferredOut}`
      );

      await sleep(opts.delayMs);
    }
  } finally {
    await browser.close();
  }

  const final = dedupeContactsByEmail(all);
  const finalExc = dedupeContactsStable(allExcluded);
  const finalInf = dedupeContactsStable(allInferred);
  atomicWriteJson(opts.out, final);
  atomicWriteJson(opts.excludedOut, finalExc);
  atomicWriteJson(opts.inferredOut, finalInf);
  console.log(
    `\n✅ Done. ${final.length} confirmed → ${opts.out}; ${finalExc.length} excluded → ${opts.excludedOut}; ${finalInf.length} inferred → ${opts.inferredOut}`
  );
}

async function runSingle(opts) {
  fs.mkdirSync(path.dirname(opts.out) || ".", { recursive: true });
  fs.mkdirSync(path.dirname(opts.excludedOut) || ".", { recursive: true });
  fs.mkdirSync(path.dirname(opts.inferredOut) || ".", { recursive: true });
  const browser = await chromium.launch(chromiumLaunchOptions());
  const all = [];
  const allExcluded = [];
  const allInferred = [];
  const seenEmails = new Set();
  const subdomainCounts = new Map();
  try {
    await processUrls(browser, opts.urls, opts.university || "", all, allExcluded, allInferred, normalizeTiers(opts.tiers), {
      seenEmails,
      subdomainCounts,
    });
  } finally {
    await browser.close();
  }
  atomicWriteJson(opts.out, dedupeContactsByEmail(all));
  atomicWriteJson(opts.excludedOut, dedupeContactsStable(allExcluded));
  atomicWriteJson(opts.inferredOut, dedupeContactsStable(allInferred));
  console.log(
    `\nWrote ${all.length} confirmed → ${opts.out}; ${allExcluded.length} excluded → ${opts.excludedOut}; ${allInferred.length} inferred → ${opts.inferredOut}`
  );
}

async function main() {
  const opts = parseArgs();

  if (opts.batch) {
    await runBatch(opts);
    return;
  }

  if (opts.urls.length) {
    await runSingle(opts);
    return;
  }

  console.error(`
Usage — you do NOT need to paste URLs per school for batch runs.

  Batch (all schools in data/universities.json — search + scrape + Gemini):
    npm run scrape:batch -- --max 3
    npm run scrape:batch

  Options:
    --data PATH              default data/universities.json
    --out PATH               default output/contacts.json (included + confirmed email)
    --excluded-out PATH      default output/excluded.json (excluded contacts + reasons)
    --inferred-out PATH      default output/inferred.json (include=true, email missing)
    EMBEDDING_PROVIDER=openai|local  scoring backend (default openai)
    EMBEDDING_INCLUDE_THRESHOLD=0.72 include threshold for embedding similarity
    CONTACT_SCORER=regex|llm|auto   legacy post-extract mandate filter (default auto)
    --tiers 1,2,5            which T1–T9 search templates to run (default ${DEFAULT_TIERS.join(",")})
    --max N                  only first N schools (after --start)
    --start N                skip first N schools (resume)
    --pages-per-school N     max .edu pages to open per school (default 5)
    --delay MS               pause between schools (default 2800)
    --resolve-university     extra Gemini call per school for abbreviations / typos (default env only)
    --no-resolve-university  force name expansion off (see GEMINI_RESOLVE_UNIVERSITY)

  Single URL (manual):
    npm run scrape -- "https://example.edu/staff"
    npm run scrape -- --url https://a.edu/x --university "A University" --out output/one.json

Set GOOGLE_API_KEY from https://aistudio.google.com/apikey
`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
