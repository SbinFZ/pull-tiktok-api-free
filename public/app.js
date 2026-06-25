"use strict";

/* ====================================================================== *
 *  TikTok playback-info puller — frontend logic
 *  Talks only to our own Worker proxy: /api/video, /api/user, /api/posts
 * ====================================================================== */

const PAGE_SIZE = 30;          // videos per tikwm page request
const PAGE_DELAY_MS = 350;     // gap between pages — be gentle to upstream
const MAX_PAGES = 100;         // safety cap (≈ 3000 videos)

const $ = (sel) => document.querySelector(sel);

/* --------------------------- mode switching --------------------------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    const mode = tab.dataset.mode;
    $("#panel-user").hidden = mode !== "user";
    $("#panel-url").hidden = mode !== "url";
  });
});

/* ------------------------------ formatting ---------------------------- */

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDuration(sec) {
  sec = Number(sec) || 0;
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ------------------------------ networking ---------------------------- */

// Resolve API calls relative to where app.js itself was loaded, so the app
// works whether it is served from the domain root or a subdirectory
// (e.g. https://example.com/apps/tiktok-info/). Never use root-absolute paths.
const API_BASE = (document.getElementById("app-script") || {}).src || document.baseURI;

async function apiGet(path) {
  const url = new URL(path.replace(/^\//, ""), API_BASE);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`服务返回了非 JSON 响应 (HTTP ${res.status})`);
  }
  if (!res.ok || json.ok === false) {
    throw new Error(json.message || `请求失败 (HTTP ${res.status})`);
  }
  return json; // tikwm envelope: { code, msg, data }
}

function setStatus(el, kind, html) {
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}
function clearStatus(el) {
  el.hidden = true;
  el.innerHTML = "";
}

/* ============================= URL MODE ============================== */

$("#form-url").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#input-url").value.trim();
  const statusEl = $("#url-status");
  const card = $("#video-card");
  if (!url) return;

  card.hidden = true;
  setStatus(statusEl, "loading", "查询中…");

  try {
    const { data } = await apiGet(`/api/video?url=${encodeURIComponent(url)}`);
    renderVideoCard(data);
    clearStatus(statusEl);
    card.hidden = false;
  } catch (err) {
    setStatus(statusEl, "error", `❌ ${esc(err.message)}`);
  }
});

function renderVideoCard(d) {
  const author = d.author || {};
  $("#vc-img").src = d.cover || d.origin_cover || "";
  $("#vc-duration").textContent = fmtDuration(d.duration);
  $("#vc-author-avatar").src = author.avatar || "";
  $("#vc-author-nick").textContent = author.nickname || author.unique_id || "";
  const handleEl = $("#vc-author-handle");
  if (author.unique_id) {
    handleEl.textContent = "@" + author.unique_id;
    handleEl.href = `https://www.tiktok.com/@${author.unique_id}`;
  } else {
    handleEl.textContent = "";
    handleEl.removeAttribute("href");
  }
  $("#vc-title").textContent = d.title || "(无标题)";

  $("#vc-play").textContent = fmt(d.play_count);
  $("#vc-like").textContent = fmt(d.digg_count);
  $("#vc-comment").textContent = fmt(d.comment_count);
  $("#vc-share").textContent = fmt(d.share_count);
  $("#vc-collect").textContent = fmt(d.collect_count);
  $("#vc-download").textContent = fmt(d.download_count);

  setLink($("#vc-play-link"), d.play);
  setLink($("#vc-music-link"), d.music || (d.music_info && d.music_info.play));
  const src = d.id ? `https://www.tiktok.com/@${author.unique_id || ""}/video/${d.id}` : null;
  setLink($("#vc-source-link"), src);
}

function setLink(el, href) {
  if (href) {
    el.href = href;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ============================= USER MODE ============================= */

const state = {
  handle: null,
  cursor: 0,
  hasMore: false,
  loading: false,
  videos: [],
  sortKey: "create_time",
  sortDir: -1, // -1 desc, 1 asc
};

$("#form-user").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#input-user").value.trim();
  if (!raw) return;
  await startUserQuery(raw);
});

async function startUserQuery(raw) {
  // reset
  state.handle = raw;
  state.cursor = 0;
  state.hasMore = false;
  state.videos = [];
  state.loading = false;

  const statusEl = $("#user-status");
  $("#profile").hidden = true;
  $("#aggregate").hidden = true;
  $("#user-actions").hidden = true;
  $("#videos-wrap").hidden = true;
  $("#videos-body").innerHTML = "";
  setStatus(statusEl, "loading", "正在获取用户信息…");

  try {
    const { data } = await apiGet(`/api/user?unique_id=${encodeURIComponent(raw)}`);
    renderProfile(data);
    $("#profile").hidden = false;
  } catch (err) {
    setStatus(statusEl, "error", `❌ ${esc(err.message)}`);
    return;
  }

  // Now pull videos (each page already carries playback stats per video).
  const autoAll = $("#auto-all").checked;
  await loadPages(autoAll);
}

function renderProfile(data) {
  const u = data.user || {};
  const s = data.stats || {};
  state.handle = u.uniqueId || state.handle; // canonical handle for posts/export

  $("#profile-avatar").src = u.avatarMedium || u.avatarThumb || "";
  $("#profile-nick").textContent = u.nickname || u.uniqueId || "";
  $("#profile-verified").hidden = !u.verified;
  const handleEl = $("#profile-handle");
  handleEl.textContent = "@" + (u.uniqueId || "");
  handleEl.href = `https://www.tiktok.com/@${u.uniqueId || ""}`;
  $("#profile-sig").textContent = u.signature || "";

  $("#ps-followers").textContent = fmt(s.followerCount);
  $("#ps-following").textContent = fmt(s.followingCount);
  $("#ps-hearts").textContent = fmt(s.heartCount ?? s.heart);
  $("#ps-videos").textContent = fmt(s.videoCount);
}

async function loadPages(autoAll) {
  const statusEl = $("#user-status");
  state.loading = true;
  $("#user-actions").hidden = false;
  $("#btn-load-more").disabled = true;

  let page = 0;
  do {
    page++;
    setStatus(
      statusEl,
      "loading",
      `正在拉取视频… 已加载 <b>${state.videos.length}</b> 个` +
        `<span class="bar"><i style="width:${state.hasMore || page === 1 ? 60 : 100}%"></i></span>`
    );

    let data;
    try {
      data = (await apiGet(
        `/api/posts?unique_id=${encodeURIComponent(state.handle)}` +
          `&cursor=${state.cursor}&count=${PAGE_SIZE}`
      )).data;
    } catch (err) {
      setStatus(statusEl, "error", `❌ 拉取视频出错：${esc(err.message)}（已加载 ${state.videos.length} 个）`);
      break;
    }

    const vids = data.videos || [];
    state.videos.push(...vids);
    state.cursor = data.cursor || state.cursor;
    state.hasMore = Boolean(data.hasMore);

    renderVideos();
    renderAggregate();
    $("#videos-wrap").hidden = false;
    $("#aggregate").hidden = false;

    if (!autoAll) break;
    if (state.hasMore && page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (autoAll && state.hasMore && page < MAX_PAGES);

  state.loading = false;
  finishLoad();
}

function finishLoad() {
  const statusEl = $("#user-status");
  const more = $("#btn-load-more");
  more.hidden = !state.hasMore;
  more.disabled = false;
  if (state.hasMore) {
    setStatus(statusEl, "", `已加载 <b>${state.videos.length}</b> 个视频，还有更多 — 点击「加载更多」继续。`);
  } else {
    setStatus(statusEl, "", `✅ 已加载全部 <b>${state.videos.length}</b> 个视频。`);
  }
}

$("#btn-load-more").addEventListener("click", async () => {
  if (state.loading || !state.hasMore) return;
  await loadPages($("#auto-all").checked);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------- rendering ------------------------------ */

function sortedVideos() {
  const { sortKey, sortDir } = state;
  return [...state.videos].sort((a, b) => ((a[sortKey] || 0) - (b[sortKey] || 0)) * sortDir);
}

function renderVideos() {
  const body = $("#videos-body");
  const rows = sortedVideos()
    .map((v) => {
      const vid = v.video_id || v.id;
      const handle = (v.author && v.author.unique_id) || state.handle;
      const link = `https://www.tiktok.com/@${handle}/video/${vid}`;
      const cover = v.origin_cover || v.cover || "";
      return `<tr>
        <td><a href="${esc(link)}" target="_blank" rel="noopener"><img class="thumb" loading="lazy" src="${esc(cover)}" alt=""></a></td>
        <td class="col-title"><a href="${esc(link)}" target="_blank" rel="noopener"><div class="vid-title">${esc(v.title || "(无标题)")}</div></a></td>
        <td class="num">${fmt(v.play_count)}</td>
        <td class="num">${fmt(v.digg_count)}</td>
        <td class="num">${fmt(v.comment_count)}</td>
        <td class="num">${fmt(v.share_count)}</td>
        <td class="num">${fmt(v.collect_count)}</td>
        <td class="num">${fmtDate(v.create_time)}</td>
      </tr>`;
    })
    .join("");
  body.innerHTML = rows;
}

function renderAggregate() {
  const v = state.videos;
  const sum = (k) => v.reduce((acc, x) => acc + (Number(x[k]) || 0), 0);
  const plays = sum("play_count");
  $("#agg-count").textContent = fmt(v.length);
  $("#agg-plays").textContent = fmt(plays);
  $("#agg-likes").textContent = fmt(sum("digg_count"));
  $("#agg-comments").textContent = fmt(sum("comment_count"));
  $("#agg-shares").textContent = fmt(sum("share_count"));
  $("#agg-avg").textContent = fmt(v.length ? Math.round(plays / v.length) : 0);
}

// Column sorting
document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir *= -1;
    } else {
      state.sortKey = key;
      state.sortDir = -1;
    }
    renderVideos();
  });
});

/* ------------------------------ CSV export ---------------------------- */

$("#btn-export").addEventListener("click", () => {
  if (!state.videos.length) return;
  const cols = [
    ["video_id", "video_id"],
    ["title", "title"],
    ["play_count", "play"],
    ["digg_count", "like"],
    ["comment_count", "comment"],
    ["share_count", "share"],
    ["collect_count", "collect"],
    ["download_count", "download"],
    ["create_time", "create_date"],
    ["url", "url"],
  ];
  const header = cols.map((c) => c[1]).join(",");
  const lines = sortedVideos().map((v) => {
    const vid = v.video_id || v.id;
    const handle = (v.author && v.author.unique_id) || state.handle;
    const row = {
      video_id: vid,
      title: v.title || "",
      play_count: v.play_count || 0,
      digg_count: v.digg_count || 0,
      comment_count: v.comment_count || 0,
      share_count: v.share_count || 0,
      collect_count: v.collect_count || 0,
      download_count: v.download_count || 0,
      create_time: fmtDate(v.create_time),
      url: `https://www.tiktok.com/@${handle}/video/${vid}`,
    };
    return cols.map((c) => csvCell(row[c[0]])).join(",");
  });
  const csv = "﻿" + [header, ...lines].join("\r\n"); // BOM for Excel/中文
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tiktok_${state.handle}_videos.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function csvCell(val) {
  const s = String(val ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
