/**
 * Consensus — Service Entry Point
 * Multi-model AI orchestration + claim verification engine.
 *
 * Endpoints:
 *   GET  /health         — service health + PLEXUS connectivity
 *   GET  /healthz        — liveness probe
 *   POST /api/v1/verify  — claim verification pipeline
 */

import express from 'express';
import { z } from 'zod';
import { handleVerify, createPlexusClient } from './verification/index.js';
import type { VerificationTier } from './verification/index.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Security Headers ──
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  next();
});

// ── CORS ──
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://asuriq.dev',
    'https://www.asuriq.dev',
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ── Response Timing ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!res.headersSent) return;
    console.log(JSON.stringify({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      timestamp: new Date().toISOString(),
    }));
  });
  next();
});

// ─── Authentication ──────────────────────────────────────────────

function requireAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  const authHeader = req.headers.authorization;
  const apiKey = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-api-key'] as string | undefined)?.trim();

  if (!apiKey) {
    next(new AppError(401, 'AUTH_REQUIRED', 'No credential presented'));
    return;
  }

  const validKey = process.env.CONSENSUS_API_KEY;
  if (!validKey || apiKey !== validKey) {
    next(new AppError(401, 'AUTH_INVALID', 'Invalid API key'));
    return;
  }

  next();
}

// ─── Health Endpoints ────────────────────────────────────────────

const startedAt = new Date().toISOString();

app.get('/healthz', (_req, res) => {
  res.send('ok');
});

app.get('/health', async (_req, res) => {
  let plexusHealthy = false;
  try {
    const plexus = createPlexusClient();
    plexusHealthy = await plexus.healthCheck();
  } catch {
    plexusHealthy = false;
  }

  const anthropicConfigured = !!process.env.ANTHROPIC_API_KEY;

  res.json({
    status: plexusHealthy && anthropicConfigured ? 'healthy' : 'degraded',
    startedAt,
    uptimeSeconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    dependencies: {
      plexus: plexusHealthy ? 'healthy' : 'unreachable',
      anthropic: anthropicConfigured ? 'configured' : 'missing_key',
    },
  });
});

// ─── Verify Endpoint ─────────────────────────────────────────────

const VerifyBodySchema = z.object({
  response: z.string().min(1, 'Response text is required').max(50_000),
  tier: z.enum(['quick', 'standard', 'deep']).default('standard'),
  question: z.string().max(2_000).optional(),
});

app.post('/api/v1/verify', requireAuth, async (req, res, next) => {
  try {
    const body = VerifyBodySchema.parse(req.body);

    const plexusClient = createPlexusClient();

    const result = await handleVerify(
      {
        response: body.response,
        tier: body.tier as VerificationTier,
        question: body.question,
      },
      plexusClient,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Error Types ─────────────────────────────────────────────────

class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ─── Error Handler ───────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: err.code,
        message: err.message,
      });
      return;
    }

    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: err.issues,
      });
      return;
    }

    console.error(JSON.stringify({
      error: 'UNHANDLED_ERROR',
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    }));

    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  },
);

// ─── Start ───────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3300', 10);

app.listen(port, () => {
  console.log(JSON.stringify({
    event: 'consensus_started',
    port,
    env: process.env.NODE_ENV ?? 'development',
    plexusUrl: process.env.PLEXUS_URL ?? 'NOT_SET',
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString(),
  }));
});

export { app };
