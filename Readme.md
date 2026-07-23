# AI Search API

Serverless API powering an AI chat assistant for Estipona Group's marketing site. Given a prospective client's needs, it has a conversation with them, surfaces relevant case studies, and flags when a contact form should be shown.

Deployed as Vercel Functions (no framework — plain Node handlers in `/api`).

## How it works

- **`api/chat.js`** — main endpoint. Accepts either a fresh `need` string or a full `messages` history, sends it to Claude along with a system prompt (built from `systemPrompt.js` + the case study list), and returns the assistant's reply. It also:
  - strips two special inline tokens the model is instructed to emit (`[[CASE_STUDIES]]...[[/CASE_STUDIES]]` and `[[SHOW_CONTACT_FORM]]...[[/SHOW_CONTACT_FORM]]`) out of the visible reply
  - resolves recommended case studies by URL against the local `caseStudies` list (so the model can only pick from real entries, never invent details)
  - falls back to scanning the raw reply for contact info / known case study URLs if the model forgets to emit the tokens
  - returns `{ reply, showContactForm, needsSummary, hasCaseStudies, caseStudies, messages }` — `messages` includes the assistant turn appended, so the caller can pass it straight back in as history on the next request
  - logs the exchange to MongoDB via `logChat()` (see below) — never throws, so a DB outage can't break the chat response

- **`api/lib/mongodb.js`** — cached MongoDB connection (`MongoClient`, reused across warm serverless invocations) and `logChat(entry)`, called from `chat.js` after each reply. Behavior:
  - if the caller sends a `conversationId`, the whole conversation **upserts into a single document** — each turn overwrites it with the latest full transcript, so a session never produces more than one record
  - without a `conversationId`, falls back to a plain insert (one doc per request)
  - stores `{ conversationId, timestamp, ip, userAgent, messages, showContactForm, needsSummary, hasCaseStudies }` in the `ai-search` database's `chatLogs` collection
  - a TTL index on `timestamp` auto-expires documents 90 days after their last update
  - `ip` is read from the `x-forwarded-for` header (falls back to `req.socket.remoteAddress`); this is personal data under GDPR/CCPA — confirm the site's privacy policy covers it before relying on this in production

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
MONGODB_URI=mongodb+srv://...
```

This project is already linked to a Vercel project (`ai-search-api`). To pull the latest env vars from Vercel instead of setting them by hand:

```bash
vercel env pull .env.local
```

### MongoDB setup (dev vs. production)

`MONGODB_URI` is scoped **per Vercel environment**, pointing at two separate free-tier (M0) Atlas clusters in two separate Atlas projects (kept separate so dev traffic doesn't eat into prod's 512MB free-tier storage cap):

| Vercel environment | Git branch | Atlas project |
|---|---|---|
| Production | `main` | `ai-search-prod` |
| Preview | `develop` | `ai-search-dev` |
| Development (local) | — | `ai-search-dev` |

Provisioned via direct Atlas signup (atlas.mongodb.com), not the Vercel Marketplace integration — Marketplace requires a payment method on file account-wide even though the M0 tier itself is free. Each Atlas project needs Network Access set to `0.0.0.0/0` (Vercel Functions have no fixed egress IP) and a database user; the real security boundary is that user's password, not the network ACL.

Set the per-environment values with:

```bash
vercel env add MONGODB_URI production   # paste the ai-search-prod connection string
vercel env add MONGODB_URI preview      # paste the ai-search-dev connection string
vercel env add MONGODB_URI development  # paste the ai-search-dev connection string
```

Set up Atlas Alerts (each project → Alerts) for storage-used % and connection count to catch approaching the free-tier cap early.

## Run locally

```bash
vercel dev
```

Runs the `/api` functions locally (default `http://localhost:3000`). Test with:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"need": "We need help launching a new nonprofit brand.", "conversationId": "test-1"}'
```

On subsequent turns, pass the returned `messages` array back as the request body's `messages` field, and the same `conversationId`, to continue the conversation as a single logged record. `conversationId` is optional — the frontend (`eg-website-ui`'s `useChat` hook) generates one per conversation with `crypto.randomUUID()`; omitting it just falls back to logging each request as a separate document.

## Deploy

```bash
vercel        # preview deployment
vercel --prod # production deployment
```

Make sure `ANTHROPIC_API_KEY` and `MONGODB_URI` are set for the relevant environment in the Vercel dashboard (or via `vercel env add`) before deploying.
