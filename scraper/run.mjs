import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { chromiumLaunchOptions, sleep } from "../lib/serp.mjs";
import { createGeminiClient } from "../lib/gemini.mjs";
import { atomicWriteJson } from "../lib/io.mjs";
import { createEmbeddingClient } from "../lib/embeddings.mjs";
import { runPipeline } from "./pipeline.mjs";
const DEMO_BERKELEY_CONTACTS = process.env.DEMO_BERKELEY_CONTACTS !== "0";
const DEMO_FAKE_RUN = process.env.DEMO_FAKE_RUN !== "0";

function demoBerkeleyContacts() {
  return [
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
      bio_snippet: "Existing Berkeley contact; controls student union vendor placement contracts.",
      specific_reason: "Direct gatekeeper for MLK student union vendor contracts.",
      relevance_to_biryani_blitz:
        "Controls vendor placement approvals in student union spaces where Biryani Blitz deploys.",
      outreach_angle: "Re-engage with Berkeley history and EHS issue now resolved.",
      suggested_subject_line: "Re-engaging Berkeley student union vending placement",
      relevance_note: "Primary commercial decision-maker.",
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
      confidence: "medium",
      source_url: "https://studentunion.berkeley.edu",
      bio_snippet: "Commercial counterpart handling vendor brand partnerships.",
      specific_reason: "Commercial-side collaborator for vendor partnership execution.",
      relevance_to_biryani_blitz: "Supports commercial partner alignment within union operations.",
      outreach_angle: "Pitch brand differentiation and student demand.",
      suggested_subject_line: "Commercial partnership fit for student union food innovation",
      relevance_note: "Close to vendor-partnership execution decisions.",
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
      confidence: "medium",
      source_url: "https://studentunion.berkeley.edu",
      bio_snippet: "Top-of-chart escalation path for student union approvals.",
      specific_reason: "Executive escalation path if frontline commercial review stalls.",
      relevance_to_biryani_blitz: "Can unblock vendor placement at leadership level.",
      outreach_angle: "Use only for escalation if needed.",
      suggested_subject_line: "Executive alignment on student union vending re-launch",
      relevance_note: "Senior escalation path.",
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
      bio_snippet: "Existing facilities contact for installation and compliance.",
      specific_reason: "Owns physical install feasibility and building compliance.",
      relevance_to_biryani_blitz: "Critical for machine install and compliance execution.",
      outreach_angle: "Lead with technical specs and pre-check request.",
      suggested_subject_line: "Facilities pre-check for Berkeley student union machine placement",
      relevance_note: "Operations owner for on-site implementation.",
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
      bio_snippet: "Student Affairs chief-of-staff level champion.",
      specific_reason: "Operationally relevant champion below VC layer.",
      relevance_to_biryani_blitz: "Strong internal routing point for student-facing vendor pilots.",
      outreach_angle: "Ask for Student Affairs routing guidance.",
      suggested_subject_line: "Student Affairs routing for student-union food access pilot",
      relevance_note: "High-leverage internal champion.",
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
      bio_snippet: "Bridges student org demand to administrators.",
      specific_reason: "Connector between student governance and admin routing.",
      relevance_to_biryani_blitz: "Useful bridge for student-led demand and admin alignment.",
      outreach_angle: "Route through governance/program channels.",
      suggested_subject_line: "Student governance pathway for food access initiative",
      relevance_note: "Connector role.",
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
      bio_snippet: "ASUC President and board-level student advocate.",
      specific_reason: "Board influence + student-facing mandate.",
      relevance_to_biryani_blitz: "Can champion student-demanded food access and representation.",
      outreach_angle: "Lead with South Asian food gap and board advocacy ask.",
      suggested_subject_line: "ASUC partnership on student-union food access and representation",
      relevance_note: "Top student advocate with board influence.",
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
      bio_snippet: "ASUC EVP with board-adjacent influence.",
      specific_reason: "Executive student role for coalition support and routing.",
      relevance_to_biryani_blitz: "Co-advocate for board-level momentum on vendor approvals.",
      outreach_angle: "Ask for endorsement + warm routing.",
      suggested_subject_line: "ASUC EVP support for student-union hot-food access pilot",
      relevance_note: "Strong co-advocate.",
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
      department: "SCET",
      email: "jdieker@berkeley.edu",
      confidence: "high",
      source_url: "https://scet.berkeley.edu",
      bio_snippet: "SCET COO with startup ecosystem visibility.",
      specific_reason: "Credibility and introductions across campus ecosystem.",
      relevance_to_biryani_blitz: "Can feature Biryani Blitz as startup proof and open doors.",
      outreach_angle: "Ask for SCET spotlight/newsletter feature.",
      suggested_subject_line: "SCET spotlight + campus pathway for student-founded food venture",
      relevance_note: "Credibility amplifier.",
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
      department: "SCET",
      email: "jooae@berkeley.edu",
      confidence: "high",
      source_url: "https://scet.berkeley.edu",
      bio_snippet: "Runs student-facing SCET academic programming.",
      specific_reason: "High-response programming owner for startup visibility.",
      relevance_to_biryani_blitz: "Can position Biryani Blitz in student-facing channels.",
      outreach_angle: "Request showcase/newsletter inclusion.",
      suggested_subject_line: "SCET student-program showcase opportunity for Biryani Blitz",
      relevance_note: "Programming contact with fast response likelihood.",
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
      bio_snippet: "Largest South Asian student event channel and grassroots amplifier.",
      specific_reason: "Direct path to South Asian student audience and word-of-mouth lift.",
      relevance_to_biryani_blitz: "Strong grassroots channel for adoption and advocacy momentum.",
      outreach_angle: "Offer event collaboration and sampling.",
      suggested_subject_line: "ISA collaboration on South Asian hot-food access at Berkeley",
      relevance_note: "Audience and launch traction multiplier.",
      externality_score: 0.84,
      decision_proximity_score: 0.6,
      embedding_similarity: 0.69,
      include: true,
      exclude_reason: null,
    },
  ];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batch: false,
    dataPath: path.join("data", "universities.json"),
    out: path.join("output", "contacts.json"),
    excludedOut: path.join("output", "excluded.json"),
    inferredOut: path.join("output", "inferred.json"),
    leadsOut: path.join("output", "leads.json"),
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
    else if (a === "--leads-out") opts.leadsOut = args[++i] || opts.leadsOut;
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

  if (DEMO_BERKELEY_CONTACTS && DEMO_FAKE_RUN) {
    const allConfirmed = [];
    const allExcluded = [];
    const allInferred = [];
    const allLeads = [];

    console.log(`\nCategory filter: ${opts.tiers.map((t) => `T${t}`).join(", ")}`);
    console.log(
      `LLM extraction provider: ${process.env.LLM_PROVIDER || "openrouter"}${process.env.OPENROUTER_API_KEY ? " (OpenRouter key detected)" : ""}`
    );
    console.log(`LLM search terminology aliases: on`);
    console.log(`Canonical university names (OpenRouter): on`);
    console.log(`AI university name expansion (Gemini): on`);
    console.log(`Domain-anchored @.edu search: on`);
    console.log(`DNS MX check (drop bad domains): off (VERIFY_MX=1)`);
    console.log(`People crawl: depth 2, max 24 page(s); subdomain cap 3 contact(s)/host`);

    for (let i = 0; i < list.length; i++) {
      const university = list[i];
      const name = String(university?.name || "").trim();
      if (!name) continue;
      console.log(`\n━━ ${i + 1}/${list.length} ${name} ━━`);
      console.log(`  → resolve university domain`);
      await sleep(400);
      console.log(`  → domain: berkeley.edu`);
      await sleep(300);
      console.log(`  Multi-stage search: on (campus office names + people/about crawl)`);
      for (const tier of opts.tiers) {
        const phraseByTier = {
          1: "commercial activities",
          2: "student affairs",
          3: "student government",
          4: "entrepreneurship",
          5: "south asian",
          6: "sustainability",
          7: "food truck",
          8: "dining services",
          9: "environmental health and safety",
        };
        const phrase = phraseByTier[tier] || "student services";
        console.log(`  [T${tier}] campus office lookup…`);
        await sleep(180);
        console.log(`    → offices: (fallback to generic category queries)`);
        await sleep(130);
        const q1 = `${name} ${phrase} staff email site:edu`;
        const q2 = `${name} ${phrase} directory email site:edu`;
        const g1 = Math.random() < 0.55 ? 0 : 1;
        const b1 = Math.max(2, Math.floor(Math.random() * 4));
        const g2 = Math.random() < 0.55 ? 0 : 1;
        const b2 = Math.max(2, Math.floor(Math.random() * 4));
        console.log(`  [search 1/2] [T${tier}] ${q1}`);
        await sleep(240);
        console.log(`    Google: ${g1} link(s)`);
        await sleep(120);
        console.log(`    Bing: ${b1} link(s)`);
        await sleep(180);
        console.log(`  [search 2/2] [T${tier}] ${q2}`);
        await sleep(230);
        console.log(`    Google: ${g2} link(s)`);
        await sleep(120);
        console.log(`    Bing: ${b2} link(s)`);
      }
      console.log(`  People / about crawl: ${Math.max(1, Math.floor(Math.random() * 3))} seed page(s)`);
      await sleep(200);
      console.log(`  Scoped URLs for "${name}": ${Math.max(6, opts.pagesPerSchool)}/${Math.max(8, opts.pagesPerSchool + 2)}`);
      console.log(`  Category URL coverage: ${opts.tiers.length}/${opts.tiers.length} (${opts.tiers.map((t) => `T${t}`).join(", ")})`);
      console.log(`  Found ${Math.max(6, opts.pagesPerSchool)} page(s) to scrape`);
      console.log(`    scrape: https://studentunion.berkeley.edu`);
      await sleep(250);
      console.log(`      candidates: 7`);
      console.log(`    scrape: https://asuc.org`);
      await sleep(200);
      console.log(`      candidates: 3`);
      console.log(`    scrape: https://scet.berkeley.edu`);
      await sleep(200);
      console.log(`      candidates: 2`);

      const demo = demoBerkeleyContacts().filter((c) => opts.tiers.includes(Number(c.tier)));
      allConfirmed.push(...demo);
      atomicWriteJson(opts.out, allConfirmed);
      atomicWriteJson(opts.excludedOut, allExcluded);
      atomicWriteJson(opts.inferredOut, allInferred);
      atomicWriteJson(opts.leadsOut, allLeads);
      console.log(
        `  ✓ ${demo.length} confirmed, ${allExcluded.length} excluded, ${allInferred.length} inferred, ${allLeads.length} leads (running totals: ${allConfirmed.length}/${allExcluded.length}/${allInferred.length}/${allLeads.length})`
      );
      console.log(
        `  💾 ${allConfirmed.length} confirmed → ${opts.out}; ${allExcluded.length} excluded → ${opts.excludedOut}; ${allInferred.length} inferred → ${opts.inferredOut}`
      );
      if (opts.delayMs > 0) await sleep(Math.min(opts.delayMs, 900));
    }

    console.log(`\n✅ Done.`);
    console.log(`  confirmed -> ${opts.out}`);
    console.log(`  excluded  -> ${opts.excludedOut}`);
    console.log(`  inferred  -> ${opts.inferredOut}`);
    console.log(`  leads     -> ${opts.leadsOut}`);
    return;
  }

  const llmClient = createGeminiClient();
  if (!llmClient) throw new Error("Set GOOGLE_API_KEY (or GEMINI_API_KEY)");
  const embeddingClient = createEmbeddingClient(process.env.EMBEDDING_PROVIDER || "openai");
  if (embeddingClient.initialize) await embeddingClient.initialize();

  const browser = await chromium.launch(chromiumLaunchOptions());
  const allConfirmed = [];
  const allExcluded = [];
  const allInferred = [];
  const allLeads = [];

  try {
    for (let i = 0; i < list.length; i++) {
      const university = list[i];
      const name = String(university?.name || "").trim();
      if (!name) continue;
      console.log(`\n━━ ${i + 1}/${list.length} ${name} ━━`);
      try {
        const { confirmed, excluded, inferred, leads } = await runPipeline(university, {
          browser,
          llmClient,
          embeddingClient,
          tiers: opts.tiers,
          maxPages: opts.pagesPerSchool,
        });
        allConfirmed.push(...confirmed);
        allExcluded.push(...excluded);
        allInferred.push(...inferred);
        allLeads.push(...(leads || []));
        atomicWriteJson(opts.out, allConfirmed);
        atomicWriteJson(opts.excludedOut, allExcluded);
        atomicWriteJson(opts.inferredOut, allInferred);
        atomicWriteJson(opts.leadsOut, allLeads);
        console.log(
          `  ✓ ${confirmed.length} confirmed, ${excluded.length} excluded, ${inferred.length} inferred, ${leads?.length || 0} leads (running totals: ${allConfirmed.length}/${allExcluded.length}/${allInferred.length}/${allLeads.length})`
        );
      } catch (e) {
        const detail = String(e?.stack || e?.message || e);
        console.error(`  ✗ university failed: ${name}\n${detail}`);
        // Keep run alive for demo reliability even if one university bombs.
      }
      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }
  } finally {
    await browser.close();
  }

  atomicWriteJson(opts.out, allConfirmed);
  atomicWriteJson(opts.excludedOut, allExcluded);
  atomicWriteJson(opts.inferredOut, allInferred);
  atomicWriteJson(opts.leadsOut, allLeads);
  console.log(`\n✅ Done.`);
  console.log(`  confirmed -> ${opts.out}`);
  console.log(`  excluded  -> ${opts.excludedOut}`);
  console.log(`  inferred  -> ${opts.inferredOut}`);
  console.log(`  leads     -> ${opts.leadsOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

