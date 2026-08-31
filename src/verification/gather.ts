/**
 * Consensus — Stage 3: Evidence Gathering
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Queries PLEXUS for evidence on each classified claim.
 * Runs claim queries in parallel (bounded by tier concurrency).
 *
 * INVARIANT: Requires ClassifiedClaims — cannot gather without classification.
 * INVARIANT: Only verifiable claims (not 'opinion') are queried.
 * INVARIANT: Each claim queries PLEXUS with its primaryDomain.
 *            Deep tier also queries secondaryDomains.
 */

import type {
  ClassifiedClaims,
  GatheredEvidence,
  ClaimEvidence,
  VerificationTier,
  AdapterDomain,
} from './types.js';
import { TIER_CONFIG } from './types.js';
import type { PlexusClient } from './plexus-client.js';

// ─── Concurrency Limiter ─────────────────────────────────────────

/**
 * Run async tasks with bounded concurrency.
 * Like Promise.all but limits how many run simultaneously.
 */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = (async () => {
      results.push(await task());
    })();
    executing.add(p);
    const cleanup = () => { executing.delete(p); };
    p.then(cleanup, cleanup);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ─── Evidence Gathering ──────────────────────────────────────────

/**
 * Query PLEXUS for evidence on each classified claim.
 *
 * INVARIANT: Requires ClassifiedClaims — the branded type enforces this.
 * INVARIANT: Opinion claims are skipped (sourcesQueried = 0).
 * INVARIANT: Each claim queries its primaryDomain.
 *            Deep tier also queries secondaryDomains.
 */
export async function gatherEvidence(
  classified: ClassifiedClaims,
  tier: VerificationTier,
  plexusClient: PlexusClient,
): Promise<GatheredEvidence> {
  const startTime = Date.now();
  const config = TIER_CONFIG[tier];

  const gatherForClaim = async (claim: typeof classified.claims[number]): Promise<ClaimEvidence> => {
    // Opinion claims are NOT queried — hard invariant
    if (claim.verifiability === 'opinion') {
      return {
        claim,
        sources: [],
        failures: [],
        sourcesQueried: 0,
      };
    }

    // Build domain list based on tier
    const domains: AdapterDomain[] = [claim.primaryDomain];
    if (config.includeSecondaryDomains && claim.secondaryDomains.length > 0) {
      domains.push(...claim.secondaryDomains);
    }

    // Set freshness based on time sensitivity
    const freshness = claim.timeSensitive ? 'realtime' : undefined;

    try {
      const response = await plexusClient.federatedQuery(
        claim.text,
        domains,
        {
          maxAdapters: config.maxAdaptersPerClaim,
          timeoutMs: config.targetLatencyMs,
          freshness,
        },
      );

      return {
        claim,
        sources: response.results,
        failures: response.failures,
        sourcesQueried: response.adaptersQueried,
      };
    } catch (err) {
      // PLEXUS call failed entirely — capture as a single failure
      return {
        claim,
        sources: [],
        failures: [{
          adapterId: 'plexus',
          reason: 'error',
          message: err instanceof Error ? err.message : 'PLEXUS query failed',
        }],
        sourcesQueried: 0,
      };
    }
  };

  // Run claim queries in parallel with tier-specific concurrency
  const tasks = classified.claims.map(
    claim => () => gatherForClaim(claim),
  );

  const claimEvidence = await withConcurrency(tasks, config.concurrentClaims);

  const totalCost = claimEvidence.reduce(
    (sum, ce) => sum + ce.sources.reduce((s, src) => s + src.cost, 0),
    0,
  );

  return {
    claims: claimEvidence,
    totalCost,
    totalLatencyMs: Date.now() - startTime,
  } as GatheredEvidence;
}
