/**
 * Consensus — Stage 4: Evidence Synthesis
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Synthesizes evidence into per-claim verdicts and overall score.
 * Claim assessments run in PARALLEL (bounded concurrency) — not
 * the previous sequential for...of loop.
 *
 * INVARIANT: Requires GatheredEvidence — cannot synthesize without evidence.
 * INVARIANT: Cross-source agreement increases confidence.
 * INVARIANT: 'contradicted' requires at least 2 authoritative sources disagreeing.
 * INVARIANT: 'unverifiable' is NOT 'false' — it means no evidence found.
 */

import type {
  GatheredEvidence,
  SynthesizedVerdict,
  ClaimVerdict,
  SourceCitation,
  ClaimEvidence,
} from './types.js';
import { withConcurrency } from './types.js';

// ─── LLM-Based Evidence Assessment ──────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are an evidence synthesis engine. Given a factual claim and evidence from multiple data sources, determine whether the evidence supports, contradicts, or is insufficient to verify the claim.

Rules:
- Compare the claim against EACH piece of evidence
- Cross-source agreement increases your confidence
- 'contradicted' requires at least 2 sources presenting conflicting information
- 'unsupported' means the sources don't contain relevant information (NOT that the claim is false)
- 'unverifiable' means no evidence was gathered (distinct from unsupported — this is a coverage gap)
- Be conservative: if evidence partially supports but doesn't fully confirm, confidence should be moderate (0.4-0.6)

Respond with ONLY a JSON object. No markdown, no explanation.

JSON schema:
{
  "verdict": "verified" | "contradicted" | "unsupported" | "unverifiable",
  "confidence": 0.0 to 1.0,
  "summary": "one-sentence explanation of the verdict",
  "supportingExcerpts": ["relevant data point from source 1", ...],
  "contradictingExcerpts": ["conflicting data point from source 2", ...]
}`;

interface SynthesisResult {
  verdict: ClaimVerdict['verdict'];
  confidence: number;
  summary: string;
  supportingExcerpts: string[];
  contradictingExcerpts: string[];
}

async function assessClaimEvidence(
  claimText: string,
  evidence: ClaimEvidence,
): Promise<SynthesisResult> {
  // No evidence gathered — claim is unverifiable (NOT false)
  if (evidence.sources.length === 0) {
    return {
      verdict: 'unverifiable',
      confidence: 0,
      summary: 'No evidence sources were available to verify this claim.',
      supportingExcerpts: [],
      contradictingExcerpts: [],
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // Synthesis keeps Sonnet — reasoning quality matters here
  const model = process.env.CONSENSUS_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';

  // Build evidence summary for the LLM
  const evidenceSummary = evidence.sources
    .map((src, i) => {
      const dataStr = typeof src.data === 'string'
        ? src.data
        : JSON.stringify(src.data, null, 2);
      // Truncate large data to avoid context overflow
      const truncated = dataStr.length > 2000
        ? dataStr.slice(0, 2000) + '\n... [truncated]'
        : dataStr;
      return `Source ${i + 1} (${src.sourceName}, adapter: ${src.adapterId}):\n${truncated}`;
    })
    .join('\n\n');

  const userPrompt = `Claim to verify: "${claimText}"\n\nEvidence from ${evidence.sources.length} sources:\n\n${evidenceSummary}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYNTHESIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    // Synthesis LLM failure — mark as unverifiable rather than crashing
    return {
      verdict: 'unverifiable',
      confidence: 0,
      summary: 'Evidence synthesis failed — could not assess sources.',
      supportingExcerpts: [],
      contradictingExcerpts: [],
    };
  }

  interface SynthesisLLMResponse {
    content: Array<{ type: string; text?: string }>;
  }

  const data = await response.json() as SynthesisLLMResponse;
  const text = data.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('');

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    const result = JSON.parse(cleaned) as SynthesisResult;

    // Validate verdict enum
    const validVerdicts: ClaimVerdict['verdict'][] = [
      'verified', 'contradicted', 'unsupported', 'unverifiable',
    ];
    if (!validVerdicts.includes(result.verdict)) {
      result.verdict = 'unsupported';
    }

    // Clamp confidence
    result.confidence = Math.max(0, Math.min(1, result.confidence));

    // Enforce invariant: 'contradicted' requires evidence
    if (result.verdict === 'contradicted' && result.contradictingExcerpts.length < 1) {
      result.verdict = 'unsupported';
    }

    return result;
  } catch {
    return {
      verdict: 'unverifiable',
      confidence: 0,
      summary: 'Could not parse evidence assessment.',
      supportingExcerpts: [],
      contradictingExcerpts: [],
    };
  }
}

// ─── Citation Builder ────────────────────────────────────────────

function buildCitations(
  evidence: ClaimEvidence,
  excerpts: string[],
): SourceCitation[] {
  if (excerpts.length === 0) return [];

  // Map excerpts to source citations
  return excerpts.map((excerpt, i) => {
    const source = evidence.sources[i] ?? evidence.sources[0];
    return {
      sourceName: source?.sourceName ?? 'Unknown',
      adapterId: source?.adapterId ?? 'unknown',
      excerpt,
    };
  });
}

// ─── Synthesis ───────────────────────────────────────────────────

/**
 * Synthesize evidence into per-claim verdicts and overall score.
 * Claim assessments run in PARALLEL with bounded concurrency.
 *
 * INVARIANT: Requires GatheredEvidence — the branded type enforces this.
 * INVARIANT: 'unverifiable' is NOT 'false' — it means no evidence found.
 */
export async function synthesizeEvidence(
  evidence: GatheredEvidence,
): Promise<SynthesizedVerdict> {
  // Build assessment tasks — opinions get instant pass-through,
  // verifiable claims get parallel LLM assessment
  const tasks = evidence.claims.map(
    (claimEvidence) => async (): Promise<ClaimVerdict> => {
      // Opinion claims get a pass-through verdict (no LLM call)
      if (claimEvidence.claim.verifiability === 'opinion') {
        return {
          claim: claimEvidence.claim,
          confidence: 0,
          verdict: 'unverifiable',
          summary: 'Opinion or subjective statement — not subject to factual verification.',
          supportingSources: [],
          contradictingSources: [],
        };
      }

      const assessment = await assessClaimEvidence(
        claimEvidence.claim.text,
        claimEvidence,
      );

      return {
        claim: claimEvidence.claim,
        confidence: assessment.confidence,
        verdict: assessment.verdict,
        summary: assessment.summary,
        supportingSources: buildCitations(claimEvidence, assessment.supportingExcerpts),
        contradictingSources: buildCitations(claimEvidence, assessment.contradictingExcerpts),
      };
    },
  );

  // Parallel with bounded concurrency (5 concurrent LLM calls max)
  const verdicts = await withConcurrency(tasks, 5);

  // Calculate overall confidence (weighted by verifiability)
  const verifiableClaims = verdicts.filter(
    v => v.claim.verifiability !== 'opinion',
  );

  const overallConfidence = verifiableClaims.length > 0
    ? verifiableClaims.reduce((sum, v) => sum + v.confidence, 0) / verifiableClaims.length
    : 0;

  // Determine overall verdict
  const verifiedCount = verifiableClaims.filter(v => v.verdict === 'verified').length;
  const contradictedCount = verifiableClaims.filter(v => v.verdict === 'contradicted').length;
  const total = verifiableClaims.length;

  let overallVerdict: 'verified' | 'mixed' | 'contradicted' | 'insufficient_evidence';
  if (total === 0) {
    overallVerdict = 'insufficient_evidence';
  } else if (contradictedCount > 0 && verifiedCount > 0) {
    overallVerdict = 'mixed';
  } else if (contradictedCount > 0) {
    overallVerdict = 'contradicted';
  } else if (verifiedCount === total) {
    overallVerdict = 'verified';
  } else if (verifiedCount > 0) {
    overallVerdict = 'mixed';
  } else {
    overallVerdict = 'insufficient_evidence';
  }

  // Collect unique sources
  const uniqueSources = new Set<string>();
  for (const ce of evidence.claims) {
    for (const src of ce.sources) {
      uniqueSources.add(src.adapterId);
    }
  }

  const totalSourcesConsulted = evidence.claims.reduce(
    (sum, ce) => sum + ce.sourcesQueried,
    0,
  );

  return {
    claims: verdicts,
    overallConfidence,
    overallVerdict,
    totalSourcesConsulted,
    uniqueSources: Array.from(uniqueSources),
    totalCost: evidence.totalCost,
  } as SynthesizedVerdict;
}
