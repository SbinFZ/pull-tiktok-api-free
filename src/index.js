/**
 * Cloudflare Worker — TikTok playback-info proxy (tikwm.com)
 *
 * Public, no-login. Proxies a small allow-list of tikwm endpoints so the
 * browser never calls tikwm directly (avoids CORS, centralises caching and
 * rate-limit handling). Static frontend is served via the [assets] binding.
 *
 * Routes (all GET, JSON out):
 *   /api/video?url=<tiktok url>            single video + playback stats
 *   /api/user?unique_id=<handle>           profile + aggregate stats
 *   /api/posts?unique_id=<handle>&cursor=  one page of a user's videos
 */

const TIKWM = "https://www.tikwm.com/api";

// Per-route edge cache TTL (seconds). tikwm rate-limits per IP; all of our
// users share the Worker egress IP, so caching is the main defence.
const CACHE_TTL = {
  video: 300,
  user: 600,
  posts: 180,
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The app may be mounted under a subdirectory of another domain
    // (e.g. /apps/tiktok-info/). Match API routes by suffix so they resolve
    // regardless of any mount prefix the reverse proxy keeps or strips.
    const apiRoute = (url.pathname.match(/\/api\/(video|user|posts)\/?$/) || [])[1];

    if (!apiRoute) {
      // Not an API call — serve a static asset by basename (prefix-agnostic),
      // so /apps/tiktok-info/app.js and /app.js both resolve to the stored file.
      return serveAsset(url, request, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (request.method !== "GET") {
      return errorResponse("method_not_allowed", "Only GET is supported.", 405);
    }

    try {
      switch (apiRoute) {
        case "video":
          return await handleVideo(url, ctx);
        case "user":
          return await handleUser(url, ctx);
        case "posts":
          return await handlePosts(url, ctx);
        default:
          return errorResponse("not_found", "Unknown API route.", 404);
      }
    } catch (err) {
      return errorResponse("internal_error", String(err && err.message || err), 502);
    }
  },
};

/**
 * Serve a static asset by its basename, ignoring any mount prefix. A directory
 * request (trailing slash) maps to index.html.
 */
function serveAsset(url, request, env) {
  const last = url.pathname.split("/").pop();
  const assetPath = !last ? "/index.html" : "/" + last;
  const assetUrl = new URL(assetPath, url.origin);
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

/* ------------------------------- handlers ------------------------------- */

async function handleVideo(url, ctx) {
  const raw = (url.searchParams.get("url") || "").trim();
  if (!isLikelyTikTokUrl(raw)) {
    return errorResponse("bad_request", "A valid TikTok video URL is required.", 400);
  }
  const upstream = `${TIKWM}/?url=${encodeURIComponent(raw)}&hd=1`;
  return proxy(upstream, ctx, CACHE_TTL.video);
}

async function handleUser(url, ctx) {
  const handle = normaliseHandle(url.searchParams.get("unique_id"));
  if (!handle) {
    return errorResponse("bad_request", "A valid TikTok username is required.", 400);
  }
  const upstream = `${TIKWM}/user/info?unique_id=${encodeURIComponent(handle)}`;
  return proxy(upstream, ctx, CACHE_TTL.user);
}

async function handlePosts(url, ctx) {
  const handle = normaliseHandle(url.searchParams.get("unique_id"));
  if (!handle) {
    return errorResponse("bad_request", "A valid TikTok username is required.", 400);
  }
  const cursor = clampInt(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
  const count = clampInt(url.searchParams.get("count"), 30, 1, 35);
  const upstream =
    `${TIKWM}/user/posts?unique_id=${encodeURIComponent(handle)}` +
    `&count=${count}&cursor=${cursor}`;
  return proxy(upstream, ctx, CACHE_TTL.posts);
}

/* -------------------------------- proxy --------------------------------- */

/**
 * Fetch an upstream tikwm URL with edge caching, normalise the response, and
 * surface tikwm's own `code !== 0` errors as HTTP 502 with a readable message.
 */
async function proxy(upstreamUrl, ctx, ttl) {
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const res = await fetch(upstreamUrl, {
    headers: {
      // tikwm is friendlier with a browser-like UA.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "application/json",
    },
  });

  if (res.status === 429) {
    return errorResponse(
      "rate_limited",
      "Upstream (tikwm) is rate-limiting requests. Please wait a moment and retry.",
      429
    );
  }
  if (!res.ok) {
    return errorResponse("upstream_error", `tikwm returned HTTP ${res.status}.`, 502);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return errorResponse("upstream_error", "tikwm returned a non-JSON response.", 502);
  }

  if (payload.code !== 0) {
    return errorResponse(
      "upstream_error",
      payload.msg || "tikwm reported an error.",
      502,
      { code: payload.code }
    );
  }

  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "cache-control": `public, max-age=${ttl}`,
    },
  });

  // Store a cacheable clone at the edge (best-effort, non-blocking).
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------- helpers -------------------------------- */

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

function errorResponse(error, message, status, extra = {}) {
  return new Response(
    JSON.stringify({ ok: false, error, message, ...extra }),
    { status, headers: JSON_HEADERS }
  );
}

/** Strip a leading @ and extract a handle from a profile URL if one was pasted. */
function normaliseHandle(input) {
  if (!input) return null;
  let v = String(input).trim();
  const m = v.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (m) v = m[1];
  v = v.replace(/^@/, "").trim();
  // TikTok usernames: letters, digits, underscore, period; 1–24 chars.
  return /^[A-Za-z0-9._]{1,24}$/.test(v) ? v : null;
}

function isLikelyTikTokUrl(v) {
  if (!v) return false;
  try {
    const u = new URL(v);
    return /(^|\.)tiktok\.com$/i.test(u.hostname) || /(^|\.)douyin\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
