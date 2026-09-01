> ⚠️ **This repository is a portfolio showcase companion. Production code and deployments use `Consensus-private`.** Source files in this repo may be stale or divergent. Do not push code here.

# Consensus

A multi-model AI orchestration engine: compose any combination of LLMs into configurable reasoning topologies — tribunals, councils, fractal assemblies — with role assignment, veto authority, confidence scoring, dissent capture, hallucination detection, and per-model benchmarking.

## The problem

Asking a single model for an answer gives you one model's answer, including whatever blind spots or confident wrongness it happens to have that day. The common fix — ask several models and average — treats disagreement as noise to smooth over, when disagreement between models is often exactly the signal worth paying attention to.

## What it does

Consensus routes a question through a configurable topology of models, each potentially playing a different role (advocate, critic, verifier), captures where they agree and where they genuinely diverge rather than collapsing that into an average, and scores confidence based on the actual pattern of agreement and dissent — not just how many models said the same thing. Per-model benchmarking tracks which models are actually reliable on which kinds of questions over time, so routing improves with use.

## In production

Consensus is the engine underneath [ASURIQ](https://asuriq.dev), a live product that verifies AI-generated answers in real time.

## Part of a system

Consensus is one engine in a larger set of composable reasoning infrastructure. See [davidkirsch.me/builds](https://davidkirsch.me/builds) for the rest.
