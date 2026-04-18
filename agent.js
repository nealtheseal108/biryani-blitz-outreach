/**
 * Biryani Blitz University Outreach Email Agent
 *
 * Managed 3-step agent: Manager (planner) → Workers (web_search) → Aggregator (dedup + CSV)
 *
 * Target departments per university:
 *   1. Student Union / Student Life ("Ryan Adelman-Sessler" type contacts)
 *      - Director of Business Development & Commercial Activities
 *      - Director of Student Union Facilities & Operations
 *      - Director of Programs & Marketing
 *   2. Campus Dining Services
 *      - Director of Dining / AVP Dining
 *      - Executive Chef or Dining Operations Manager
 *   3. Entrepreneurship / Student Ventures
 *      - Executive Director or Director of the campus entrepreneurship center
 *      - Program Manager, Student Ventures
 *
 * From the Berkeley email history, we know the exact contact archetypes:
 *   - Ryan Adelman-Sessler: Director, Business Development & Commercial Activities (Student Union)
 *   - Jaime Santoyo: Director, Facilities Maintenance & Operations (Student Union)
 *   - Andy Hang: Associate Director, Facilities Operations (Student Union)
 *   - Ariel Feinberg-Berson: Director of Programs & Marketing (Student Union)
 *   - Makossa Sweetwyne: Facilities Coordinator (Student Union)
 *   - Huw Thornton: Cafe Manager, Goldie's Coffee (Campus Dining)
 *   - Kim Guess: Wellness Program Dietitian / Food Policy (University Health)
 *
 * The agent searches for analogous roles at each target university.
 */

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSITY LIST — all 70 from the outreach package + their entrepreneurship centers
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
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callClaude(systemPrompt, userMessage, useWebSearch = false) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err}`);
  }
  return response.json();
}

function extractJSON(text) {
  // Strip markdown fences and parse
  const clean = text.replace(/```json\n?|```\n?/g, "").trim();
  // Find first [ or { and last ] or }
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

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: MANAGER — generates targeted search queries for a university
// ─────────────────────────────────────────────────────────────────────────────
const MANAGER_SYSTEM = `
You are a research planner for Biryani Blitz, a student-founded hot food vending startup
pitching to place machines in university student unions and dining areas.

Context: At UC Berkeley, the key contacts were:
- Ryan Adelman-Sessler, Director of Business Development & Commercial Activities (Student Union)
  — the main gatekeeper who approved vendor placement
- Jaime Santoyo, Director of Facilities Maintenance & Operations (Student Union)
  — facilities/logistics approvals
- Ariel Feinberg-Berson, Director of Programs & Marketing (Student Union)
  — marketing/digital signage decisions
- Kim Guess, Wellness Dietitian (University Health) — food policy compliance
- Huw Thornton, Cafe Manager (Campus Dining) — food service partnerships

We need to find equivalent contacts at other universities. For each university, generate
a JSON array of 4-5 targeted web search queries that will find:
1. Director/head of Student Union business development, commercial activities, or vendor partnerships
2. Director of Student Union facilities & operations
3. Director of Student Life or Student Experience (equivalent to student union administration)
4. Campus Dining director or AVP of dining services
5. Director of the university's entrepreneurship/student venture center

Return ONLY a valid JSON array of strings — no preamble, no markdown fences.
Example output:
["NYU student union director business development email", "NYU student union vendor partnerships contact site:nyu.edu", "NYU dining services director email", "NYU Berkley Innovation Labs director contact"]
`.trim();

async function planSearchQueries(university) {
  const prompt = `University: ${university.name}
City: ${university.city}
Entrepreneurship center: ${university.entrepreneurship}

Generate 4-5 targeted search queries to find the key contacts described above.
Focus on: Student Union commercial/business director, facilities director, student life/experience VP,
dining director, and entrepreneurship center director.`;

  const data = await callClaude(MANAGER_SYSTEM, prompt, false);
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const queries = extractJSON(text);
  if (!Array.isArray(queries)) {
    console.warn(`  ⚠ Manager returned invalid JSON for ${university.name}, using fallback queries`);
    return [
      `${university.name} student union director business development vendor email`,
      `${university.name} campus dining director email contact`,
      `${university.name} ${university.entrepreneurship} director contact email`,
      `${university.name} student life VP director email site:edu`,
    ];
  }
  return queries;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: WORKER — searches and extracts contacts for a single query
// ─────────────────────────────────────────────────────────────────────────────
const WORKER_SYSTEM = `
You are a contact research assistant for Biryani Blitz, a student food startup seeking
university partnerships. Your job: search the web and extract contact information
for university staff who handle vendor/commercial partnerships, student unions,
dining services, or student entrepreneurship.

Priority roles to find:
- Director of Business Development or Commercial Activities (Student Union)
- Director of Student Union or Student Activities
- VP/Director of Student Life or Student Experience  
- Director of Facilities, Student Union
- Director/AVP of Campus Dining Services
- Director of Entrepreneurship/Student Ventures center
- Student union facility coordinator or operations manager

After searching, return ONLY a valid JSON array of contacts found. Each contact object:
{
  "name": "Full Name",
  "title": "Exact job title",
  "department": "Student Union | Dining | Entrepreneurship | Student Life",
  "email": "email@university.edu",
  "phone": "phone if found, else null",
  "confidence": "high (directly on page) | medium (staff directory) | low (inferred format)",
  "source_url": "URL where found"
}

If no relevant contacts found, return [].
Return ONLY valid JSON — no explanation, no markdown fences.
`.trim();

async function searchForContacts(query, universityName) {
  try {
    const data = await callClaude(
      WORKER_SYSTEM,
      `Search for contacts at ${universityName}. Query: ${query}`,
      true // enable web_search
    );

    // Get all text blocks (Claude's final answer after tool use)
    const textBlocks = data.content.filter((b) => b.type === "text");
    const lastText = textBlocks[textBlocks.length - 1]?.text || "[]";

    const contacts = extractJSON(lastText);
    if (!Array.isArray(contacts)) return [];

    // Tag each contact with the university
    return contacts.map((c) => ({
      ...c,
      university: universityName,
    }));
  } catch (err) {
    console.warn(`    ✗ Worker error for query "${query.slice(0, 50)}...": ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: AGGREGATOR — dedup by email, score, and export
// ─────────────────────────────────────────────────────────────────────────────
function aggregateContacts(allContacts) {
  const seen = new Set();
  const unique = [];

  // Priority order for department dedup
  const DEPT_PRIORITY = ["Student Union", "Dining", "Student Life", "Entrepreneurship"];

  // Sort so higher-confidence and higher-priority departments come first
  const sorted = [...allContacts].sort((a, b) => {
    const confScore = { high: 3, medium: 2, low: 1 };
    const deptScore = (d) => DEPT_PRIORITY.length - (DEPT_PRIORITY.indexOf(d) === -1 ? DEPT_PRIORITY.length : DEPT_PRIORITY.indexOf(d));
    const confDiff = (confScore[b.confidence] || 0) - (confScore[a.confidence] || 0);
    return confDiff !== 0 ? confDiff : deptScore(b.department) - deptScore(a.department);
  });

  for (const c of sorted) {
    const email = (c.email || "").toLowerCase().trim();
    if (!email || email === "null" || email === "n/a") continue;
    if (seen.has(email)) continue;
    seen.add(email);
    unique.push(c);
  }

  return unique;
}

function exportToCSV(contacts, outputPath) {
  const headers = ["university", "name", "title", "department", "email", "phone", "confidence", "source_url"];
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
  const {
    batchSize = 5,          // universities per parallel batch
    delayBetweenBatches = 3000, // ms between batches
    delayBetweenWorkers = 500,  // ms between worker calls within a batch
    maxUniversities = null,     // set to N to test on first N universities
    outputDir = "./output",
  } = options;

  // Create output directory
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const universities = maxUniversities
    ? UNIVERSITIES.slice(0, maxUniversities)
    : UNIVERSITIES;

  console.log(`\n🍛 Biryani Blitz Outreach Agent`);
  console.log(`   Processing ${universities.length} universities`);
  console.log(`   Batch size: ${batchSize} | Delay: ${delayBetweenBatches}ms\n`);

  const allContacts = [];
  const progressLog = [];

  for (let i = 0; i < universities.length; i += batchSize) {
    const batch = universities.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(universities.length / batchSize);

    console.log(`\n📦 Batch ${batchNum}/${totalBatches}: ${batch.map((u) => u.name).join(", ")}`);

    // Process each university in the batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (university) => {
        const uContacts = [];

        try {
          // STEP 1: Manager generates queries
          console.log(`  🧠 Planning queries for ${university.name}...`);
          const queries = await planSearchQueries(university);
          console.log(`  ✓ ${queries.length} queries planned`);

          // STEP 2: Workers search in sequence (to avoid rate limits within a university)
          for (const query of queries) {
            await sleep(delayBetweenWorkers);
            console.log(`  🔍 Searching: "${query.slice(0, 60)}..."`);
            const contacts = await searchForContacts(query, university.name);
            uContacts.push(...contacts);
            if (contacts.length > 0) {
              console.log(`     ✓ Found ${contacts.length} contact(s)`);
            }
          }

          progressLog.push({ university: university.name, status: "success", count: uContacts.length });
        } catch (err) {
          console.error(`  ✗ Failed ${university.name}: ${err.message}`);
          progressLog.push({ university: university.name, status: "error", error: err.message });
        }

        return uContacts;
      })
    );

    allContacts.push(...batchResults.flat());

    // Save progress checkpoint after each batch
    const checkpoint = aggregateContacts(allContacts);
    exportToCSV(checkpoint, path.join(outputDir, "contacts_checkpoint.csv"));
    console.log(`\n  💾 Checkpoint: ${checkpoint.length} unique contacts so far`);

    // Delay before next batch
    if (i + batchSize < universities.length) {
      console.log(`  ⏳ Waiting ${delayBetweenBatches / 1000}s before next batch...`);
      await sleep(delayBetweenBatches);
    }
  }

  // STEP 3: Final aggregation
  console.log(`\n\n📊 Aggregating results...`);
  const finalContacts = aggregateContacts(allContacts);

  // Export outputs
  const csvPath = path.join(outputDir, "biryani_blitz_contacts.csv");
  const jsonPath = path.join(outputDir, "biryani_blitz_contacts.json");
  const logPath = path.join(outputDir, "run_log.json");

  exportToCSV(finalContacts, csvPath);
  exportToJSON(finalContacts, jsonPath);
  fs.writeFileSync(logPath, JSON.stringify(progressLog, null, 2));

  // Summary by department
  const byDept = finalContacts.reduce((acc, c) => {
    acc[c.department || "Unknown"] = (acc[c.department || "Unknown"] || 0) + 1;
    return acc;
  }, {});

  const byConf = finalContacts.reduce((acc, c) => {
    acc[c.confidence || "unknown"] = (acc[c.confidence || "unknown"] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n✅ Done!`);
  console.log(`   Total unique contacts: ${finalContacts.length}`);
  console.log(`   By department:`, byDept);
  console.log(`   By confidence:`, byConf);
  console.log(`\n   Output files:`);
  console.log(`   📄 ${csvPath}`);
  console.log(`   📄 ${jsonPath}`);
  console.log(`   📄 ${logPath}`);

  return finalContacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

// Parse CLI args: node agent.js --test (runs only first 3 universities)
const isTest = process.argv.includes("--test");
const maxU = process.argv.includes("--max")
  ? parseInt(process.argv[process.argv.indexOf("--max") + 1])
  : null;

runOutreachAgent({
  batchSize: 5,
  delayBetweenBatches: 3000,
  delayBetweenWorkers: 600,
  maxUniversities: isTest ? 3 : maxU,
  outputDir: "./output",
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
