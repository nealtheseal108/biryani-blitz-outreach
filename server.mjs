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

/** Merged contacts from Gemini + Anthropic pipeline outputs (deduped by email). */
app.get("/api/contacts", (req, res) => {
  try {
    const merged = new Map();
    const files = [
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

app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

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

  const outPath = body.out || "output/gemini_contacts.json";
  const outAbs = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);

  const args = [
    path.join(ROOT, "playwright-gemini.mjs"),
    "--batch",
    "--data",
    dataPath,
    "--out",
    outAbs,
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

  child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("close", (code) => {
    pushLog(`Process exited with code ${code}`);
    child = null;
  });
  child.on("error", (e) => {
    pushLog(`Spawn error: ${e.message}`);
    child = null;
  });

  res.json({ ok: true, pid: child.pid });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Biryani Blitz Outreach → http://127.0.0.1:${PORT}\n`);
});
