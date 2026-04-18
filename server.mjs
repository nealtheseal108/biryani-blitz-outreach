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
