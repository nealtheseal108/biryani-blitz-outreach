/**
 * Biryani Blitz University Outreach Email Agent
 *
 * Managed pipeline: Manager (planner) → Workers (web_search, parallel) → Aggregator (dedup + CSV)
 *
 * Nine outreach tiers (sort / priority order):
 *   T1 — Student Union / Commercial Activities (contract gatekeeper; “Ryan” tier)
 *   T2 — Student Life / Student Experience (VP/Director-level champion)
 *   T3 — Student Government / ASUC-equivalent (board / advocacy)
 *   T4 — Entrepreneurship centers (warm referrals, credibility)
 *   T5 — Student cultural centers — South Asian + multicultural affairs (audience + sponsor)
 *   T6 — Sustainability / green events / approved vendor lists (passive discovery)
 *   T7 — Food truck / mobile vendor coordinator within unions (lighter entry)
 *   T8 — Campus / auxiliary dining (often protective — still map contacts)
 *   T9 — EHS / food safety / environmental health (compliance unblocker)
 *
 * Berkeley archetypes (examples): Ryan / Jaime / Ariel → T1; dining cafe mgr → T8;
 * entrepreneurship office → T4; student gov → T3; EHS inspector analog → T9.
 */

const fs = require("fs");
const path = require("path");

const TIER_DEFS = [
  { tier: 1, label: "Student Union / Commercial Activities", short: "T1 Union" },
  { tier: 2, label: "Student Life / Student Experience", short: "T2 Student Life" },
  { tier: 3, label: "Student Government", short: "T3 Stu Gov" },
  { tier: 4, label: "Entrepreneurship", short: "T4 Venture" },
  { tier: 5, label: "Cultural Centers / Multicultural & South Asian", short: "T5 Cultural" },
  { tier: 6, label: "Sustainability / Green Vendor Lists", short: "T6 Sustain" },
  { tier: 7, label: "Food Truck / Mobile Vendor", short: "T7 Food Truck" },
  { tier: 8, label: "Campus Dining / Auxiliary", short: "T8 Dining" },
  { tier: 9, label: "EHS / Food Safety", short: "T9 EHS" },
];

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSITY LIST — 70 from outreach package + entrepreneurship center hint
// ─────────────────────────────────────────────────────────────────────────────
const UNIVERSITIES = [
  { name: "New York University (NYU)", city: "New York, NY", entrepreneurship: "Entrepreneurial Institute / W.R. Berkley Innovation Labs" },
  { name: "Northeastern University", city: "Boston, MA", entrepreneurship: "New Ventures" },
  { name: "Columbia University", city: "New York, NY", entrepreneurship: "Columbia Entrepreneurship" },
  { name: "Arizona State University (ASU)", city: "Tempe, AZ", entrepreneurship: "Edson Entrepreneurship + Innovation" },
  { name: "University of Southern California (USC)", city: "Los Angeles, CA", entrepreneurship: "Marshall Greif Center / Blackstone LaunchPad" },
  { name: "University of Illinois Urbana-Champaign (UIUC)", city: "Champaign, IL", entrepreneurship: "Research Park / Siebel Center for Design" },
  { name: "University of North Texas (UNT)", city: "Denton, TX", entrepreneurship: "Innovation Center" },
  { name: "Purdue University", city: "West Lafayette, IN", entrepreneurship: "Burton D. Morgan Center for Entrepreneurship" },
  { name: "Boston University (BU)", city: "Boston, MA", entrepreneurship: "BUild Lab IDG Capital Student Innovation Center" },
  { name: "UC Berkeley (UCB)", city: "Berkeley, CA", entrepreneurship: "SCET / Berkeley SkyDeck" },
  { name: "University of Michigan - Ann Arbor", city: "Ann Arbor, MI", entrepreneurship: "Zell Lurie Institute" },
  { name: "University of Washington (UW)", city: "Seattle, WA", entrepreneurship: "Buerk Center for Entrepreneurship" },
  { name: "Johns Hopkins University (JHU)", city: "Baltimore, MD", entrepreneurship: "FastForward U" },
  { name: "UCLA", city: "Los Angeles, CA", entrepreneurship: "Startup UCLA" },
  { name: "UC San Diego (UCSD)", city: "La Jolla, CA", entrepreneurship: "The Basement" },
  { name: "Carnegie Mellon University (CMU)", city: "Pittsburgh, PA", entrepreneurship: "Swartz Center for Entrepreneurship" },
  { name: "Georgia Tech", city: "Atlanta, GA", entrepreneurship: "CREATE-X" },
  { name: "University of Texas at Austin (UT Austin)", city: "Austin, TX", entrepreneurship: "Blackstone LaunchPad" },
  { name: "Texas A&M University", city: "College Station, TX", entrepreneurship: "McFerrin Center for Entrepreneurship" },
  { name: "Cornell University", city: "Ithaca, NY", entrepreneurship: "Entrepreneurship at Cornell" },
  { name: "University of Maryland - College Park", city: "College Park, MD", entrepreneurship: "Academy for Innovation & Entrepreneurship" },
  { name: "Rutgers University - New Brunswick", city: "New Brunswick, NJ", entrepreneurship: "Rutgers Entrepreneurship" },
  { name: "University of Pennsylvania (UPenn)", city: "Philadelphia, PA", entrepreneurship: "Venture Lab" },
  { name: "University of Texas at Dallas (UTD)", city: "Richardson, TX", entrepreneurship: "Institute for Innovation and Entrepreneurship" },
  { name: "San Jose State University (SJSU)", city: "San Jose, CA", entrepreneurship: "Spartan East Side Promise" },
  { name: "University of Florida (UF)", city: "Gainesville, FL", entrepreneurship: "Entrepreneurship & Innovation Center" },
  { name: "Ohio State University (OSU)", city: "Columbus, OH", entrepreneurship: "Keenan Center for Entrepreneurship" },
  { name: "University of Central Florida (UCF)", city: "Orlando, FL", entrepreneurship: "Blackstone LaunchPad" },
  { name: "University of Minnesota - Twin Cities", city: "Minneapolis, MN", entrepreneurship: "Gary S. Holmes Center" },
  { name: "University of Wisconsin - Madison", city: "Madison, WI", entrepreneurship: "Discovery to Product (D2P)" },
  { name: "Michigan State University (MSU)", city: "East Lansing, MI", entrepreneurship: "Burgess Institute" },
  { name: "Penn State University", city: "University Park, PA", entrepreneurship: "Invent Penn State" },
  { name: "University of South Florida (USF)", city: "Tampa, FL", entrepreneurship: "Center for Entrepreneurship" },
  { name: "University of Houston", city: "Houston, TX", entrepreneurship: "Wolff Center for Entrepreneurship" },
  { name: "UC Irvine (UCI)", city: "Irvine, CA", entrepreneurship: "ANTrepreneur Center" },
  { name: "UC Davis (UCD)", city: "Davis, CA", entrepreneurship: "Institute for Innovation and Entrepreneurship" },
  { name: "NC State University", city: "Raleigh, NC", entrepreneurship: "NC State Entrepreneurship" },
  { name: "Virginia Tech", city: "Blacksburg, VA", entrepreneurship: "Apex Center for Entrepreneurs" },
  { name: "University of Arizona", city: "Tucson, AZ", entrepreneurship: "McGuire Center for Entrepreneurship" },
  { name: "University of Utah", city: "Salt Lake City, UT", entrepreneurship: "Lassonde Entrepreneur Institute" },
  { name: "Pace University", city: "New York, NY", entrepreneurship: "Lubin School of Business" },
  { name: "Indiana University - Bloomington", city: "Bloomington, IN", entrepreneurship: "Shoemaker Innovation Center" },
  { name: "UNC Chapel Hill", city: "Chapel Hill, NC", entrepreneurship: "Innovate Carolina" },
  { name: "University of Virginia (UVA)", city: "Charlottesville, VA", entrepreneurship: "Batten Institute" },
  { name: "Duke University", city: "Durham, NC", entrepreneurship: "Duke Innovation & Entrepreneurship" },
  { name: "Stanford University", city: "Stanford, CA", entrepreneurship: "STVP - Stanford Technology Ventures Program" },
  { name: "MIT", city: "Cambridge, MA", entrepreneurship: "Martin Trust Center for MIT Entrepreneurship" },
  { name: "Harvard University", city: "Cambridge, MA", entrepreneurship: "Harvard Innovation Labs (i-lab)" },
  { name: "Yale University", city: "New Haven, CT", entrepreneurship: "Tsai Center for Innovative Thinking" },
  { name: "Princeton University", city: "Princeton, NJ", entrepreneurship: "Keller Center" },
  { name: "University of Chicago", city: "Chicago, IL", entrepreneurship: "Polsky Center" },
  { name: "Northwestern University", city: "Evanston, IL", entrepreneurship: "The Garage" },
  { name: "Rice University", city: "Houston, TX", entrepreneurship: "Rice Alliance for Technology and Entrepreneurship" },
  { name: "Washington University in St. Louis", city: "St. Louis, MO", entrepreneurship: "Skandalaris Center" },
  { name: "Syracuse University", city: "Syracuse, NY", entrepreneurship: "Blackstone LaunchPad" },
  { name: "George Washington University (GWU)", city: "Washington, DC", entrepreneurship: "Office of Innovation & Entrepreneurship" },
  { name: "Georgetown University", city: "Washington, DC", entrepreneurship: "Georgetown Entrepreneurship" },
  { name: "Boston College", city: "Chestnut Hill, MA", entrepreneurship: "Shea Center for Entrepreneurship" },
  { name: "Rochester Institute of Technology (RIT)", city: "Rochester, NY", entrepreneurship: "Simone Center for Innovation" },
  { name: "Emory University", city: "Atlanta, GA", entrepreneurship: "Center for Entrepreneurship & Innovation" },
  { name: "University of Notre Dame", city: "Notre Dame, IN", entrepreneurship: "IDEA Center" },
  { name: "Case Western Reserve University", city: "Cleveland, OH", entrepreneurship: "Sears think[box]" },
  { name: "Stevens Institute of Technology", city: "Hoboken, NJ", entrepreneurship: "Stevens Venture Center" },
  { name: "Illinois Institute of Technology", city: "Chicago, IL", entrepreneurship: "Kaplan Institute" },
  { name: "University of Colorado Boulder", city: "Boulder, CO", entrepreneurship: "Innovation & Entrepreneurship" },
  { name: "University of Georgia (UGA)", city: "Athens, GA", entrepreneurship: "Entrepreneurship Program" },
  { name: "Clemson University", city: "Clemson, SC", entrepreneurship: "Watt Family Innovation Center" },
  { name: "University of Rochester", city: "Rochester, NY", entrepreneurship: "Ain Center for Entrepreneurship" },
  { name: "NJIT", city: "Newark, NJ", entrepreneurship: "Leir Institute for Entrepreneurship" },
  { name: "University of Oregon", city: "Eugene, OR", entrepreneurship: "Lundquist Center for Entrepreneurship" },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function requireApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY in your environment.");
    process.exit(1);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function anthropicHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
}

async function callClaude(systemPrompt, userMessage, options = {}) {
  const { useWebSearch = false, maxTokens = 4096 } = options;
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err}`);
  }
  return response.json();
}

function extractJSON(text) {
  const clean = text.replace(/```json\n?|```\n?/g, "").trim();
  const start = Math.min(
    clean.indexOf("[") === -1 ? Infinity : clean.indexOf("["),
    clean.indexOf("{") === -1 ? Infinity : clean.indexOf("{")
  );
  const endBracket = clean.lastIndexOf("]");
  const endBrace = clean.lastIndexOf("}");
  const end = Math.max(endBracket, endBrace);
  if (start === Infinity || end === -1) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeTier(v, fallbackTier) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 9) return n;
  return fallbackTier;
}

/** Sort unknown / invalid tiers last */
function tierSortKey(v) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 9) return n;
  return 99;
}

function tierLabelFor(n) {
  const row = TIER_DEFS.find((t) => t.tier === n);
  return row ? row.label : `Tier ${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: MANAGER — exactly 9 search queries (T1–T9)
// ─────────────────────────────────────────────────────────────────────────────
const MANAGER_SYSTEM = `
You are a research planner for Biryani Blitz, a student-founded hot food vending startup
pitching machines and pop-ups in student unions and related campus venues.

For EACH university, output exactly 9 Google-style web search queries in a JSON array of strings,
in this fixed tier order (index 0 = T1 ... index 8 = T9):

T1 Student Union / Commercial Activities
  e.g. director business development commercial activities student union vendor partnerships email
T2 Student Life / Student Experience
  e.g. VP student affairs student experience auxiliary services email (student union reporting lines)
T3 Student Government
  e.g. student government president OR VP internal affairs student union board email site:.edu
T4 Entrepreneurship / student ventures
  Use the provided entrepreneurship center name in the query.
T5 Cultural centers — South Asian student association + multicultural student affairs director email
T6 Sustainability office OR green events catering vendor list contact email
T7 Food truck OR mobile food vendor coordinator university unions permit contact email
T8 Campus dining OR auxiliary services dining director email
T9 Environmental health OR EHS food safety temporary food permit coordinator email

Return ONLY valid JSON: an array of exactly 9 strings. No markdown fences, no commentary.
`.trim();

function fallbackQueries(u) {
  const base = u.name;
  return [
    `${base} student union director business development commercial activities vendor email`,
    `${base} vice president student affairs student experience email site:edu`,
    `${base} student government president email OR VP internal affairs ASUC site:edu`,
    `${base} ${u.entrepreneurship} director contact email`,
    `${base} South Asian student association OR multicultural center director email`,
    `${base} sustainability office green events food vendor list email`,
    `${base} university unions food truck mobile vendor coordinator email`,
    `${base} campus dining director OR auxiliary dining email`,
    `${base} environmental health food safety temporary food permit coordinator email`,
  ];
}

async function planSearchQueries(university) {
  const prompt = `University: ${university.name}
City: ${university.city}
Entrepreneurship center (for T4): ${university.entrepreneurship}

Generate exactly 9 search strings for tiers T1–T9 as specified.`;

  const data = await callClaude(MANAGER_SYSTEM, prompt, { useWebSearch: false, maxTokens: 2048 });
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const queries = extractJSON(text);
  if (!Array.isArray(queries) || queries.length < 9) {
    console.warn(`  ⚠ Manager returned invalid JSON for ${university.name}, using fallback queries`);
    return fallbackQueries(university);
  }
  return queries.slice(0, 9);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: WORKER — web search + structured contacts
// ─────────────────────────────────────────────────────────────────────────────
const WORKER_SYSTEM = `
You are a contact research assistant for Biryani Blitz (campus food vending / events).

Use web search, then return ONLY a JSON array of contacts. Each object MUST include:
{
  "name": "Full Name",
  "title": "Exact job title",
  "tier": <integer 1-9 matching the tier for this query>,
  "tier_label": "short label matching the tier",
  "department": "Legacy bucket: Student Union | Dining | Entrepreneurship | Student Life | EHS | Sustainability | Student Gov | Cultural | Other",
  "email": "email@school.edu",
  "phone": "or null",
  "confidence": "high" | "medium" | "low",
  "source_url": "https://..."
}

Rules:
- Prefer role-based emails (.edu) found on official pages; mark confidence accordingly.
- If nothing found, return [].
- tier must match the query's tier provided in the user message.
Return ONLY JSON — no markdown fences, no prose.
`.trim();

async function searchForContacts(query, universityName, queryTier) {
  try {
    const data = await callClaude(
      WORKER_SYSTEM,
      `University: ${universityName}
Tier for this search: ${queryTier} (${tierLabelFor(queryTier)})
Search query: ${query}`,
      { useWebSearch: true, maxTokens: 8192 }
    );

    const textBlocks = data.content.filter((b) => b.type === "text");
    const lastText = textBlocks[textBlocks.length - 1]?.text || "[]";

    const contacts = extractJSON(lastText);
    if (!Array.isArray(contacts)) return [];

    return contacts.map((c) => {
      const tier = normalizeTier(c.tier, queryTier);
      return {
        ...c,
        tier,
        tier_label: c.tier_label || tierLabelFor(tier),
        university: universityName,
      };
    });
  } catch (err) {
    console.warn(`    ✗ Worker error for tier ${queryTier}: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: AGGREGATOR
// ─────────────────────────────────────────────────────────────────────────────
function aggregateContacts(allContacts) {
  const confScore = { high: 3, medium: 2, low: 1 };

  const sorted = [...allContacts].sort((a, b) => {
    const ta = tierSortKey(a.tier);
    const tb = tierSortKey(b.tier);
    if (ta !== tb) return ta - tb;
    return (confScore[b.confidence] || 0) - (confScore[a.confidence] || 0);
  });

  const seen = new Set();
  const unique = [];
  for (const c of sorted) {
    const email = String(c.email || "")
      .toLowerCase()
      .trim();
    if (!email || email === "null" || email === "n/a") continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const tn = Number.parseInt(String(c.tier), 10);
    const tierVal = Number.isFinite(tn) && tn >= 1 && tn <= 9 ? tn : 9;
    unique.push({
      ...c,
      tier: tierVal,
      tier_label:
        c.tier_label ||
        (tierVal >= 1 && tierVal <= 9 ? tierLabelFor(tierVal) : "Unclassified"),
    });
  }
  return unique;
}

function exportToCSV(contacts, outputPath) {
  const headers = [
    "university",
    "tier",
    "tier_label",
    "name",
    "title",
    "department",
    "email",
    "phone",
    "confidence",
    "source_url",
  ];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    headers.join(","),
    ...contacts.map((c) => headers.map((h) => escape(c[h])).join(",")),
  ];
  fs.writeFileSync(outputPath, rows.join("\n"), "utf8");
  return contacts.length;
}

function exportToJSON(contacts, outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(contacts, null, 2), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
async function runOutreachAgent(options = {}) {
  requireApiKey();

  const {
    batchSize = 5,
    delayBetweenBatches = 3000,
    delayBetweenWorkers = 400,
    maxUniversities = null,
    outputDir = "./output",
  } = options;

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const universities = maxUniversities ? UNIVERSITIES.slice(0, maxUniversities) : UNIVERSITIES;

  console.log(`\n🍛 Biryani Blitz Outreach Agent (9-tier)`);
  console.log(`   Universities: ${universities.length}`);
  console.log(`   Batch size: ${batchSize} | Between batches: ${delayBetweenBatches}ms\n`);

  const allContacts = [];
  const progressLog = [];

  for (let i = 0; i < universities.length; i += batchSize) {
    const batch = universities.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(universities.length / batchSize);

    console.log(`\n📦 Batch ${batchNum}/${totalBatches}: ${batch.map((u) => u.name).join(", ")}`);

    const batchResults = await Promise.all(
      batch.map(async (university) => {
        const uContacts = [];
        try {
          console.log(`  🧠 Planning 9 queries for ${university.name}...`);
          const queries = await planSearchQueries(university);
          console.log(`  ✓ ${queries.length} queries planned`);

          const workers = queries.map((query, idx) => {
            const tierNum = idx + 1;
            return (async () => {
              await sleep(delayBetweenWorkers * idx);
              console.log(`  🔍 [T${tierNum}] ${query.slice(0, 72)}${query.length > 72 ? "…" : ""}`);
              const contacts = await searchForContacts(query, university.name, tierNum);
              if (contacts.length > 0) console.log(`     ✓ T${tierNum}: ${contacts.length} contact(s)`);
              return contacts;
            })();
          });

          const nested = await Promise.all(workers);
          nested.forEach((arr) => uContacts.push(...arr));

          progressLog.push({ university: university.name, status: "success", count: uContacts.length });
        } catch (err) {
          console.error(`  ✗ Failed ${university.name}: ${err.message}`);
          progressLog.push({ university: university.name, status: "error", error: err.message });
        }
        return uContacts;
      })
    );

    allContacts.push(...batchResults.flat());

    const checkpoint = aggregateContacts(allContacts);
    exportToCSV(checkpoint, path.join(outputDir, "contacts_checkpoint.csv"));
    console.log(`\n  💾 Checkpoint: ${checkpoint.length} unique contacts`);

    if (i + batchSize < universities.length) {
      console.log(`  ⏳ Waiting ${delayBetweenBatches / 1000}s before next batch...`);
      await sleep(delayBetweenBatches);
    }
  }

  console.log(`\n\n📊 Aggregating results...`);
  const finalContacts = aggregateContacts(allContacts);

  const csvPath = path.join(outputDir, "biryani_blitz_contacts.csv");
  const jsonPath = path.join(outputDir, "biryani_blitz_contacts.json");
  const logPath = path.join(outputDir, "run_log.json");

  exportToCSV(finalContacts, csvPath);
  exportToJSON(finalContacts, jsonPath);
  fs.writeFileSync(logPath, JSON.stringify(progressLog, null, 2));

  const byTier = finalContacts.reduce((acc, c) => {
    const t = normalizeTier(c.tier, 0);
    const key = t > 0 ? `T${t}` : "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const byConf = finalContacts.reduce((acc, c) => {
    acc[c.confidence || "unknown"] = (acc[c.confidence || "unknown"] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n✅ Done`);
  console.log(`   Unique contacts: ${finalContacts.length}`);
  console.log(`   By tier:`, byTier);
  console.log(`   By confidence:`, byConf);
  console.log(`\n   Outputs:`);
  console.log(`   📄 ${csvPath}`);
  console.log(`   📄 ${jsonPath}`);
  console.log(`   📄 ${logPath}`);

  return finalContacts;
}

const isTest = process.argv.includes("--test");
const maxU = process.argv.includes("--max") ? parseInt(process.argv[process.argv.indexOf("--max") + 1], 10) : null;

runOutreachAgent({
  batchSize: 5,
  delayBetweenBatches: 3000,
  delayBetweenWorkers: 450,
  maxUniversities: isTest ? 3 : Number.isFinite(maxU) ? maxU : null,
  outputDir: "./output",
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
