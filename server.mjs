/**
 * Express app: glassmorphic chat UI (public/) + API to run Playwright + Gemini batch jobs.
 * Local: http://127.0.0.1:3847  ·  Production (Render): set PORT, GOOGLE_API_KEY, RENDER=1
 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.env.OUTREACH_GUI_PORT || 3847);
const UNIVERSITIES_PATH = path.join(ROOT, "data", "universities.json");
const OUTREACH_STATE_PATH = path.join(ROOT, "data", "outreach-state.json");
const CONTACT_CHECKS_PATH = path.join(ROOT, "data", "contact-checks.json");
const DEMO_BERKELEY_CONTACTS = process.env.DEMO_BERKELEY_CONTACTS !== "0";

const BERKELEY_DEMO_CONTACTS = [
  {
    university: "University of California, Berkeley",
    tier: 1,
    tier_label: "Student Union / Commercial — contract gatekeeper",
    name: "Ryan Adelman-Sessler",
    title: "Director, Business Development & Commercial Activities",
    department: "ASUC Student Union",
    email: "ryansessler@berkeley.edu",
    confidence: "high",
    source_url: "https://studentunion.berkeley.edu",
    bio_snippet:
      "Your existing contact at Berkeley who approved the initial deployment and oversees student union commercial activity.",
    specific_reason:
      "Controls student union vendor placement contracts in MLK building and is a direct contract gatekeeper.",
    relevance_to_biryani_blitz:
      "As Director of Business Development & Commercial Activities, Ryan controls the exact vendor placement approvals Biryani Blitz needs for student union deployment.",
    outreach_angle:
      "Reference prior Berkeley history and position this as a re-engagement after EHS/certification cleanup.",
    suggested_subject_line: "Re-engaging Berkeley student union vending placement",
    relevance_note:
      "Primary commercial decision-maker for student union vendor onboarding and placement.",
    externality_score: 0.95,
    decision_proximity_score: 0.93,
    embedding_similarity: 0.91,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 1,
    tier_label: "Student Union / Commercial — contract gatekeeper",
    name: "Gabriella Tassano",
    title: "Associate Director of Marketing, Brand & Commercial Activities",
    department: "ASUC Student Union Commercial Activities",
    email: "gtassano@berkeley.edu",
    confidence: "high",
    source_url: "https://studentunion.berkeley.edu",
    bio_snippet:
      "Direct commercial counterpart on Ryan's team handling marketing and brand partnerships tied to commercial vendors.",
    specific_reason:
      "Commercial-side collaborator who handles brand/commercial vendor relationships relevant to placement rollout.",
    relevance_to_biryani_blitz:
      "As Associate Director on the commercial activities team, Gabriella can accelerate partnership framing and internal alignment for vendor placement.",
    outreach_angle:
      "Lead with brand differentiation (first hot South Asian option) and tie it to existing union commercial goals.",
    suggested_subject_line: "Commercial partnership fit for student union food innovation",
    relevance_note:
      "Commercial team member close to vendor/partnership execution decisions.",
    externality_score: 0.9,
    decision_proximity_score: 0.86,
    embedding_similarity: 0.85,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 1,
    tier_label: "Student Union / Commercial — contract gatekeeper",
    name: "Jen Siecienski",
    title: "Executive Director / ADOS",
    department: "ASUC Student Union Leadership",
    email: "jsiecienski@berkeley.edu",
    confidence: "high",
    source_url: "https://studentunion.berkeley.edu",
    bio_snippet:
      "Senior union leader at the top of the Student Union org chart and escalation path for commercial approvals.",
    specific_reason:
      "Executive escalation path tied to board-facing union operations and commercial decision oversight.",
    relevance_to_biryani_blitz:
      "As Executive Director/ADOS, Jen is the escalation path if frontline commercial review stalls and can unblock vendor placement decisions.",
    outreach_angle:
      "Position as executive-level re-engagement request only if commercial-side approvals need leadership confirmation.",
    suggested_subject_line: "Executive alignment on student union vending re-launch",
    relevance_note:
      "Top-of-chart escalation contact for student union placement process.",
    externality_score: 0.83,
    decision_proximity_score: 0.77,
    embedding_similarity: 0.78,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 1,
    tier_label: "Student Union / Commercial — contract gatekeeper",
    name: "Jaime Santoyo",
    title: "Director of Facilities Maintenance & Operations",
    department: "ASUC Student Union Facilities",
    email: "jsantoyo@berkeley.edu",
    confidence: "high",
    source_url: "https://studentunion.berkeley.edu",
    bio_snippet:
      "Existing operations contact responsible for physical installation, seismic review, and building compliance constraints.",
    specific_reason:
      "Owns facilities and compliance execution required to physically install and operate vending hardware in union spaces.",
    relevance_to_biryani_blitz:
      "As Director of Facilities Maintenance & Operations, Jaime controls physical-install feasibility and compliance for any machine deployment.",
    outreach_angle:
      "Use a technical opener: share footprint/electrical specs and ask for pre-check on installation constraints.",
    suggested_subject_line: "Facilities pre-check for Berkeley student union machine placement",
    relevance_note:
      "Critical operations owner for on-site machine implementation.",
    externality_score: 0.9,
    decision_proximity_score: 0.87,
    embedding_similarity: 0.86,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 2,
    tier_label: "Student Life — internal champion",
    name: "Becca Lopez",
    title: "Interim Assistant Vice Chancellor & Chief of Staff, Student Affairs",
    department: "Student Affairs",
    email: "becca.lopez@berkeley.edu",
    confidence: "high",
    source_url: "https://sa.berkeley.edu",
    bio_snippet:
      "Chief of Staff in Student Affairs at the right operational level to route and champion vendor-adjacent student experience initiatives.",
    specific_reason:
      "Strong internal champion below the VC layer who can help move student-facing vendor initiatives through Student Affairs.",
    relevance_to_biryani_blitz:
      "As Interim AVC & Chief of Staff, Becca is a practical Student Affairs entry point for student-facing food access pilots and cross-unit coordination.",
    outreach_angle:
      "Lead with student access outcomes and ask for guidance on the best Student Affairs path to evaluate the concept.",
    suggested_subject_line: "Student Affairs routing for student-union food access pilot",
    relevance_note:
      "High-leverage champion role at the correct seniority for action.",
    externality_score: 0.81,
    decision_proximity_score: 0.73,
    embedding_similarity: 0.74,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 2,
    tier_label: "Student Life — internal champion",
    name: "Mickael Candelaria",
    title: "Director, Student Governance & Program Advising",
    department: "Student Affairs",
    email: "mcandelaria@berkeley.edu",
    confidence: "medium",
    source_url: "https://lead.berkeley.edu",
    bio_snippet:
      "Bridges student organizations and administrators through governance/program advising and can champion student-founded concepts.",
    specific_reason:
      "Program/governance bridge role well-positioned to connect student demand signals with administrative routing.",
    relevance_to_biryani_blitz:
      "As Director of Student Governance & Program Advising, Mickael can connect student org demand with the right administrative decision-makers.",
    outreach_angle:
      "Reference student-led origin and ask how to route through governance/program channels for support.",
    suggested_subject_line: "Student governance pathway for food access initiative",
    relevance_note:
      "Useful connector role between student groups and operations/admin teams.",
    externality_score: 0.73,
    decision_proximity_score: 0.64,
    embedding_similarity: 0.68,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 3,
    tier_label: "Student Government — board advocate",
    name: "Abigail Verino",
    title: "ASUC President (148th)",
    department: "ASUC",
    email: "president@asuc.org",
    confidence: "high",
    source_url: "https://asuc.org",
    bio_snippet:
      "Current student body president and Student Union board participant focused on representation, student needs, and campus services.",
    specific_reason:
      "Elected student leader with board-level influence and strong alignment to food access and multicultural representation.",
    relevance_to_biryani_blitz:
      "As ASUC President and board participant, Abigail can champion Biryani Blitz as a student-demanded food access and representation initiative.",
    outreach_angle:
      "Lead with South Asian food gap in the union and ask for advocacy on board-level vendor consideration.",
    suggested_subject_line: "ASUC partnership on student-union food access and representation",
    relevance_note:
      "Top student advocate with direct influence on student-facing policy priorities.",
    externality_score: 0.86,
    decision_proximity_score: 0.76,
    embedding_similarity: 0.79,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 3,
    tier_label: "Student Government — board advocate",
    name: "Isha Chander",
    title: "ASUC Executive Vice President",
    department: "ASUC",
    email: "evp@asuc.org",
    confidence: "high",
    source_url: "https://asuc.org",
    bio_snippet:
      "Executive student officer with student union board influence and constituency-facing responsibilities.",
    specific_reason:
      "Board-adjacent elected role that can support advocacy and coalition-building for vendor approvals.",
    relevance_to_biryani_blitz:
      "As ASUC EVP, Isha can co-advocate for student demand and support routing to union commercial stakeholders.",
    outreach_angle:
      "Ask for executive student-government endorsement and warm routing to union commercial decision-makers.",
    suggested_subject_line: "ASUC EVP support for student-union hot-food access pilot",
    relevance_note:
      "Strong co-advocate alongside ASUC President for board-level momentum.",
    externality_score: 0.82,
    decision_proximity_score: 0.72,
    embedding_similarity: 0.75,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 4,
    tier_label: "Entrepreneurship — credibility builder",
    name: "Jesse Dieker",
    title: "Chief Operating Officer, SCET",
    department: "Sutardja Center for Entrepreneurship & Technology",
    email: "jdieker@berkeley.edu",
    confidence: "high",
    source_url: "https://scet.berkeley.edu",
    bio_snippet:
      "COO for Berkeley SCET with day-to-day authority over student-facing entrepreneurship programming and partner exposure.",
    specific_reason:
      "Operational leader at Berkeley's entrepreneurship hub can provide credibility, introductions, and campus visibility.",
    relevance_to_biryani_blitz:
      "As SCET COO, Jesse can feature Biryani Blitz as a student-startup success and open credibility channels across campus stakeholders.",
    outreach_angle:
      "Frame Biryani Blitz as entrepreneurship ecosystem proof and ask for spotlight/intro pathways to operational decision-makers.",
    suggested_subject_line: "SCET spotlight + campus pathway for student-founded food venture",
    relevance_note:
      "Credibility amplifier with strong ecosystem reach.",
    externality_score: 0.79,
    decision_proximity_score: 0.67,
    embedding_similarity: 0.72,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 4,
    tier_label: "Entrepreneurship — credibility builder",
    name: "Joo Ae Chu",
    title: "Associate Director, Academic Programs, SCET",
    department: "Sutardja Center for Entrepreneurship & Technology",
    email: "jooae@berkeley.edu",
    confidence: "high",
    source_url: "https://scet.berkeley.edu",
    bio_snippet:
      "Runs student-facing SCET academic programming and startup engagement opportunities.",
    specific_reason:
      "Student-facing programming owner who can feature and route startup opportunities quickly.",
    relevance_to_biryani_blitz:
      "As Associate Director of Academic Programs at SCET, Joo Ae can help position Biryani Blitz in student-facing channels and warm introductions.",
    outreach_angle:
      "Request inclusion in SCET startup showcases/newsletters to build institutional credibility before broader admin outreach.",
    suggested_subject_line: "SCET student-program showcase opportunity for Biryani Blitz",
    relevance_note:
      "High-response programming contact for ecosystem visibility.",
    externality_score: 0.77,
    decision_proximity_score: 0.63,
    embedding_similarity: 0.7,
    include: true,
    exclude_reason: null,
  },
  {
    university: "University of California, Berkeley",
    tier: 5,
    tier_label: "Cultural Center — South Asian audience",
    name: "ISA Berkeley (General)",
    title: "Indian Students Association Berkeley",
    department: "Student Cultural Organizations",
    email: "isaberkeley@gmail.com",
    confidence: "high",
    source_url: "https://localwiki.org/berkeley/Indian_Students_Association",
    bio_snippet:
      "Primary student org channel reaching a large South Asian student audience through major cultural events.",
    specific_reason:
      "Direct grassroots amplifier to the target audience and ideal for pilot buzz, sampling, and event partnerships.",
    relevance_to_biryani_blitz:
      "ISA Berkeley can amplify awareness to core South Asian student demand and provide grassroots advocacy for student union placement.",
    outreach_angle:
      "Offer event collaboration/free samples and position Biryani Blitz as a culturally relevant student food-access solution.",
    suggested_subject_line: "ISA collaboration on South Asian hot-food access at Berkeley",
    relevance_note:
      "Audience and word-of-mouth multiplier for launch traction.",
    externality_score: 0.84,
    decision_proximity_score: 0.6,
    embedding_similarity: 0.69,
    include: true,
    exclude_reason: null,
  },
];

function readContactsJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const app = express();
app.use(express.json({ limit: "4mb" }));

let child = null;
const logLines = [];
const MAX_LOG = 500;
let demoContactsArmed = false;
let demoContactsReady = false;

function pushLog(line) {
  const s = String(line).replace(/\r$/, "");
  logLines.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  while (logLines.length > MAX_LOG) logLines.shift();
}

function parseSchoolsCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    const cells = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    const clean = (s) => s.replace(/^"|"$/g, "").trim();
    if (cells.length === 1) {
      out.push({ name: clean(cells[0]), city: "", entrepreneurship: "" });
    } else {
      out.push({
        name: clean(cells[0] || ""),
        city: clean(cells[1] || ""),
        entrepreneurship: clean(cells[2] || "") || "Entrepreneurship Center",
      });
    }
  }
  return out;
}

app.get("/health", (req, res) => {
  res.type("text").send("ok");
});

app.get("/api/universities", (req, res) => {
  try {
    if (!fs.existsSync(UNIVERSITIES_PATH)) {
      return res.status(404).json({ error: "data/universities.json not found" });
    }
    const data = JSON.parse(fs.readFileSync(UNIVERSITIES_PATH, "utf8"));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/outreach-state", (req, res) => {
  try {
    if (!fs.existsSync(OUTREACH_STATE_PATH)) {
      return res.json({});
    }
    const data = JSON.parse(fs.readFileSync(OUTREACH_STATE_PATH, "utf8"));
    res.json(typeof data === "object" && data !== null ? data : {});
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/outreach-state", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    fs.mkdirSync(path.dirname(OUTREACH_STATE_PATH), { recursive: true });
    fs.writeFileSync(OUTREACH_STATE_PATH, JSON.stringify(body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Merged contacts outputs (deduped by email). */
app.get("/api/contacts", (req, res) => {
  try {
    const demoRequested = String(req.query.demo || "") === "1";
    if (DEMO_BERKELEY_CONTACTS && demoContactsArmed && demoContactsReady && demoRequested) {
      return res.json(BERKELEY_DEMO_CONTACTS);
    }
    const merged = new Map();
    const files = [
      path.join(ROOT, "output", "contacts.json"),
      path.join(ROOT, "output", "gemini_contacts.json"),
      path.join(ROOT, "output", "biryani_blitz_contacts.json"),
    ];
    for (const fp of files) {
      for (const row of readContactsJsonArray(fp)) {
        const em = String(row.email || "")
          .toLowerCase()
          .trim();
        if (!em || em === "null" || em === "n/a") continue;
        const prev = merged.get(em);
        if (!prev) merged.set(em, { ...row });
        else merged.set(em, { ...prev, ...row, email: row.email || prev.email });
      }
    }
    const list = [...merged.values()].sort((a, b) => {
      const ua = String(a.university || "");
      const ub = String(b.university || "");
      if (ua !== ub) return ua.localeCompare(ub);
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Per-email contacted flags: { "email@edu": true } */
app.get("/api/contact-checks", (req, res) => {
  try {
    if (!fs.existsSync(CONTACT_CHECKS_PATH)) return res.json({});
    const data = JSON.parse(fs.readFileSync(CONTACT_CHECKS_PATH, "utf8"));
    res.json(typeof data === "object" && data !== null ? data : {});
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/contact-checks", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    fs.mkdirSync(path.dirname(CONTACT_CHECKS_PATH), { recursive: true });
    fs.writeFileSync(CONTACT_CHECKS_PATH, JSON.stringify(body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(
  express.static(path.join(ROOT, "public"), {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        // Ensure latest UI changes are always fetched after deploy.
        res.setHeader("Cache-Control", "no-store, max-age=0");
      }
    },
  })
);

app.get("/api/status", (req, res) => {
  res.json({
    running: !!child,
    pid: child?.pid ?? null,
    hasKey: !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY),
  });
});

app.get("/api/logs", (req, res) => {
  res.json({ lines: logLines });
});

app.post("/api/stop", (req, res) => {
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* empty */
    }
    child = null;
    demoContactsReady = false;
    pushLog("Stopped by user.");
  }
  res.json({ ok: true });
});

app.post("/api/start", (req, res) => {
  if (child) {
    return res.status(409).json({ error: "A job is already running." });
  }

  const body = req.body || {};
  const apiKey = body.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: "Add GOOGLE_API_KEY in the Render dashboard (or paste a key in the app).",
    });
  }

  const tiers = Array.isArray(body.tiers)
    ? body.tiers.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 9)
    : [];
  if (tiers.length === 0) {
    return res.status(400).json({ error: "Select at least one contact tier (T1–T9)." });
  }

  const useBuiltInList = !!body.useBuiltInList;
  let dataPath = path.join(ROOT, "data", "universities.json");

  if (!useBuiltInList) {
    const csv = String(body.schoolsCsv || "").trim();
    if (!csv) {
      return res.status(400).json({
        error: "Paste a CSV of schools, or turn on “Use built-in 70-school list”.",
      });
    }
    const schools = parseSchoolsCsv(csv);
    if (!schools.length) {
      return res.status(400).json({ error: "Could not parse any schools from CSV." });
    }
    dataPath = path.join(ROOT, "data", `job-${Date.now()}.json`);
    fs.writeFileSync(dataPath, JSON.stringify(schools, null, 2), "utf8");
    pushLog(`Wrote ${schools.length} school(s) → ${path.relative(ROOT, dataPath)}`);
  }

  if (!fs.existsSync(dataPath)) {
    return res.status(400).json({ error: `Missing data file: ${dataPath}` });
  }

  const outPath = body.out || "output/contacts.json";
  const outAbs = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);

  const args = [
    path.join(ROOT, "scraper", "run.mjs"),
    "--batch",
    "--data",
    dataPath,
    "--out",
    outAbs,
    "--excluded-out",
    path.join(ROOT, "output", "excluded.json"),
    "--inferred-out",
    path.join(ROOT, "output", "inferred.json"),
    "--leads-out",
    path.join(ROOT, "output", "leads.json"),
    "--tiers",
    [...new Set(tiers)].sort((a, b) => a - b).join(","),
  ];
  if (body.max != null && body.max !== "" && Number(body.max) > 0) {
    args.push("--max", String(Number(body.max)));
  }
  if (body.start != null && Number(body.start) > 0) {
    args.push("--start", String(Number(body.start)));
  }
  if (body.pagesPerSchool) args.push("--pages-per-school", String(Number(body.pagesPerSchool) || 5));
  if (body.delayMs) args.push("--delay", String(Number(body.delayMs) || 2800));

  logLines.length = 0;
  pushLog(`node ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

  const env = {
    ...process.env,
    GOOGLE_API_KEY: apiKey,
    GEMINI_API_KEY: apiKey,
    RENDER: process.env.RENDER || "",
    PLAYWRIGHT_CHROMIUM_ARGS: process.env.PLAYWRIGHT_CHROMIUM_ARGS || (process.env.RENDER ? "1" : ""),
  };

  if (DEMO_BERKELEY_CONTACTS) {
    // Demo contacts are requested only after explicit "Send & run",
    // but are released only when the fake run fully finishes.
    demoContactsArmed = true;
    demoContactsReady = false;
  }

  child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("close", (code) => {
    pushLog(`Process exited with code ${code}`);
    if (DEMO_BERKELEY_CONTACTS) {
      demoContactsReady = code === 0;
    }
    child = null;
  });
  child.on("error", (e) => {
    pushLog(`Spawn error: ${e.message}`);
    demoContactsReady = false;
    child = null;
  });

  res.json({ ok: true, pid: child.pid });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Biryani Blitz Outreach → http://127.0.0.1:${PORT}\n`);
});
