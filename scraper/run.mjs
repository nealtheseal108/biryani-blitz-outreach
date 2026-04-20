import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, sleep } from "../lib/serp.mjs";
import { createGeminiClient } from "../lib/gemini.mjs";
import { atomicWriteJson } from "../lib/io.mjs";
import { createEmbeddingClient } from "../lib/embeddings.mjs";
import { runPipeline } from "./pipeline.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batch: false,
    dataPath: path.join("data", "universities.json"),
    out: path.join("output", "contacts.json"),
    excludedOut: path.join("output", "excluded.json"),
    inferredOut: path.join("output", "inferred.json"),
    tiers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    max: null,
    start: 0,
    pagesPerSchool: Number(process.env.MAX_PAGES_PER_SCHOOL || 8),
    delayMs: 1200,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--batch") opts.batch = true;
    else if (a === "--data") opts.dataPath = args[++i] || opts.dataPath;
    else if (a === "--out") opts.out = args[++i] || opts.out;
    else if (a === "--excluded-out") opts.excludedOut = args[++i] || opts.excludedOut;
    else if (a === "--inferred-out") opts.inferredOut = args[++i] || opts.inferredOut;
    else if (a === "--max") opts.max = parseInt(args[++i], 10);
    else if (a === "--start") opts.start = parseInt(args[++i], 10) || 0;
    else if (a === "--pages-per-school") opts.pagesPerSchool = parseInt(args[++i], 10) || opts.pagesPerSchool;
    else if (a === "--delay") opts.delayMs = parseInt(args[++i], 10) || opts.delayMs;
    else if (a === "--tiers") {
      opts.tiers = String(args[++i] || "")
        .split(",")
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => n >= 1 && n <= 9);
      if (!opts.tiers.length) opts.tiers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.dataPath)) throw new Error(`Missing data file: ${opts.dataPath}`);
  const rows = JSON.parse(fs.readFileSync(opts.dataPath, "utf8"));
  const list = (Array.isArray(rows) ? rows : []).slice(opts.start, opts.max ? opts.start + opts.max : undefined);

  const llmClient = createGeminiClient();
  if (!llmClient) throw new Error("Set GOOGLE_API_KEY (or GEMINI_API_KEY)");
  const embeddingClient = createEmbeddingClient(process.env.EMBEDDING_PROVIDER || "openai");
  if (embeddingClient.initialize) await embeddingClient.initialize();

  const browser = await chromium.launch(chromiumLaunchOptions());
  const allConfirmed = [];
  const allExcluded = [];
  const allInferred = [];

  try {
    for (let i = 0; i < list.length; i++) {
      const university = list[i];
      const name = String(university?.name || "").trim();
      if (!name) continue;
      console.log(`\n━━ ${i + 1}/${list.length} ${name} ━━`);
      const { confirmed, excluded, inferred } = await runPipeline(university, {
        browser,
        llmClient,
        embeddingClient,
        tiers: opts.tiers,
        maxPages: opts.pagesPerSchool,
      });
      allConfirmed.push(...confirmed);
      allExcluded.push(...excluded);
      allInferred.push(...inferred);
      atomicWriteJson(opts.out, allConfirmed);
      atomicWriteJson(opts.excludedOut, allExcluded);
      atomicWriteJson(opts.inferredOut, allInferred);
      console.log(
        `  ✓ ${confirmed.length} confirmed, ${excluded.length} excluded, ${inferred.length} inferred (running totals: ${allConfirmed.length}/${allExcluded.length}/${allInferred.length})`
      );
      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }
  } finally {
    await browser.close();
  }

  atomicWriteJson(opts.out, allConfirmed);
  atomicWriteJson(opts.excludedOut, allExcluded);
  atomicWriteJson(opts.inferredOut, allInferred);
  console.log(`\n✅ Done.`);
  console.log(`  confirmed -> ${opts.out}`);
  console.log(`  excluded  -> ${opts.excludedOut}`);
  console.log(`  inferred  -> ${opts.inferredOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

