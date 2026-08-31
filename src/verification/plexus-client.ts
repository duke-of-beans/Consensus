/**
 * Consensus — PLEXUS Client
 * Source of truth: ASURIQ × PLEXUS Blueprint §3
 *
 * Typed HTTP client for PLEXUS's POST /v1/federated-query endpoint.
 * Handles authentication, timeout, and error mapping.
 */

import type {
  AdapterDomain,
  PlexusFederatedQueryRequest,
  PlexusFederatedQueryResponse,
} from './types.js';
import pRetry, { AbortError } from 'p-retry';

// ─── Client Configuration ────────────────────────────────────────

export interface PlexusClientConfig {
  /** PLEXUS base URL (e.g. https://plexus-production-0b42.up.railway.app) */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Caller identity for cost attribution */
  caller: string;
  /** Caller ring level */
  callerRing: number;
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
}

// ─── Client Class ────────────────────────────────────────────────

export class PlexusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly caller: string;
  private readonly callerRing: number;
  private readonly timeoutMs: number;

  constructor(config: PlexusClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.caller = config.caller;
    this.callerRing = config.callerRing;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Query PLEXUS with domain-scoped fan-out.
   * Returns aggregated evidence from all healthy adapters
   * matching the specified domains.
   */
  async federatedQuery(
    query: string,
    domains: AdapterDomain[],
    options?: {
      maxAdapters?: number;
      timeoutMs?: number;
      freshness?: string;
    },
  ): Promise<PlexusFederatedQueryResponse> {
    const body: PlexusFederatedQueryRequest = {
      query,
      domains,
      maxAdapters: options?.maxAdapters,
      timeoutMs: options?.timeoutMs,
      freshness: options?.freshness,
      caller: this.caller,
      callerRing: this.callerRing,
    };

    const result = await pRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.timeoutMs,
        );

        try {
          const response = await fetch(
            `${this.baseUrl}/v1/federated-query`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            },
          );

          if (!response.ok) {
            const errorBody = await response.text();
            const err = new Error(
              `PLEXUS federated-query failed (${response.status}): ${errorBody}`,
            );
            // Don't retry 4xx (client errors)
            if (response.status >= 400 && response.status < 500) {
              throw new AbortError(err.message);
            }
            throw err;
          }

          return await response.json() as PlexusFederatedQueryResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        retries: 2,
        minTimeout: 1_000,
        maxTimeout: 5_000,
        factor: 2,
        randomize: true,
      },
    );

    return result;
  }

  /**
   * Health check — verify PLEXUS is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a PlexusClient from environment variables.
 * Expects PLEXUS_URL and PLEXUS_API_KEY.
 */
export function createPlexusClient(): PlexusClient {
  const baseUrl = process.env.PLEXUS_URL;
  const apiKey = process.env.PLEXUS_API_KEY;

  if (!baseUrl) throw new Error('PLEXUS_URL not set');
  if (!apiKey) throw new Error('PLEXUS_API_KEY not set');

  return new PlexusClient({
    baseUrl,
    apiKey,
    caller: 'consensus',
    callerRing: 3, // Portfolio product ring
    timeoutMs: 15_000,
  });
}
