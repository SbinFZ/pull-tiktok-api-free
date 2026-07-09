/**
 * Cloudflare Worker — TikTok playback-info proxy (tikwm.com / Apify)
 *
 * Public, no-login. Proxies a small allow-list of tikwm endpoints so the
 * browser never calls upstream services directly (avoids CORS, centralises
 * caching and rate-limit handling). Static frontend is served via the [assets]
 * binding.
 *
 * Routes (all GET, JSON out):
 *   /api/video?url=<tiktok url>            single video + playback stats
 *   /api/user?unique_id=<handle>           profile + aggregate stats
 *   /api/posts?unique_id=<handle>&cursor=  one page of a user's videos
 */

const TIKWM = "https://www.tikwm.com/api";
const APIFY_ACTOR_URL =
  "https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items";
const UPSTREAM_TIMEOUT_MS = 25000;
const APIFY_TIMEOUT_MS = 120000;
const APIFY_SYNC_TIMEOUT_SECS = 120;

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
          return await handlePosts(url, env, ctx);
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

async function handlePosts(url, env, ctx) {
  const handle = normaliseHandle(url.searchParams.get("unique_id"));
  if (!handle) {
    return errorResponse("bad_request", "A valid TikTok username is required.", 400);
  }
  const cursor = clampInt(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
  const count = clampInt(url.searchParams.get("count"), 30, 1, 100);

  if (shouldUseApify(env)) {
    if (cursor > 0) {
      return jsonResponse(apifyPostsPayload(handle, [], count));
    }
    return proxyApifyPosts(handle, count, env, ctx);
  }

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;

  try {
    res = await fetch(upstreamUrl, {
      headers: {
        // tikwm is friendlier with a browser-like UA.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      return errorResponse("upstream_timeout", "tikwm request timed out. Please retry later.", 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

async function proxyApifyPosts(handle, count, env, ctx) {
  const token = (env.APIFY_TOKEN || "").trim();
  if (!token) {
    return errorResponse(
      "apify_not_configured",
      "Apify token is not configured. Set the APIFY_TOKEN secret before using Apify.",
      500
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.local/apify/posts?unique_id=${encodeURIComponent(handle)}&count=${count}`,
    { method: "GET" }
  );
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const apifyResult = await fetchApifyProfilePosts(handle, count, token, env);
  if (!apifyResult.ok) return apifyResult.response;

  const response = jsonResponse(apifyPostsPayload(handle, apifyResult.items, count), {
    "cache-control": `public, max-age=${CACHE_TTL.posts}`,
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function fetchApifyProfilePosts(handle, count, token, env) {
  const endpoint = new URL(APIFY_ACTOR_URL);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("clean", "1");
  endpoint.searchParams.set("timeout", String(APIFY_SYNC_TIMEOUT_SECS));
  endpoint.searchParams.set("maxItems", String(count));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  let res;

  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(apifyProfileInput(handle, count, env)),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      return {
        ok: false,
        response: errorResponse("apify_timeout", "Apify request timed out. Please retry later.", 504),
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      response: errorResponse("apify_error", `Apify returned a non-JSON response (HTTP ${res.status}).`, 502),
    };
  }

  if (!res.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `Apify returned HTTP ${res.status}.`;
    return {
      ok: false,
      response: errorResponse("apify_error", message, res.status === 401 || res.status === 403 ? 401 : 502),
    };
  }

  if (!Array.isArray(payload)) {
    return {
      ok: false,
      response: errorResponse("apify_error", "Apify did not return dataset items. Please retry later.", 502),
    };
  }

  return { ok: true, items: payload };
}

function apifyProfileInput(handle, count, env) {
  return {
    profiles: [handle],
    resultsPerPage: count,
    profileScrapeSections: ["videos"],
    profileSorting: "latest",
    excludePinnedPosts: false,
    scrapeRelatedVideos: false,
    shouldDownloadAvatars: false,
    shouldDownloadCovers: false,
    shouldDownloadMusicCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadSubtitles: false,
    shouldDownloadVideos: false,
    commentsPerPost: 0,
    topLevelCommentsPerPost: 0,
    maxRepliesPerComment: 0,
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: 0,
    proxyCountryCode: env.APIFY_PROXY_COUNTRY_CODE || "None",
  };
}

function apifyPostsPayload(handle, items, count) {
  const videos = items
    .filter((item) => item && !item.connectedTo)
    .map((item) => normaliseApifyVideo(item, handle))
    .filter((video) => video.id)
    .slice(0, count);

  return {
    code: 0,
    msg: "success",
    source: "apify",
    data: {
      cursor: 0,
      hasMore: false,
      count,
      videos,
    },
  };
}

function normaliseApifyVideo(item, handle) {
  const author = item.authorMeta || {};
  const videoMeta = item.videoMeta || {};
  const id = String(item.id || extractTikTokVideoId(item.webVideoUrl) || "");
  const authorHandle = author.name || handle;

  return {
    id,
    video_id: id,
    title: item.text || "",
    cover: videoMeta.coverUrl || videoMeta.originalCoverUrl || "",
    origin_cover: videoMeta.coverUrl || videoMeta.originalCoverUrl || "",
    play_count: toNumber(item.playCount),
    digg_count: toNumber(item.diggCount),
    comment_count: toNumber(item.commentCount),
    share_count: toNumber(item.shareCount),
    collect_count: toNumber(item.collectCount),
    create_time: toNumber(item.createTime) || isoToUnixSeconds(item.createTimeISO),
    url: item.webVideoUrl || `https://www.tiktok.com/@${authorHandle}/video/${id}`,
    author: {
      unique_id: authorHandle,
      nickname: author.nickName || author.name || handle,
      avatar: author.avatar || author.originalAvatarUrl || "",
      follower_count: toNumber(author.fans),
      heart_count: toNumber(author.heart),
      video_count: toNumber(author.video),
      verified: Boolean(author.verified),
    },
  };
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

function jsonResponse(payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function shouldUseApify(env) {
  const source = String(env.TIKTOK_DATA_SOURCE || (env.APIFY_TOKEN ? "apify" : "tikwm")).toLowerCase();
  if (source === "auto") return Boolean(env.APIFY_TOKEN);
  return source === "apify";
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

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isoToUnixSeconds(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

function extractTikTokVideoId(value) {
  if (!value) return "";
  const match = String(value).match(/\/video\/(\d+)/);
  return match ? match[1] : "";
}
