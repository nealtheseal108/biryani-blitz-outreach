# Biryani Blitz — University Outreach

Managed **Anthropic** agent (manager → parallel web-search workers → aggregator) plus a static **glassmorphic dashboard** for browsing and exporting contacts.

**GitHub:** [github.com/nealtheseal108/biryani-blitz-outreach](https://github.com/nealtheseal108/biryani-blitz-outreach)

## Nine outreach tiers (priority order)

| Tier | Track |
| --- | --- |
| **T1** | Student Union / Commercial Activities (vendor & contract gatekeepers) |
| **T2** | Student Life / Student Experience |
| **T3** | Student Government / board advocates |
| **T4** | Entrepreneurship / student ventures |
| **T5** | Cultural centers — South Asian & multicultural affairs |
| **T6** | Sustainability / green events / vendor lists |
| **T7** | Food truck / mobile vendor coordinator (unions) |
| **T8** | Campus dining / auxiliary services |
| **T9** | EHS / food safety / temp food permits |

The manager emits **exactly nine** search strings per school (T1–T9). Workers run **in parallel** per university (staggered slightly to reduce rate limits). Results are deduped by **email**, sorted by **tier** (ascending) then **confidence**.

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- Anthropic API key with access to **Claude** and the **web search** tool

## Run the agent

```bash
cd biryani-blitz-outreach
export ANTHROPIC_API_KEY=sk-ant-...

# Smoke test: first 3 schools (~9 worker calls each → ~27 searches)
node agent.js --test

# First N schools only
node agent.js --max 10

# Full list (~70 universities)
node agent.js
```

Outputs are written to `./output/`:

- `biryani_blitz_contacts.csv` / `biryani_blitz_contacts.json` — final list  
- `contacts_checkpoint.csv` — updated after each batch  
- `run_log.json` — per-university status  

### CSV columns

`university`, `tier`, `tier_label`, `name`, `title`, `department`, `email`, `phone`, `confidence`, `source_url`

## Dashboard (local or Render)

- Open **`index.html`** in a browser (double-click or any static server).
- Or drag-and-drop `biryani_blitz_contacts.json` / `.csv` from `./output/`.

`dashboard.html` redirects to `index.html` for older bookmarks.

### Deploy on Render (Static Site)

1. Push this repo to GitHub (see below).
2. In [Render](https://render.com): **New** → **Static Site** → connect `nealtheseal108/biryani-blitz-outreach`.
3. **Build command:** leave empty  
4. **Publish directory:** `.` (repository root)

Render serves `index.html` at `/` automatically. If a deploy showed a blank site before, it was likely because only `dashboard.html` existed or the published root was wrong — the app entry point is now **`index.html`** at the repo root.

## Connect and push to GitHub

If the remote is empty or you are cloning fresh:

```bash
cd biryani-blitz-outreach
git init
git add .
git commit -m "Add 9-tier outreach agent, index dashboard, Render static config"
git branch -M main
git remote add origin https://github.com/nealtheseal108/biryani-blitz-outreach.git
git push -u origin main
```

If `origin` already exists:

```bash
git remote set-url origin https://github.com/nealtheseal108/biryani-blitz-outreach.git
git push -u origin main
```

## Notes

- The API client sends `x-api-key` and `anthropic-version` headers (required by Anthropic).
- Web search finds **public** emails; treat `low` confidence rows as “verify before send.”
- Full runs are long and billed per message; use `--test` / `--max` first.
