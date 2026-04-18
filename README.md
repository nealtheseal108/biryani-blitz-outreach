# Biryani Blitz — University Outreach

**Anthropic** batch agent (`agent.js`) plus a **web app**: glassmorphic **chat UI** (`public/index.html`) to pick schools (CSV or built-in list), tick **T1–T9** tiers, and run **Playwright + Gemini**; plus a **contacts viewer** (`public/contacts.html`) for JSON/CSV.

**Repo:** [github.com/nealtheseal108/biryani-blitz-outreach](https://github.com/nealtheseal108/biryani-blitz-outreach)

**Typography:** the UI prefers **Helvetica Neue Pro** via optional self-hosted **WOFF2** files in `public/fonts/` (see `public/fonts/README.txt`). Without those files, **system** Helvetica Neue / Helvetica is used.

## Web app (local)

```bash
cd biryani-blitz-outreach
npm install
npx playwright install chromium

export GOOGLE_API_KEY="your-google-ai-studio-key"

npm start
# → http://127.0.0.1:3847  (chat)   ·   http://127.0.0.1:3847/contacts.html  (viewer)
```

In the chat: paste **CSV or one school per line**, check **tiers**, optional **built-in 70-school list**, then **Send & run**. Use **Outreach tracker** to check off contacted schools and set a **pipeline stage** per university (saved in **localStorage**, synced to **`data/outreach-state.json`** on the server). Export JSON as backup; cloud disks may reset on redeploy.

## Nine outreach tiers

| Tier | Track |
| --- | --- |
| **T1** | Student Union / Commercial |
| **T2** | Student Life / Student Experience |
| **T3** | Student Government |
| **T4** | Entrepreneurship |
| **T5** | Cultural / South Asian & multicultural |
| **T6** | Sustainability / vendor lists |
| **T7** | Food truck / mobile vendor |
| **T8** | Campus dining |
| **T9** | EHS / food safety |

The Playwright pipeline runs **one web search per selected tier** per school, then opens up to **`--pages-per-school`** `.edu` pages and calls Gemini.

## CLI (Playwright + Gemini)

```bash
export GOOGLE_API_KEY="…"
npm run scrape:batch -- --max 3 --tiers 1,4,8
```

Outputs JSON under **`output/`** (default `output/gemini_contacts.json`). Open **`/contacts.html`** in the app and drag the file in.

## Anthropic agent (`agent.js`)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node agent.js --test
```

Outputs: `output/biryani_blitz_contacts.json`, `.csv`, checkpoints.

## Deploy on Render (Docker Web Service)

This app needs **Node + Playwright** (not a static site). Use **Docker** + `render.yaml`.

1. Push this repo to GitHub (commands below).
2. [Render](https://render.com) → **New** → **Web Service** → connect **nealtheseal108/biryani-blitz-outreach**.
3. Render should detect **`render.yaml`** and **`Dockerfile`**.
4. Add environment variable **`GOOGLE_API_KEY`** (your Google AI Studio key).
5. Deploy. Open the service URL — **`/`** is the chat, **`/contacts.html`** is the viewer.

Health check: **`GET /health`** → `ok`.

## Push to GitHub

```bash
cd biryani-blitz-outreach
git add .
git status
git commit -m "Add chat web app, tier filters, Docker deploy"
git remote add origin https://github.com/nealtheseal108/biryani-blitz-outreach.git
# if remote exists: git remote set-url origin https://github.com/nealtheseal108/biryani-blitz-outreach.git
git push -u origin main
```

## Notes

- Respect **robots / terms** of search engines and target sites; add delays if throttled.
- Gemini finds **public** emails; verify low-confidence rows before outreach.
- Anthropic client uses **`x-api-key`** and **`anthropic-version`** headers.
