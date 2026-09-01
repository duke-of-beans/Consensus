/**
 * Consensus — Verification Module
 * Public API surface for the claim verification pipeline.
 */

// Active pipeline (merged extract+classify)
export { extractAndClassify } from './extract-classify.js';
export { gatherEvidence } from './gather.js';
export { synthesizeEvidence } from './synthesize.js';
export { verifyResponse, handleVerify } from './pipeline.js';
export { PlexusClient, createPlexusClient } from './plexus-client.js';

// Legacy individual stages (still importable, no longer used by pipeline)
export { extractClaims } from './extract.js';
export { classifyClaims } from './classify.js';

export type {
  // Pipeline types
  ExtractedClaims,
  ClassifiedClaims,
  GatheredEvidence,
  SynthesizedVerdict,
  // Component types
  RawClaim,
  ClassifiedClaim,
  ClaimEvidence,
  ClaimVerdict,
  SourceCitation,
  AdapterEvidence,
  AdapterFailure,
  // Request/response
  VerifyRequest,
  VerifyResponse,
  VerificationTier,
  AdapterDomain,
} from './types.js';

export { withConcurrency } from './types.js';
