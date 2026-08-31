/**
 * Consensus — Verification Pipeline
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Complete verification pipeline. The branded types make it
 * impossible to skip stages:
 *
 *   extractClaims → classifyClaims → gatherEvidence → synthesizeEvidence
 *
 * You CANNOT call synthesizeEvidence with raw claims.
 * You CANNOT call gatherEvidence without classification.
 * The compiler enforces the pipeline.
 */

import type { VerificationTier, SynthesizedVerdict, VerifyRequest, VerifyResponse } from './types.js';
import { extractClaims } from './extract.js';
import { classifyClaims } from './classify.js';
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
  const extracted = await extractClaims(aiResponse, question);
  const classified = await classifyClaims(extracted);
  const evidence = await gatherEvidence(classified, tier, plexusClient);
  return synthesizeEvidence(evidence);
}

/**
 * Full verify endpoint handler — takes a VerifyRequest,
 * runs the pipeline, returns a VerifyResponse with metadata.
 */
export async function handleVerify(
  request: VerifyRequest,
  plexusClient: PlexusClient,
): Promise<VerifyResponse> {
  const startTime = Date.now();

  const verdict = await verifyResponse(
    request.response,
    request.tier,
    plexusClient,
    request.question,
  );

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
      totalCost: verdict.totalCost,
      timestamp: new Date().toISOString(),
    },
  };
}
