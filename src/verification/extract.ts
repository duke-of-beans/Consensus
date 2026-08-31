/**
 * Consensus — Stage 1: Claim Extraction
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Extracts verifiable claims from an AI response using structured
 * LLM output. Only extractClaims() can produce ExtractedClaims.
 *
 * INVARIANT: Only extractClaims() can produce ExtractedClaims.
 */

import type { RawClaim, ExtractedClaims } from './types.js';

// ─── Extraction Prompt ───────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a claim extraction engine. Given an AI-generated response, extract every verifiable factual claim.

Rules:
- Extract ONLY factual claims that can be verified against external data
- Do NOT extract opinions, subjective statements, hedged speculation, or meta-commentary
- Each claim should be a single, self-contained factual assertion
- Include the exact start and end character offsets in the original text
- Claims about quantities, dates, names, events, scientific facts, statistics, and attributions are verifiable
- "I think", "probably", "it seems" — these are NOT verifiable claims
- Tautologies and definitions are NOT verifiable claims

Respond with ONLY a JSON array. No markdown, no explanation, no preamble.

JSON schema:
[
  {
    "text": "the extracted claim as a standalone sentence",
    "startOffset": 0,
    "endOffset": 50
  }
]

If there are no verifiable claims, return an empty array: []`;

// ─── LLM Call ────────────────────────────────────────────────────

interface LLMResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Call an LLM for claim extraction. Uses the Anthropic API
 * with structured JSON output.
 */
async function callLLM(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; model: string; cost: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const model = process.env.CONSENSUS_EXTRACTION_MODEL ?? 'claude-sonnet-4-6';

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
    throw new Error(`LLM call failed (${response.status}): ${body}`);
  }

  const data: LLMResponse = await response.json() as LLMResponse;
  const text = data.content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('');

  // Rough cost estimate: Sonnet 4.6 pricing
  const inputCost = (data.usage.input_tokens / 1_000_000) * 3;
  const outputCost = (data.usage.output_tokens / 1_000_000) * 15;

  return { text, model: data.model, cost: inputCost + outputCost };
}

// ─── Extraction ──────────────────────────────────────────────────

/**
 * Extract verifiable claims from an AI response.
 *
 * INVARIANT: Only this function can produce ExtractedClaims.
 * The branded type prevents any other code from creating this type.
 */
export async function extractClaims(
  response: string,
  question?: string,
): Promise<ExtractedClaims> {
  const userPrompt = question
    ? `Original question: ${question}\n\nAI response to extract claims from:\n\n${response}`
    : `AI response to extract claims from:\n\n${response}`;

  const { text: rawOutput, model, cost } = await callLLM(
    EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
  );

  // Parse the JSON output — strip markdown fences if present
  const cleaned = rawOutput
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed: RawClaim[];
  try {
    parsed = JSON.parse(cleaned) as RawClaim[];
  } catch {
    // If parsing fails, return empty claims rather than crashing
    parsed = [];
  }

  // Validate offsets are within bounds and claims are non-empty
  const validated = parsed.filter(claim =>
    claim.text.trim().length > 0 &&
    typeof claim.startOffset === 'number' &&
    typeof claim.endOffset === 'number' &&
    claim.startOffset >= 0 &&
    claim.endOffset <= response.length &&
    claim.startOffset < claim.endOffset,
  );

  // The cast to ExtractedClaims is intentional — this is the ONLY
  // place this brand can be applied. The branded type system
  // prevents any other code path from producing ExtractedClaims.
  return {
    originalText: response,
    claims: validated,
    extractionModel: model,
    extractionCost: cost,
  } as ExtractedClaims;
}
