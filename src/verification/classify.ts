/**
 * Consensus — Stage 2: Domain Classification
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Classifies each extracted claim's domain for PLEXUS routing.
 * Uses LLM-based classification with structured JSON output.
 *
 * INVARIANT: Requires ExtractedClaims — cannot classify without extraction.
 * INVARIANT: Claims tagged 'opinion' are excluded from PLEXUS queries.
 */

import type {
  ExtractedClaims,
  ClassifiedClaims,
  ClassifiedClaim,
  AdapterDomain,
} from './types.js';

// ─── Classification Prompt ───────────────────────────────────────

const VALID_DOMAINS: AdapterDomain[] = [
  'science', 'health', 'legal', 'financial', 'government',
  'cybersecurity', 'environmental', 'geographic', 'corporate',
  'scholarly', 'knowledge', 'biodiversity', 'chemistry',
  'astronomy', 'history', 'art', 'music', 'weather',
  'demographics', 'humanitarian', 'technology', 'packages', 'general',
];

const CLASSIFICATION_SYSTEM_PROMPT = `You are a claim classification engine. Given a list of factual claims, classify each one for data source routing.

For each claim, determine:
1. primaryDomain — the single best domain to search for verification evidence
2. secondaryDomains — 0-3 additional domains that might have relevant evidence
3. timeSensitive — true if the claim is about something that changes frequently (prices, officeholders, current events)
4. verifiability — how verifiable this claim is:
   - "high": specific fact with clear true/false answer (dates, quantities, named events)
   - "medium": fact that requires interpretation or context
   - "low": vague claim difficult to verify
   - "opinion": subjective statement, value judgment, or personal preference — NOT verifiable

Valid domains: ${VALID_DOMAINS.join(', ')}

Respond with ONLY a JSON array matching the input order. No markdown, no explanation.

JSON schema per claim:
{
  "primaryDomain": "science",
  "secondaryDomains": ["health"],
  "timeSensitive": false,
  "verifiability": "high"
}`;

// ─── LLM Call ────────────────────────────────────────────────────

async function callClassificationLLM(
  claims: string[],
): Promise<Array<{
  primaryDomain: string;
  secondaryDomains: string[];
  timeSensitive: boolean;
  verifiability: string;
}>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const model = process.env.CONSENSUS_CLASSIFICATION_MODEL ?? 'claude-sonnet-4-6';

  const userPrompt = `Classify these ${claims.length} claims:\n\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Classification LLM call failed (${response.status}): ${body}`);
  }

  interface ClassificationLLMResponse {
    content: Array<{ type: string; text?: string }>;
  }

  const data = await response.json() as ClassificationLLMResponse;
  const text = data.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('');

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: classify everything as 'general' with medium verifiability
    return claims.map(() => ({
      primaryDomain: 'general',
      secondaryDomains: [],
      timeSensitive: false,
      verifiability: 'medium',
    }));
  }
}

// ─── Domain Validation ───────────────────────────────────────────

function validateDomain(domain: string): AdapterDomain {
  const lower = domain.toLowerCase().trim();
  if ((VALID_DOMAINS as string[]).includes(lower)) {
    return lower as AdapterDomain;
  }
  return 'general';
}

function validateVerifiability(v: string): ClassifiedClaim['verifiability'] {
  const valid = ['high', 'medium', 'low', 'opinion'] as const;
  const lower = v.toLowerCase().trim();
  if ((valid as readonly string[]).includes(lower)) {
    return lower as ClassifiedClaim['verifiability'];
  }
  return 'medium';
}

// ─── Classification ──────────────────────────────────────────────

/**
 * Classify each claim's domain for PLEXUS routing.
 *
 * INVARIANT: Requires ExtractedClaims — cannot classify without extraction.
 * The branded type enforces this at compile time.
 */
export async function classifyClaims(
  extracted: ExtractedClaims,
): Promise<ClassifiedClaims> {
  if (extracted.claims.length === 0) {
    return {
      claims: [],
      originalText: extracted.originalText,
    } as unknown as ClassifiedClaims;
  }

  const claimTexts = extracted.claims.map(c => c.text);
  const classifications = await callClassificationLLM(claimTexts);

  const classified: ClassifiedClaim[] = extracted.claims.map((claim, i) => {
    const classification = classifications[i] ?? {
      primaryDomain: 'general',
      secondaryDomains: [],
      timeSensitive: false,
      verifiability: 'medium',
    };

    return {
      text: claim.text,
      startOffset: claim.startOffset,
      endOffset: claim.endOffset,
      primaryDomain: validateDomain(classification.primaryDomain),
      secondaryDomains: (classification.secondaryDomains ?? [])
        .map(validateDomain)
        .filter((d): d is AdapterDomain => d !== 'general'),
      timeSensitive: classification.timeSensitive === true,
      verifiability: validateVerifiability(classification.verifiability),
    };
  });

  return {
    claims: classified,
    originalText: extracted.originalText,
  } as ClassifiedClaims;
}
