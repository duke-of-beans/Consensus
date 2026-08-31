/**
 * Consensus — Verification Pipeline Types
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Branded types enforce pipeline stage ordering at compile time.
 * You cannot skip stages — the type system prevents it.
 *
 *   extractClaims → classifyClaims → gatherEvidence → synthesizeEvidence
 */

// ─── Branding Infrastructure ─────────────────────────────────────

declare const __brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [__brand]: B };

// ─── Domain Taxonomy (mirrors PLEXUS AdapterDomain) ──────────────

export type AdapterDomain =
  | 'science'
  | 'health'
  | 'legal'
  | 'financial'
  | 'government'
  | 'cybersecurity'
  | 'environmental'
  | 'geographic'
  | 'corporate'
  | 'scholarly'
  | 'knowledge'
  | 'biodiversity'
  | 'chemistry'
  | 'astronomy'
  | 'history'
  | 'art'
  | 'music'
  | 'weather'
  | 'demographics'
  | 'humanitarian'
  | 'technology'
  | 'packages'
  | 'general';

// ─── Verification Tiers ──────────────────────────────────────────

export type VerificationTier = 'quick' | 'standard' | 'deep';

/** Tier-specific configuration */
export const TIER_CONFIG: Record<VerificationTier, {
  maxAdaptersPerClaim: number;
  includeSecondaryDomains: boolean;
  targetLatencyMs: number;
  concurrentClaims: number;
}> = {
  quick:    { maxAdaptersPerClaim: 3,  includeSecondaryDomains: false, targetLatencyMs: 3_000,  concurrentClaims: 3 },
  standard: { maxAdaptersPerClaim: 10, includeSecondaryDomains: false, targetLatencyMs: 10_000, concurrentClaims: 5 },
  deep:     { maxAdaptersPerClaim: 25, includeSecondaryDomains: true,  targetLatencyMs: 30_000, concurrentClaims: 5 },
};

// ─── Stage 1: Claim Extraction ───────────────────────────────────

export interface RawClaim {
  text: string;
  /** Position in the original response (for highlighting) */
  startOffset: number;
  endOffset: number;
}

export type ExtractedClaims = Branded<{
  originalText: string;
  claims: RawClaim[];
  extractionModel: string;
  extractionCost: number;
}, 'extracted'>;

// ─── Stage 2: Domain Classification ──────────────────────────────

export interface ClassifiedClaim extends RawClaim {
  /** Primary domain for PLEXUS routing */
  primaryDomain: AdapterDomain;
  /** Secondary domains for cross-domain verification (deep tier) */
  secondaryDomains: AdapterDomain[];
  /** Is this claim time-sensitive? (affects cache policy) */
  timeSensitive: boolean;
  /** Estimated verifiability: high / medium / low / opinion */
  verifiability: 'high' | 'medium' | 'low' | 'opinion';
}

export type ClassifiedClaims = Branded<{
  claims: ClassifiedClaim[];
  originalText: string;
}, 'classified'>;

// ─── Stage 3: Evidence Gathering ─────────────────────────────────

export interface AdapterEvidence {
  adapterId: string;
  domain: string;
  sourceName: string;
  data: unknown;
  cached: boolean;
  cost: number;
  latencyMs: number;
}

export interface AdapterFailure {
  adapterId: string;
  reason: 'timeout' | 'circuit_open' | 'rate_limited' | 'error';
  message?: string;
}

export interface ClaimEvidence {
  claim: ClassifiedClaim;
  /** Evidence from PLEXUS adapters */
  sources: AdapterEvidence[];
  /** Adapters that failed for this claim */
  failures: AdapterFailure[];
  /** Total sources queried */
  sourcesQueried: number;
}

export type GatheredEvidence = Branded<{
  claims: ClaimEvidence[];
  totalCost: number;
  totalLatencyMs: number;
}, 'gathered'>;

// ─── Stage 4: Evidence Synthesis ─────────────────────────────────

export interface SourceCitation {
  sourceName: string;
  adapterId: string;
  /** Direct link to the evidence (if available) */
  url?: string;
  /** Relevant excerpt or data point */
  excerpt: string;
}

export interface ClaimVerdict {
  claim: ClassifiedClaim;
  /** Confidence that the claim is accurate (0-1) */
  confidence: number;
  /** Verdict category */
  verdict: 'verified' | 'contradicted' | 'unsupported' | 'unverifiable';
  /** Human-readable evidence summary */
  summary: string;
  /** Supporting sources with links */
  supportingSources: SourceCitation[];
  /** Contradicting sources with links */
  contradictingSources: SourceCitation[];
}

export type SynthesizedVerdict = Branded<{
  claims: ClaimVerdict[];
  /** Overall response confidence (weighted average of claim confidences) */
  overallConfidence: number;
  /** Overall verdict */
  overallVerdict: 'verified' | 'mixed' | 'contradicted' | 'insufficient_evidence';
  /** Total sources consulted across all claims */
  totalSourcesConsulted: number;
  /** Unique adapter IDs that contributed evidence */
  uniqueSources: string[];
  /** Total cost of the verification */
  totalCost: number;
}, 'synthesized'>;

// ─── PLEXUS Client Types ─────────────────────────────────────────

export interface PlexusFederatedQueryRequest {
  query: string;
  domains: AdapterDomain[];
  maxAdapters?: number;
  timeoutMs?: number;
  freshness?: string;
  caller: string;
  callerRing: number;
}

export interface PlexusFederatedQueryResponse {
  results: AdapterEvidence[];
  failures: AdapterFailure[];
  adaptersMatched: number;
  adaptersQueried: number;
  totalCost: number;
  latencyMs: number;
  timestamp: string;
}

// ─── Verify Endpoint Types ───────────────────────────────────────

export interface VerifyRequest {
  /** The AI-generated response text to verify */
  response: string;
  /** Verification depth */
  tier: VerificationTier;
  /** Optional: the original question (helps claim extraction) */
  question?: string;
}

export interface VerifyResponse {
  verdict: SynthesizedVerdict;
  meta: {
    tier: VerificationTier;
    claimsExtracted: number;
    claimsVerified: number;
    claimsOpinion: number;
    totalLatencyMs: number;
    totalCost: number;
    timestamp: string;
  };
}
