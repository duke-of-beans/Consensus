/**
 * Consensus — Stages 1+2: Combined Claim Extraction & Classification
 *
 * Merges extraction and classification into a single LLM call:
 * 1. ~50% latency reduction (one round-trip instead of two)
 * 2. Compound sentence splitting via few-shot examples
 * 3. Offset tolerance with fuzzy matching fallback
 *
 * Uses CONSENSUS_FAST_MODEL (default: claude-haiku-4-5-20251001)
 * — these are structured JSON tasks, not reasoning tasks.
 *
 * INVARIANT: Only extractAndClassify() produces ClassifiedClaims
 * in the merged pipeline. The branded type prevents bypass.
 */

import type {
  ClassifiedClaims,
  ClassifiedClaim,
  AdapterDomain,
} from './types.js';

// ─── Valid Domains (mirrors PLEXUS) ──────────────────────────────

const VALID_DOMAINS: AdapterDomain[] = [
  'science', 'health', 'legal', 'financial', 'government',
  'cybersecurity', 'environmental', 'geographic', 'corporate',
  'scholarly', 'knowledge', 'biodiversity', 'chemistry',
  'astronomy', 'history', 'art', 'music', 'weather',
  'demographics', 'humanitarian', 'technology', 'packages', 'general',
];

// ─── Combined Prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a claim extraction and classification engine. Given an AI-generated response, extract every verifiable factual claim and classify each one for evidence routing.

EXTRACTION RULES:
- Extract ONLY factual claims that can be verified against external data
- Each claim must be a single, self-contained factual assertion
- COMPOUND SENTENCES: Sentences joined by "and", "but", "while", "which", or commas often contain MULTIPLE independent claims. Split each verifiable fact into its own entry.
- Include start and end character offsets in the original text (approximate is acceptable — we recover exact positions)
- Verifiable: quantities, dates, names, events, scientific facts, statistics, attributions
- NOT verifiable: "I think", "probably", "it seems", tautologies, definitions, opinions

CLASSIFICATION RULES per claim:
- primaryDomain: single best domain to search for verification evidence
- secondaryDomains: 0-3 additional domains with relevant evidence
- timeSensitive: true if the fact changes frequently (prices, officeholders, current events)
- verifiability: "high" (specific true/false fact), "medium" (needs context), "low" (vague), "opinion" (subjective — do NOT extract these)
- searchEntity: the bare canonical entity name for structured lookups. Just the name — NOT qualified with the property being checked (e.g. "Eiffel Tower", NOT "Eiffel Tower height")

Valid domains: ${VALID_DOMAINS.join(', ')}

EXAMPLES:

Input: "The Eiffel Tower is 324 meters tall and was completed in 1889."
Output:
[
  {
    "text": "The Eiffel Tower is 324 meters tall",
    "startOffset": 0,
    "endOffset": 35,
    "primaryDomain": "knowledge",
    "secondaryDomains": ["history"],
    "timeSensitive": false,
    "verifiability": "high",
    "searchEntity": "Eiffel Tower"
  },
  {
    "text": "The Eiffel Tower was completed in 1889",
    "startOffset": 40,
    "endOffset": 62,
    "primaryDomain": "history",
    "secondaryDomains": ["knowledge"],
    "timeSensitive": false,
    "verifiability": "high",
    "searchEntity": "Eiffel Tower"
  }
]

Input: "Amazon reported $574 billion in revenue for 2023, making it the largest e-commerce company globally."
Output:
[
  {
    "text": "Amazon reported $574 billion in revenue for 2023",
    "startOffset": 0,
    "endOffset": 49,
    "primaryDomain": "financial",
    "secondaryDomains": ["corporate"],
    "timeSensitive": false,
    "verifiability": "high",
    "searchEntity": "Amazon"
  },
  {
    "text": "Amazon is the largest e-commerce company globally",
    "startOffset": 51,
    "endOffset": 100,
    "primaryDomain": "corporate",
    "secondaryDomains": ["financial"],
    "timeSensitive": true,
    "verifiability": "high",
    "searchEntity": "Amazon"
  }
]

Input: "I think the sunset was beautiful yesterday."
Output: []

Respond with ONLY a JSON array. No markdown, no explanation, no preamble.
If there are no verifiable claims, return: []`;

// ─── LLM Call ────────────────────────────────────────────────────

interface LLMResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; model: string; cost: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Fast model for structured extraction — not a reasoning task
  const model = process.env.CONSENSUS_FAST_MODEL ?? 'claude-haiku-4-5-20251001';

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
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Extract+Classify LLM call failed (${response.status}): ${body}`);
  }

  const data: LLMResponse = await response.json() as LLMResponse;
  const text = data.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('');

  // Haiku 4.5 pricing estimate
  const inputCost = (data.usage.input_tokens / 1_000_000) * 0.80;
  const outputCost = (data.usage.output_tokens / 1_000_000) * 4;

  return { text, model: data.model, cost: inputCost + outputCost };
}

// ─── Validation Helpers ──────────────────────────────────────────

function validateDomain(domain: string): AdapterDomain {
  const lower = domain.toLowerCase().trim();
  if ((VALID_DOMAINS as string[]).includes(lower)) return lower as AdapterDomain;
  return 'general';
}

function validateVerifiability(v: string): ClassifiedClaim['verifiability'] {
  const valid = ['high', 'medium', 'low', 'opinion'] as const;
  const lower = v.toLowerCase().trim();
  if ((valid as readonly string[]).includes(lower)) return lower as ClassifiedClaim['verifiability'];
  return 'medium';
}

/**
 * Recover valid character offsets via fuzzy matching.
 * LLMs produce approximate offsets, especially for compound
 * sentence splits where claim text is reformulated. Offsets
 * are for UI highlighting — a recovered offset is better than
 * a dropped claim.
 */
function recoverOffsets(
  claimText: string,
  originalText: string,
  llmStart: number,
  llmEnd: number,
): { startOffset: number; endOffset: number } {
  // 1. Exact substring match
  const exactIdx = originalText.indexOf(claimText);
  if (exactIdx >= 0) {
    return { startOffset: exactIdx, endOffset: exactIdx + claimText.length };
  }

  // 2. Match a significant prefix fragment
  const fragLen = Math.min(30, claimText.length);
  const fragment = claimText.slice(0, fragLen);
  if (fragLen > 5) {
    const fragIdx = originalText.indexOf(fragment);
    if (fragIdx >= 0) {
      return {
        startOffset: fragIdx,
        endOffset: Math.min(fragIdx + claimText.length, originalText.length),
      };
    }
  }

  // 3. LLM offsets if roughly within bounds (allow 50-char tolerance)
  if (llmStart >= 0 && llmEnd <= originalText.length + 50 && llmStart < llmEnd) {
    return {
      startOffset: Math.max(0, llmStart),
      endOffset: Math.min(llmEnd, originalText.length),
    };
  }

  // 4. Last resort: full-text span (claim is valid, offsets are not)
  return { startOffset: 0, endOffset: originalText.length };
}

// ─── Combined Extraction + Classification ────────────────────────

interface RawClassifiedClaim {
  text: string;
  startOffset?: number;
  endOffset?: number;
  primaryDomain?: string;
  secondaryDomains?: string[];
  timeSensitive?: boolean;
  verifiability?: string;
  searchEntity?: string;
}

/**
 * Extract and classify claims in a single LLM call.
 * Produces ClassifiedClaims directly — eliminating the intermediate
 * ExtractedClaims round-trip.
 *
 * INVARIANT: Only this function can produce ClassifiedClaims in the
 * merged pipeline. The branded type prevents bypass.
 */
export async function extractAndClassify(
  response: string,
  question?: string,
): Promise<{ classified: ClassifiedClaims; model: string; cost: number }> {
  const userPrompt = question
    ? `Original question: ${question}\n\nAI response to extract and classify claims from:\n\n${response}`
    : `AI response to extract and classify claims from:\n\n${response}`;

  const { text: rawOutput, model, cost } = await callLLM(SYSTEM_PROMPT, userPrompt);

  // Parse JSON — strip markdown fences if present
  const cleaned = rawOutput
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed: RawClassifiedClaim[];
  try {
    parsed = JSON.parse(cleaned) as RawClassifiedClaim[];
  } catch {
    parsed = [];
  }

  // Validate claims with offset tolerance
  const validated: ClassifiedClaim[] = parsed
    .filter(claim => claim.text && claim.text.trim().length > 0)
    .map(claim => {
      const offsets = recoverOffsets(
        claim.text,
        response,
        claim.startOffset ?? 0,
        claim.endOffset ?? response.length,
      );

      return {
        text: claim.text,
        startOffset: offsets.startOffset,
        endOffset: offsets.endOffset,
        primaryDomain: validateDomain(claim.primaryDomain ?? 'general'),
        secondaryDomains: (claim.secondaryDomains ?? [])
          .map(validateDomain)
          .filter((d): d is AdapterDomain => d !== 'general'),
        timeSensitive: claim.timeSensitive === true,
        verifiability: validateVerifiability(claim.verifiability ?? 'medium'),
        searchEntity: claim.searchEntity?.trim() || undefined,
      };
    });

  return {
    classified: {
      claims: validated,
      originalText: response,
    } as ClassifiedClaims,
    model,
    cost,
  };
}
