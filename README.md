# Conference Companion

Paste any conference schedule (or its URL) and get a personal agenda:
pick sessions, take notes, export to your calendar. Built to be free to run.

## Structure
- index.html — the whole app (front end)
- functions/api/parse.js — Cloudflare Pages Function: fetches schedule URLs
  and parses them with Cloudflare Workers AI (free tier, no API key)

## One-time setup after uploading to GitHub
In the Cloudflare dashboard: your Pages project -> Settings -> Bindings ->
Add -> Workers AI -> variable name: AI -> Save. Then Deployments -> Retry
deployment (or push any change) so the binding takes effect.
