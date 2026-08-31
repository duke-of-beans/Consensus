# Consensus — CLAUDE_INSTRUCTIONS.md

## Pre-Flight Checklist
- **Production URL:** https://consensus-production-6eeb.up.railway.app
- **Package Manager:** npm (lockfile: package-lock.json)
- **Deploy Flow:** git push to main → Railway auto-deploys
- **Repo URL:** https://github.com/duke-of-beans/Consensus
- **Railway Project ID:** 33efa217-eb81-4ab5-a6ba-0553694c3ae3
- **Railway Service ID:** eacec1d6-23cd-4418-ac36-edcc31cd5463

## What Is Consensus

Multi-model AI orchestration + claim verification engine. The intelligence layer
between ASURIQ (frontend) and PLEXUS (evidence).

## Architecture

- **Service:** Node.js + Express on Railway (always-on)
- **Port:** 3300 (configurable via PORT env var)
- **TypeScript:** strict mode, ESM, compiled with tsc

## API Endpoints

- `GET /healthz` — Liveness probe
- `GET /health` — Service health + dependency status (PLEXUS, Anthropic)
- `POST /api/v1/verify` — Claim verification pipeline (requires Bearer token)

## Verification Pipeline

4-stage branded pipeline with compile-time stage ordering:

1. **Extract** — LLM-based claim extraction from AI response
2. **Classify** — Domain classification for PLEXUS routing
3. **Gather** — Parallel PLEXUS federated queries per claim
4. **Synthesize** — Evidence assessment → per-claim verdicts

Branded TypeScript types prevent skipping stages.

## Environment Variables

- `PORT` — Service port (default: 3300)
- `NODE_ENV` — Environment (production/development)
- `CONSENSUS_API_KEY` — API key for authenticating callers
- `ANTHROPIC_API_KEY` — For LLM calls (extraction, classification, synthesis)
- `PLEXUS_URL` — PLEXUS base URL (e.g. https://plexus-production-0b42.up.railway.app)
- `PLEXUS_API_KEY` — PLEXUS product API key (ring 3)
- `CONSENSUS_EXTRACTION_MODEL` — Override extraction model (default: claude-sonnet-4-6)
- `CONSENSUS_CLASSIFICATION_MODEL` — Override classification model (default: claude-sonnet-4-6)
- `CONSENSUS_SYNTHESIS_MODEL` — Override synthesis model (default: claude-sonnet-4-6)

## Dependencies

- PLEXUS (evidence layer) — must be reachable
- Anthropic API — for LLM calls in stages 1, 2, 4

## Rules

- npm only. No Vercel CLI. Railway deploy via git push.
- strict TypeScript. tsc --noEmit before every commit.
- No mocks, stubs, or placeholder implementations.
- 'unverifiable' is NOT 'false' — it means no evidence was found.
- Claim verification is never medical advice.
