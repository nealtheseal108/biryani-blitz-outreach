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
 *   OPENROUTER_API_KEY — enables OpenRouter extraction fallback
 *   OPENROUTER_MODEL — default meta-llama/llama-3.1-8b-instruct:free
 *   MULTI_STAGE_SEARCH=0 — disable per-category office resolution + people/directory crawl (default on)
 *
 * Examples:
 *   npm run scrape:batch -- --max 3
 *   npm run scrape:batch
 *   npm run scrape -- --url https://a.edu/staff --university "A"
 */

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
const SEARCH_LLM_TERMS = process.env.SEARCH_LLM_TERMS !== "0";
const MULTI_STAGE_SEARCH = process.env.MULTI_STAGE_SEARCH !== "0";
/** Expand "UT Austin" → full official name for search + contact rows (OpenRouter). Set CANONICAL_UNIVERSITY_NAMES=0 to disable. */
const CANONICAL_UNIVERSITY_NAMES = process.env.CANONICAL_UNIVERSITY_NAMES !== "0";

const DEFAULT_DATA = path.join("data", "universities.json");

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

/** After quota/rate-limit on university resolve, skip further resolve calls this run. */
let geminiSkipUniversityResolve = false;
/** After quota/rate-limit on extraction, skip further Gemini extraction calls this run. */
let geminiSkipExtract = false;

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
    out: path.join("output", "gemini_contacts.json"),
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

function buildTierQueries(shortName, entrepreneurship, tiers, tierAliasesByNumber = {}) {
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

/** Multi-stage: LLM office names + same queries as single-stage for each tier. */
function buildQueriesForTierWithOffices(shortName, entrepreneurship, tier, tierAliasesByNumber, officeInfo) {
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

/** Open a search-result landing page and collect same-site People / About / Directory links. */
async function crawlPeopleLinksFromUrl(browser, startUrl, markers, maxLinks) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(600);
    const raw = await page.evaluate(() => {
      const patterns =
        /people|about|staff|directory|team|contact|leadership|officers|board|faculty|our-team|who we are|meet/i;
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
    });
    const deduped = dedupeUrls(raw);
    const scoped = markers?.length ? deduped.filter((u) => urlMatchesUniversity(u, markers)) : deduped;
    return scoped.slice(0, maxLinks);
  } catch (e) {
    console.log(`      ↪ people crawl: ${String(e?.message || e).slice(0, 100)}`);
    return [];
  } finally {
    await page.close();
  }
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
      queries.push(...buildQueriesForTierWithOffices(universityName, entrepreneurship, t, tierAliases, office));
    }
  } else {
    queries = buildTierQueries(universityName, entrepreneurship, tiers, tierAliases);
  }

  const interSearchDelay = Math.min(opts.delayMs, 3500);
  // DDG HTML is frequently slow/blocked on hosted infra; keep it optional and last.
  const useDuckDuckGo = process.env.SEARCH_DDG === "1";
  if (Object.keys(tierAliases || {}).length > 0) {
    console.log(`  Search terminology aliases: ${JSON.stringify(tierAliases)}`);
  }

  const collected = [];
  const firstTierByUrl = new Map();
  try {
    for (let i = 0; i < queries.length; i++) {
      const qObj = queries[i];
      const q = qObj.query;
      const qLabel = `${i + 1}/${queries.length}`;
      console.log(`  [search ${qLabel}] [T${qObj.tier}] ${q}`);
      let links = [];
      try {
        const t0 = Date.now();
        links = await withTimeout(searchGoogle(page, q), 30000, "Google search");
        console.log(`    Google: ${links.length} link(s) in ${Date.now() - t0}ms`);
      } catch (e) {
        console.log(`    Google: failed (${String(e?.message || e).slice(0, 120)})`);
        links = [];
      }
      if (links.length < 2) {
        try {
          const t0 = Date.now();
          links = await withTimeout(searchBing(page, q), 15000, "Bing search");
          console.log(`    Bing: ${links.length} link(s) in ${Date.now() - t0}ms`);
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

  let deduped = dedupeUrls(collected).sort((a, b) => urlRelevanceScore(b) - urlRelevanceScore(a));
  const nonGeneric = deduped.filter((u) => !isGenericCampusPage(u));
  if (nonGeneric.length > 0) deduped = nonGeneric;
  const scoped = deduped.filter((u) => urlMatchesUniversity(u, markers));
  if (scoped.length > 0) {
    deduped = scoped;
  }

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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(600);
    const title = await page.title();
    const bodyText = await page.innerText("body");
    const mailtos = await extractMailtos(page);
    return {
      finalUrl: page.url(),
      title,
      bodyText: bodyText.slice(0, 100000),
      mailtos,
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
  const s = String(url || "").toLowerCase();
  if (/dining|food|meal|auxiliary/.test(s)) return 8;
  if (/studentaffairs|students|student-life|studentlife/.test(s)) return 2;
  if (/sustainab|green/.test(s)) return 6;
  if (/government|student-gov|asg|asuc/.test(s)) return 3;
  if (/health|ehs|safety|permit/.test(s)) return 9;
  return 0;
}

function mailtoFallbackContacts({ mailtos, university, sourceUrl }) {
  const tier = inferTierFromUrl(sourceUrl);
  const out = [];
  for (const m of mailtos || []) {
    const email = String(m?.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) continue;
    const hint = String(m?.linkText || "").trim();
    out.push({
      name: hint || null,
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
  if (!API_KEY || geminiSkipUniversityResolve) return null;
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
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (e) {
    const msg = String(e?.message || e);
    if (isGeminiQuotaError(msg)) {
      geminiSkipUniversityResolve = true;
      console.warn(
        "  ⚠ Gemini quota / rate limit — AI university rename disabled for the rest of this run. " +
          "Search still runs using your school names as entered. " +
          "For higher limits enable billing in Google AI Studio or wait and retry: " +
          "https://ai.google.dev/gemini-api/docs/rate-limits"
      );
      return null;
    }
    console.warn(`  ⚠ Gemini university resolve failed: ${msg.slice(0, 280)}`);
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

  if (!API_KEY || geminiSkipUniversityResolve) return {};
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    });
    const result = await withTimeout(model.generateContent(prompt), 14000, "Gemini search terminology");
    const text = result?.response?.text?.() || "";
    const parsed = extractJSONObject(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    const msg = String(e?.message || e);
    if (isGeminiQuotaError(msg)) geminiSkipUniversityResolve = true;
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

  if (!API_KEY || geminiSkipUniversityResolve) return null;
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: { temperature: 0.15, maxOutputTokens: 700 },
    });
    const result = await withTimeout(model.generateContent(prompt), 16000, "Gemini campus office resolve");
    const text = result?.response?.text?.() || "";
    const parsed = extractJSONObject(text);
    if (parsed && Array.isArray(parsed.office_names)) return parsed;
  } catch (e) {
    const msg = String(e?.message || e);
    if (isGeminiQuotaError(msg)) geminiSkipUniversityResolve = true;
  }
  return null;
}

async function geminiExtract({ university, sourceUrl, pageTitle, bodyText, mailtos, tierFocus }) {
  if (geminiSkipExtract) {
    return mailtoFallbackContacts({ mailtos, university, sourceUrl });
  }
  if (!API_KEY) throw new Error("Set GOOGLE_API_KEY (or GEMINI_API_KEY) from https://aistudio.google.com/apikey");
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  });

  const tierHint =
    tierFocus && tierFocus.length
      ? `
Outreach tier focus for this page (prefer roles that match these tiers when assigning tier numbers):
${tierFocus.map((t) => `T${t}`).join(", ")}
T1=student union commercial, T2=student life, T3=student gov, T4=entrepreneurship, T5=cultural/SA, T6=sustainability, T7=food truck/mobile, T8=dining, T9=EHS/food safety
`
      : "";

  const prompt = `You extract university / college staff and student-facing contacts for outreach about a food vending partnership.

Context university (may be empty): ${university || "unknown"}
Source URL: ${sourceUrl}
Page title: ${pageTitle}
${tierHint}
Known mailto links found on the page (use these emails when they match a person — prefer factual emails over guessing):
${JSON.stringify(mailtos, null, 2)}

Page text (truncated):
---
${bodyText}
---

Return ONLY a valid JSON array (no markdown, no commentary). Each item:
{
  "name": "string or null",
  "title": "string or null",
  "email": "string — must appear in page text or mailto list when possible",
  "tier": integer 1-9 optional (1=student union commercial, 4=entrepreneurship, 8=dining, 9=EHS, etc.),
  "confidence": "high" | "medium" | "low",
  "source_url": "${sourceUrl}"
}

Rules:
- Only include contacts with a plausible email for that person (from mailto or clearly listed on page).
- Do not fabricate emails.
- If no good contacts, return []`;

  async function openRouterExtract() {
    if (!OPENROUTER_API_KEY) return null;
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
              "You extract contact records from university web text. Return only valid JSON arrays, never markdown.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`OpenRouter ${resp.status}: ${t.slice(0, 220)}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed)) throw new Error("OpenRouter did not return a parseable JSON array");
    return parsed;
  }

  if (LLM_PROVIDER === "openrouter") {
    try {
      return (await openRouterExtract()) || mailtoFallbackContacts({ mailtos, university, sourceUrl });
    } catch (e) {
      console.warn(`      ⚠ OpenRouter extraction failed; falling back to mailto-only: ${String(e.message || e)}`);
      return mailtoFallbackContacts({ mailtos, university, sourceUrl });
    }
  }

  let text;
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (e) {
    const msg = String(e?.message || e);
    if (isGeminiQuotaError(msg)) {
      geminiSkipExtract = true;
      console.warn(
        "      ⚠ Gemini quota / rate limit."
      );
      if (OPENROUTER_API_KEY) {
        try {
          console.log(`      ↪ trying OpenRouter fallback model ${OPENROUTER_MODEL}`);
          return (await openRouterExtract()) || mailtoFallbackContacts({ mailtos, university, sourceUrl });
        } catch (orErr) {
          console.warn(`      ⚠ OpenRouter fallback failed: ${String(orErr.message || orErr)}`);
        }
      }
      console.warn("      ↪ switching to mailto-only fallback extraction for the rest of this run.");
      return mailtoFallbackContacts({ mailtos, university, sourceUrl });
    }
    throw e;
  }
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) {
    console.error("Gemini raw:", text.slice(0, 1500));
    return mailtoFallbackContacts({ mailtos, university, sourceUrl });
  }
  return parsed;
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

function isContactRelevantByKeywords(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return /student|union|dining|auxiliar|entrepreneur|innovation|incubat|startup|government|affairs|life|multicultural|sustainab|food|vendor|ehs|health|safety|permit|campus|university|college|director|coordinator|dean|vp|vice president|manager/.test(
    t
  );
}

async function fetchSearchSnippet(query) {
  const enc = encodeURIComponent(query);
  const resp = await withTimeout(
    fetch(`https://www.bing.com/search?q=${enc}&count=5`),
    10000,
    "Bing verify search"
  );
  if (!resp.ok) return "";
  const html = await resp.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 5000);
}

async function verifyContactsRelevance(rows, universityName) {
  const uni = String(universityName || "").trim();
  const out = [];
  let kept = 0;
  let dropped = 0;
  for (const c of rows || []) {
    const email = normalizeEmail(c.email);
    if (!email || !email.includes("@")) continue;
    const localEvidence = [c.name, c.title, c.department, c.tier_label, c.source_url, c.university]
      .filter(Boolean)
      .join(" ");
    let relevant = isContactRelevantByKeywords(localEvidence);
    if (!relevant) {
      try {
        const snippet = await fetchSearchSnippet(`${email} ${uni} university`);
        relevant = isContactRelevantByKeywords(snippet);
      } catch {
        // Keep on lookup failure so we don't accidentally drop legitimate contacts.
        relevant = true;
      }
    }
    if (relevant) {
      kept++;
      out.push(c);
    } else {
      dropped++;
    }
  }
  console.log(`      ↪ relevance filter: kept ${kept}, dropped ${dropped}`);
  return out;
}

async function processUrls(browser, urls, universityLabel, allContacts, tierFocus) {
  for (const url of urls) {
    console.log(`    → ${url}`);
    let snap;
    try {
      snap = await fetchPage(browser, url);
    } catch (e) {
      console.error(`      ✗ Page failed: ${e.message}`);
      continue;
    }
    console.log(`      ✓ ${snap.title?.slice(0, 70) || "(no title)"} · mailto: ${snap.mailtos.length}`);

    let contacts;
    try {
      contacts = await geminiExtract({
        university: universityLabel,
        sourceUrl: snap.finalUrl,
        pageTitle: snap.title,
        bodyText: snap.bodyText,
        mailtos: snap.mailtos,
        tierFocus,
      });
    } catch (e) {
      console.error(`      ✗ Gemini: ${e.message}`);
      continue;
    }
    if (geminiSkipExtract) {
      console.log(`      ↪ fallback mode: using mailto-only extraction (${contacts.length} contact(s))`);
    }

    const withMeta = contacts.map((c) => ({
      ...c,
      university: universityLabel,
      tier_label: c.tier ? `Tier ${c.tier}` : null,
    }));
    const relevant = await verifyContactsRelevance(withMeta, universityLabel);
    allContacts.push(...relevant);
    console.log(`      ✓ +${relevant.length} relevant contact(s)`);
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

  const tierList = normalizeTiers(opts.tiers);
  const batchOpts = { ...opts, tiers: tierList };
  console.log(`\nTier filter: ${tierList.map((t) => `T${t}`).join(", ")}`);
  console.log(`LLM extraction provider: ${LLM_PROVIDER}${OPENROUTER_API_KEY ? " (OpenRouter key detected)" : ""}`);
  console.log(`LLM search terminology aliases: ${SEARCH_LLM_TERMS ? "on" : "off (set SEARCH_LLM_TERMS=1 to enable)"}`);
  console.log(
    `Canonical university names (OpenRouter): ${CANONICAL_UNIVERSITY_NAMES && OPENROUTER_API_KEY ? "on" : CANONICAL_UNIVERSITY_NAMES ? "off (add OPENROUTER_API_KEY)" : "off (set CANONICAL_UNIVERSITY_NAMES=0 to disable)"}`
  );
  console.log(
    `AI university name expansion (Gemini): ${batchOpts.resolveUniversity ? "on (extra Gemini call per school)" : "off (set GEMINI_RESOLVE_UNIVERSITY=1 or --resolve-university to enable)"}\n`
  );

  let all = [];
  if (opts.start > 0 && fs.existsSync(opts.out)) {
    try {
      all = JSON.parse(fs.readFileSync(opts.out, "utf8"));
      if (!Array.isArray(all)) all = [];
      console.log(`\nResuming: loaded ${all.length} contacts from ${opts.out} (--start ${opts.start})\n`);
    } catch {
      all = [];
    }
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

      let urls = [];
      try {
        urls = await discoverUrls(browser, searchName, entForSearch, opts.pagesPerSchool, batchOpts);
      } catch (e) {
        console.error(`  ✗ Search failed: ${e.message}`);
      }

      if (urls.length === 0) {
        console.log("  (no result URLs — try again later or increase searches)");
      } else {
        console.log(`  Found ${urls.length} page(s) to scrape`);
        await processUrls(browser, urls, displayName, all, tierList);
      }

      const deduped = dedupeContactsByEmail(all);
      atomicWriteJson(opts.out, deduped);
      console.log(`  💾 saved ${deduped.length} unique emails → ${opts.out}`);

      await sleep(opts.delayMs);
    }
  } finally {
    await browser.close();
  }

  const final = dedupeContactsByEmail(all);
  atomicWriteJson(opts.out, final);
  console.log(`\n✅ Done. ${final.length} unique contacts → ${opts.out}`);
}

async function runSingle(opts) {
  fs.mkdirSync(path.dirname(opts.out) || ".", { recursive: true });
  const browser = await chromium.launch(chromiumLaunchOptions());
  const all = [];
  try {
    await processUrls(browser, opts.urls, opts.university || "", all, normalizeTiers(opts.tiers));
  } finally {
    await browser.close();
  }
  atomicWriteJson(opts.out, all);
  console.log(`\nWrote ${all.length} contacts → ${opts.out}`);
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
    --out PATH               default output/gemini_contacts.json
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
