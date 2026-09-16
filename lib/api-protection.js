// ============================================================
// BlueVera API Protection
// File: /lib/api-protection.js
//
// Purpose:
// - Restrict browser requests to BlueVera domains
// - Reject obvious bots/scrapers
// - Basic per-IP rate limiting
// - Add anti-indexing/security headers
//
// IMPORTANT:
// This is an additional layer, not a replacement for authentication
// on private/admin APIs.
// ============================================================

const ALLOWED_ORIGINS = new Set([
  "https://bluevera.org",
  "https://www.bluevera.org",
  "https://bluevera.app",
  "https://www.bluevera.app",

  // Local development
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
]);


// ------------------------------------------------------------
// BASIC RATE LIMITING
//
// NOTE:
// Vercel serverless instances can restart, so this is NOT a
// perfect global rate limiter. It still provides a useful
// first layer against rapid repeated requests.
// ------------------------------------------------------------

const rateStore = globalThis.__BLUEVERA_RATE_STORE__ || new Map();

globalThis.__BLUEVERA_RATE_STORE__ = rateStore;

const WINDOW_MS = 60 * 1000;

// Anonymous/public API requests allowed per IP per minute.
const MAX_REQUESTS_PER_WINDOW = 60;


// ------------------------------------------------------------
// KNOWN / OBVIOUS BOT USER AGENTS
// ------------------------------------------------------------

const BLOCKED_BOTS = [
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "claudebot",
  "claude-web",
  "anthropic-ai",
  "perplexitybot",
  "ccbot",
  "bytespider",
  "meta-externalagent",
  "facebookbot",
  "google-extended",
  "applebot-extended",
  "amazonbot",
  "cohere-ai",
  "youbot",
  "diffbot"
];


// ------------------------------------------------------------
// GET CLIENT IP
// ------------------------------------------------------------

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded)
      .split(",")[0]
      .trim();
  }

  return (
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}


// ------------------------------------------------------------
// SECURITY HEADERS
// ------------------------------------------------------------

function setSecurityHeaders(res) {
  res.setHeader(
    "X-Robots-Tag",
    "noindex, nofollow, noarchive, nosnippet"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, private"
  );
}


// ------------------------------------------------------------
// ORIGIN CHECK
// ------------------------------------------------------------

function validateOrigin(req, res) {
  const origin = req.headers.origin;

  // Server-to-server requests often do not contain Origin.
  // Do not automatically reject those here because BlueVera
  // may have legitimate internal/server-side API calls.
  if (!origin) {
    return true;
  }

  if (!ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({
      ok: false,
      error: "Origin not allowed."
    });

    return false;
  }

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin
  );

  res.setHeader(
    "Vary",
    "Origin"
  );

  return true;
}


// ------------------------------------------------------------
// BOT CHECK
// ------------------------------------------------------------

function blockKnownBots(req, res) {
  const userAgent = String(
    req.headers["user-agent"] || ""
  ).toLowerCase();

  for (const bot of BLOCKED_BOTS) {
    if (userAgent.includes(bot)) {
      res.status(403).json({
        ok: false,
        error: "Automated access denied."
      });

      return false;
    }
  }

  return true;
}


// ------------------------------------------------------------
// RATE LIMIT
// ------------------------------------------------------------

function checkRateLimit(req, res) {
  const ip = getClientIp(req);

  const now = Date.now();

  let record = rateStore.get(ip);

  if (
    !record ||
    now - record.startedAt > WINDOW_MS
  ) {
    record = {
      startedAt: now,
      count: 0
    };
  }

  record.count += 1;

  rateStore.set(ip, record);

  const remaining = Math.max(
    MAX_REQUESTS_PER_WINDOW - record.count,
    0
  );

  res.setHeader(
    "X-RateLimit-Limit",
    String(MAX_REQUESTS_PER_WINDOW)
  );

  res.setHeader(
    "X-RateLimit-Remaining",
    String(remaining)
  );

  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    res.setHeader(
      "Retry-After",
      "60"
    );

    res.status(429).json({
      ok: false,
      error: "Too many requests. Please try again shortly."
    });

    return false;
  }

  return true;
}


// ------------------------------------------------------------
// OPTIONS / CORS PREFLIGHT
// ------------------------------------------------------------

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }

  const origin = req.headers.origin;

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Max-Age",
    "86400"
  );

  res.status(204).end();

  return true;
}


// ------------------------------------------------------------
// MAIN BLUEVERA PROTECTION FUNCTION
// ------------------------------------------------------------

export function protectBlueVeraApi(req, res) {

  setSecurityHeaders(res);

  if (handleOptions(req, res)) {
    return false;
  }

  if (!validateOrigin(req, res)) {
    return false;
  }

  if (!blockKnownBots(req, res)) {
    return false;
  }

  if (!checkRateLimit(req, res)) {
    return false;
  }

  return true;
}
