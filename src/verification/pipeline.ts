/**
 * Consensus — Verification Pipeline
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Complete verification pipeline. The branded types make it
 * impossible to skip stages:
 *
 *   extractAndClassify → gatherEvidence → synthesizeEvidence
 *
 * Stages 1+2 merged into single LLM call for latency reduction.
 * Per-stage timing exposed in response metadata.
 */

import type { VerificationTier, SynthesizedVerdict, VerifyRequest, VerifyResponse } from './types.js';
import { extractAndClassify } from './extract-classify.js';
import { gatherEvidence } from './gather.js';
import { synthesizeEvidence } from './synthesize.js';
import type { PlexusClient } from './plexus-client.js';

/**
 * Complete verification pipeline.
 * The branded types enforce stage ordering at compile time.
 */
export async function verifyResponse(
  aiResponse: string,
  tier: VerificationTier,
  plexusClient: PlexusClient,
  question?: string,
): Promise<SynthesizedVerdict> {
  const { classified } = await extractAndClassify(aiResponse, question);
  const evidence = await gatherEvidence(classified, tier, plexusClient);
  return synthesizeEvidence(evidence);
}

/**
 * Full verify endpoint handler — takes a VerifyRequest,
 * runs the pipeline, returns a VerifyResponse with metadata
 * including per-stage timing.
 */
export async function handleVerify(
  request: VerifyRequest,
  plexusClient: PlexusClient,
): Promise<VerifyResponse> {
  const startTime = Date.now();

  // Stage 1+2: Extract and classify claims (single LLM call)
  const extractStart = Date.now();
  const { classified, model: extractModel, cost: extractCost } = await extractAndClassify(
    request.response,
    request.question,
  );
  const extractClassifyMs = Date.now() - extractStart;

  // Stage 3: Gather evidence from PLEXUS
  const gatherStart = Date.now();
  const evidence = await gatherEvidence(classified, request.tier, plexusClient);
  const gatherMs = Date.now() - gatherStart;

  // Stage 4: Synthesize verdicts (parallel per-claim)
  const synthesizeStart = Date.now();
  const verdict = await synthesizeEvidence(evidence);
  const synthesizeMs = Date.now() - synthesizeStart;

  const opinionCount = verdict.claims.filter(
    c => c.claim.verifiability === 'opinion',
  ).length;

  return {
    verdict,
    meta: {
      tier: request.tier,
      claimsExtracted: verdict.claims.length,
      claimsVerified: verdict.claims.length - opinionCount,
      claimsOpinion: opinionCount,
      totalLatencyMs: Date.now() - startTime,
      extractClassifyMs,
      gatherMs,
      synthesizeMs,
      extractModel,
      totalCost: verdict.totalCost + extractCost,
      timestamp: new Date().toISOString(),
    },
  };
}
