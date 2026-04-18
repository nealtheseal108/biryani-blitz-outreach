# Biryani Blitz University Outreach Agent

A managed 3-step AI agent that scours the web for university contact emails across
3 target departments: **Student Union**, **Campus Dining**, and **Entrepreneurship**.

## Contact Archetypes (modeled on UC Berkeley)

From your Berkeley email history, the agent searches for exact analogues of:

| Role | Name (Berkeley) | Email | Why They Matter |
|---|---|---|---|
| Director, Business Dev & Commercial Activities | Ryan Adelman-Sessler | ryansessler@berkeley.edu | Main gatekeeper for vendor placement |
| Director, Student Union Facilities & Operations | Jaime Santoyo | jsantoyo@berkeley.edu | Facilities/installation approvals |
| Associate Director, Facilities Operations | Andy Hang | andyhang@berkeley.edu | Day-to-day ops coordination |
| Director, Programs & Marketing | Ariel Feinberg-Berson | aberson@berkeley.edu | Digital signage & marketing |
| Cafe Manager, Campus Dining | Huw Thornton | huwthornton@berkeley.edu | Food service partnerships |
| Wellness Dietitian | Kim Guess | kguess@berkeley.edu | Food policy compliance |

## Setup

```bash
# 1. Set your API key (no SDK needed — uses raw fetch)
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Run a test on 3 universities first
node agent.js --test

# 3. Run on first 20 universities
node agent.js --max 20

# 4. Run the full 70-university sweep
node agent.js
```

## Output

All files are saved to `./output/`:

- `biryani_blitz_contacts.csv` — final deduped contacts ready for outreach
- `biryani_blitz_contacts.json` — same data in JSON
- `contacts_checkpoint.csv` — live-updated after each batch (so progress is never lost)
- `run_log.json` — per-university success/error log

## CSV columns

| Column | Description |
|---|---|
| university | University name |
| name | Full name |
| title | Exact job title |
| department | Student Union / Dining / Entrepreneurship / Student Life |
| email | Email address |
| phone | Phone if found |
| confidence | high / medium / low |
| source_url | URL where contact was found |

## Architecture

```
For each university:
  1. MANAGER call (no tools) → generates 4-5 targeted search queries
  2. WORKER calls (web_search enabled) → one call per query, extracts contacts as JSON
  3. Results accumulated across all universities

After all universities:
  4. AGGREGATOR → dedup by email, sort by confidence + department priority, export CSV
```

- Universities processed in batches of 5 (parallel)
- 3 second delay between batches to respect rate limits
- Checkpoint saved after every batch so you can resume if the run breaks

## Tips

- Run `--test` first to verify your API key works and see sample output
- The `confidence` column tells you how to prioritize:
  - `high` = email found directly on a staff page
  - `medium` = found in a directory listing
  - `low` = email format inferred (e.g. first.last@university.edu guessed from name)
- Low-confidence emails should be verified before cold outreach
- Full run (~70 universities × 5 queries each = ~350 API calls) takes 20-40 minutes
  and costs approximately $3-8 depending on search results length
