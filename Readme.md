# AI Search API

Serverless API powering an AI chat assistant for Estipona Group's marketing site. Given a prospective client's needs, it has a conversation with them, surfaces relevant case studies, and flags when a contact form should be shown.

Deployed as Vercel Functions (no framework — plain Node handlers in `/api`).

## How it works

- **`api/chat.js`** — main endpoint. Accepts either a fresh `need` string or a full `messages` history, sends it to Claude along with a system prompt (built from `systemPrompt.js` + the case study list), and returns the assistant's reply. It also:
  - strips two special inline tokens the model is instructed to emit (`[[CASE_STUDIES]]...[[/CASE_STUDIES]]` and `[[SHOW_CONTACT_FORM]]...[[/SHOW_CONTACT_FORM]]`) out of the visible reply
  - resolves recommended case studies by URL against the local `caseStudies` list (so the model can only pick from real entries, never invent details)
  - falls back to scanning the raw reply for contact info / known case study URLs if the model forgets to emit the tokens
  - returns `{ reply, showContactForm, needsSummary, hasCaseStudies, caseStudies, messages }` — `messages` includes the assistant turn appended, so the caller can pass it straight back in as history on the next request

- **`api/systemPrompt.js`** — builds the system prompt that defines the assistant's persona (first-person Estipona Group rep), rules for when to surface case studies vs. ask clarifying questions, and the exact token formats described above. Exports the token regexes and contact info constants alongside the prompt builder so they can't drift out of sync.

- **`api/caseStudies.js`** — static array of ~35 Estipona Group case studies (title, client, services, industry, summary, result, url) used both as prompt context and as the source of truth for recommendation lookups.

- **`api/match.js`** — standalone endpoint that takes a `need` string and asks Claude to return the 2-3 most relevant case studies as raw JSON, independent of the conversational flow in `chat.js`. Currently unused/empty in this checkout — see git history if reviving it.

Model used: `claude-haiku-4-5-20251001` (a larger model previously hit token limits once the full case study list is included in the system prompt — see comment in `chat.js`).

## Requirements

- Node.js 18+
- [Vercel CLI](https://vercel.com/docs/cli) — install globally:
  ```bash
  npm i -g vercel@latest
  ```
- An Anthropic API key with access to the Claude models above

## Setup

```bash
npm install
```

Environment variables (stored in `.env.local`, gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

This project is already linked to a Vercel project (`ai-search-api`). To pull the latest env vars from Vercel instead of setting them by hand:

```bash
vercel env pull .env.local
```

## Run locally

```bash
vercel dev
```

Runs the `/api` functions locally (default `http://localhost:3000`). Test with:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"need": "We need help launching a new nonprofit brand."}'
```

On subsequent turns, pass the returned `messages` array back as the request body's `messages` field to continue the conversation.

## Deploy

```bash
vercel        # preview deployment
vercel --prod # production deployment
```

Make sure `ANTHROPIC_API_KEY` is set for the relevant environment in the Vercel dashboard (or via `vercel env add`) before deploying.
