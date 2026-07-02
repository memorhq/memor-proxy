// Edge function — forwards /v1/* to api.anthropic.com, injects the real key.
// Deploy env var: ANTHROPIC_API_KEY
export const config = { runtime: "edge" };

const ALLOWED_PATHS = /^\/v1\/(messages|complete)$/;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30;           // 30 req/min per IP

// In-memory rate limiter (resets on cold start — good enough for abuse prevention)
const counts = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = counts.get(ip);
  if (!entry || now > entry.resetAt) {
    counts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "access-control-allow-headers": "content-type, anthropic-version, x-api-key, accept",
        "access-control-max-age": "86400",
      },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Only proxy known Anthropic paths
  if (!ALLOWED_PATHS.test(path)) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // Rate limit by IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }), {
      status: 429,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Proxy not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = `https://api.anthropic.com${path}${url.search}`;

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
      "content-type": req.headers.get("content-type") ?? "application/json",
      "accept": req.headers.get("accept") ?? "application/json",
    },
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
