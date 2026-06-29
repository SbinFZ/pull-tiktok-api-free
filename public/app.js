"use strict";

/* ====================================================================== *
 *  TikTok realtime playback dashboard
 *  Fixed account list -> /api/user + /api/posts -> detail + overview
 * ====================================================================== */

const PAGE_SIZE = 30;
const PAGE_DELAY_MS = 350;
const MAX_PAGES = 100;
const ACCOUNT_DELAY_MS = 500;
const API_TIMEOUT_MS = 30000;

const FIXED_ACCOUNTS = [
  "laqunhphng897",
  "lifeofsam3",
  "trntumn6694",
  "quynthanhmai553",
  "garrisonbright",
  "jadeybarra1",
];

const OVERVIEW_METRICS = {
  play_count: { label: "播放数", title: "每日发布内容播放数" },
  digg_count: { label: "点赞数", title: "每日发布内容点赞数" },
  comment_count: { label: "评论数", title: "每日发布内容评论数" },
  share_count: { label: "分享数", title: "每日发布内容分享数" },
  collect_count: { label: "收藏数", title: "每日发布内容收藏数" },
};

const $ = (sel) => document.querySelector(sel);
const API_BASE = (document.getElementById("app-script") || {}).src || document.baseURI;
const DATE_RANGE_TARGETS = {
  playback: { from: "#filter-date-from", to: "#filter-date-to", render: () => renderPlayback() },
  overview: { from: "#overview-date-from", to: "#overview-date-to", render: () => renderOverview() },
};

let accounts = FIXED_ACCOUNTS.map((handle) => ({
  handle,
  profile: null,
  stats: null,
  updatedAt: null,
  status: "idle",
  error: null,
}));

let refreshingAccounts = false;

const playbackState = {
  videos: [],
  loading: false,
  sortKey: "create_time",
  sortDir: -1,
  errors: [],
};

const filterState = {
  accounts: new Set(),
  videos: new Set(),
};

/* ------------------------------- helpers ------------------------------ */

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

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountKey(handle) {
  return String(handle || "").toLowerCase();
}

function findAccount(handle) {
  const key = accountKey(handle);
  return accounts.find((account) => accountKey(account.handle) === key);
}

function getNumberValue(selector) {
  const value = $(selector).value.trim();
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateToUnixStart(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function dateToUnixEnd(value) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function dateInputValue(date) {
  const p = (x) => String(x).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function getDateRange(range) {
  const today = startOfToday();
  if (range === "yesterday") {
    const yesterday = addDays(today, -1);
    return { from: dateInputValue(yesterday), to: dateInputValue(yesterday) };
  }

  const days = Number(range) || 7;
  return {
    from: dateInputValue(addDays(today, -(days - 1))),
    to: dateInputValue(today),
  };
}

function setDateRange(target, range, options = {}) {
  const config = DATE_RANGE_TARGETS[target];
  if (!config) return;
  const { from, to } = getDateRange(range);
  $(config.from).value = from;
  $(config.to).value = to;
  updateDateShortcutState(target);
  if (options.render !== false) config.render();
}

function updateDateShortcutState(target) {
  const config = DATE_RANGE_TARGETS[target];
  if (!config) return;
  const currentFrom = $(config.from).value;
  const currentTo = $(config.to).value;

  document.querySelectorAll(`[data-date-target="${target}"][data-date-range]`).forEach((button) => {
    const range = getDateRange(button.dataset.dateRange);
    button.classList.toggle("is-active", currentFrom === range.from && currentTo === range.to);
  });
}

function updateAllDateShortcutStates() {
  Object.keys(DATE_RANGE_TARGETS).forEach(updateDateShortcutState);
}

function initializeDateFilters() {
  setDateRange("playback", "7", { render: false });
  setDateRange("overview", "7", { render: false });
  updateAllDateShortcutStates();
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

async function apiGet(path) {
  const url = new URL(path.replace(/^\//, ""), API_BASE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;

  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("请求超时，上游接口暂时没有响应");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`服务返回了非 JSON 响应 (HTTP ${res.status})`);
  }
  if (!res.ok || json.ok === false) {
    throw new Error(json.message || `请求失败 (HTTP ${res.status})`);
  }
  return json;
}

/* --------------------------- mode switching --------------------------- */

function setMode(mode) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.mode === mode);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.hidden = panel.id !== `panel-${mode}`;
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

/* ----------------------------- accounts ------------------------------- */

function renderAccounts() {
  const list = $("#accounts-list");
  const empty = $("#accounts-empty");
  const refreshBtn = $("#btn-refresh-accounts");
  refreshBtn.disabled = refreshingAccounts || playbackState.loading;

  empty.hidden = accounts.length > 0;
  list.hidden = accounts.length === 0;
  list.innerHTML = accounts.map(renderAccountCard).join("");
}

function renderAccountCard(account) {
  const profile = account.profile || {};
  const stats = account.stats || {};
  const status = account.status || "idle";
  const avatar = profile.avatar || "";
  const name = profile.nickname || account.handle;
  const handle = account.handle;
  const profileUrl = `https://www.tiktok.com/@${handle}`;
  const statusText = status === "loading" ? "刷新中" : status === "error" ? "刷新失败" : account.updatedAt ? "已更新" : "待刷新";
  const statusClass = status === "loading" ? "is-loading" : status === "error" ? "is-error" : "is-ready";
  const disabled = status === "loading" || refreshingAccounts || playbackState.loading ? "disabled" : "";
  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" loading="lazy">`
    : `<span>${esc(handle.slice(0, 1).toUpperCase())}</span>`;

  return `<article class="account-card ${esc(statusClass)}" data-account="${esc(handle)}">
    <div class="account-top">
      <div class="account-avatar">${avatarHtml}</div>
      <div class="account-main">
        <div class="account-name">
          <span>${esc(name)}</span>
          ${profile.verified ? `<span class="verified" title="已认证">✔</span>` : ""}
        </div>
        <a class="handle" href="${esc(profileUrl)}" target="_blank" rel="noopener">@${esc(handle)}</a>
      </div>
      <span class="account-badge ${esc(statusClass)}">${esc(statusText)}</span>
    </div>

    <div class="account-metrics compact">
      ${metricHtml("粉丝", stats.followerCount)}
      ${metricHtml("获赞", stats.heartCount)}
      ${metricHtml("作品", stats.videoCount)}
    </div>

    ${account.error ? `<p class="account-error">${esc(account.error)}</p>` : ""}

    <div class="account-actions">
      <button type="button" class="btn-ghost" data-action="open" data-account="${esc(handle)}">查看作品</button>
      <button type="button" class="btn-ghost" data-action="refresh" data-account="${esc(handle)}" ${disabled}>刷新资料</button>
      <span class="account-updated">更新：${esc(fmtDateTime(account.updatedAt))}</span>
    </div>
  </article>`;
}

function metricHtml(label, value) {
  const display = value == null ? "—" : fmt(value);
  return `<div class="account-metric"><span>${esc(label)}</span><b>${esc(display)}</b></div>`;
}

async function refreshAllAccounts() {
  if (refreshingAccounts) return;
  refreshingAccounts = true;
  renderAccounts();
  setStatus($("#account-status"), "loading", "正在实时刷新账号资料…");

  for (const account of accounts) {
    await refreshAccount(account.handle, { quiet: true });
    if (accounts.length > 1) await sleep(ACCOUNT_DELAY_MS);
  }

  refreshingAccounts = false;
  renderAccounts();
  setStatus($("#account-status"), "", `已刷新 ${accounts.length} 个固定账号资料。`);
}

async function refreshAccount(handle, options = {}) {
  const account = findAccount(handle);
  if (!account) return null;

  account.status = "loading";
  account.error = null;
  renderAccounts();
  if (!options.quiet) setStatus($("#account-status"), "loading", `正在刷新 @${esc(handle)}…`);

  try {
    const snapshot = await fetchAccountProfileSnapshot(handle);
    account.handle = snapshot.handle;
    account.profile = snapshot.profile;
    account.stats = snapshot.stats;
    account.updatedAt = new Date().toISOString();
    account.status = "ready";
    if (!options.quiet) setStatus($("#account-status"), "", `已刷新 @${esc(account.handle)}。`);
    return account;
  } catch (err) {
    account.status = "error";
    account.error = err.message || String(err);
    if (!options.quiet) setStatus($("#account-status"), "error", `@${esc(handle)} 刷新失败：${esc(account.error)}`);
    return account;
  } finally {
    renderAccounts();
  }
}

async function fetchAccountProfileSnapshot(handle) {
  const { data: userData } = await apiGet(`/api/user?unique_id=${encodeURIComponent(handle)}`);
  const user = userData.user || {};
  const stats = userData.stats || {};
  const canonical = user.uniqueId || handle;

  return {
    handle: canonical,
    profile: {
      nickname: user.nickname || canonical,
      avatar: user.avatarMedium || user.avatarThumb || "",
      signature: user.signature || "",
      verified: Boolean(user.verified),
    },
    stats: {
      followerCount: stats.followerCount || 0,
      followingCount: stats.followingCount || 0,
      heartCount: stats.heartCount ?? stats.heart ?? 0,
      videoCount: stats.videoCount || 0,
    },
  };
}

/* ---------------------------- playback data --------------------------- */

function renderPlayback() {
  const empty = $("#playback-empty");
  const aggregate = $("#playback-aggregate");
  const wrap = $("#playback-wrap");
  const refreshBtn = $("#btn-refresh-playback");
  refreshBtn.disabled = playbackState.loading;
  renderPlaybackFilters();

  if (!playbackState.videos.length) {
    empty.hidden = false;
    aggregate.hidden = true;
    wrap.hidden = true;
    $("#playback-body").innerHTML = "";
    renderPlaybackAggregate([]);
    renderOverview();
    return;
  }

  const filteredVideos = filteredPlaybackVideos();
  empty.hidden = true;
  aggregate.hidden = false;
  wrap.hidden = false;
  renderPlaybackAggregate(filteredVideos);
  renderPlaybackTable(filteredVideos);
  renderOverview();
}

function renderPlaybackFilters() {
  const accountOptions = accounts.map((account) => ({
    value: accountKey(account.handle),
    label: account.profile && account.profile.nickname
      ? `${account.profile.nickname} (@${account.handle})`
      : `@${account.handle}`,
  }));
  const videoOptions = [...playbackState.videos]
    .sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
    .map((video) => ({
      value: video.rowId,
      label: `@${video.accountHandle} · ${video.title || "(无标题)"}`,
    }));

  filterState.accounts = pruneSelection(filterState.accounts, accountOptions);
  filterState.videos = pruneSelection(filterState.videos, videoOptions);
  renderMultiSelect("#filter-accounts", accountOptions, filterState.accounts, "全部账号", "账号");
  renderMultiSelect("#filter-videos", videoOptions, filterState.videos, "全部视频", "视频");
}

function pruneSelection(selection, options) {
  const available = new Set(options.map((option) => option.value));
  return new Set([...selection].filter((value) => available.has(value)));
}

function renderMultiSelect(selector, options, selection, emptyLabel, unitLabel) {
  const root = $(selector);
  if (!root) return;
  const trigger = root.querySelector(".multi-select-trigger");
  const label = root.querySelector("[data-multi-label]");
  const optionsEl = root.querySelector(".multi-options");
  trigger.disabled = options.length === 0;
  label.textContent = selection.size ? `已选 ${selection.size}/${options.length} 个${unitLabel}` : emptyLabel;
  optionsEl.innerHTML = options.length
    ? options.map((option) => {
        const checked = selection.has(option.value) ? "checked" : "";
        return `<label class="multi-option">
          <input type="checkbox" data-multi-option value="${esc(option.value)}" ${checked} />
          <span>${esc(option.label)}</span>
        </label>`;
      }).join("")
    : `<div class="multi-empty">暂无选项</div>`;
}

function getSelectedValues(input) {
  const el = typeof input === "string" ? $(input) : input;
  if (!el) return [];
  if (el.classList.contains("multi-select")) {
    return [...filterState[el.dataset.filterMulti]];
  }
  return [...el.selectedOptions].map((option) => option.value);
}

function setSelectedValues(selector, values) {
  const el = $(selector);
  if (!el || !el.classList.contains("multi-select")) return;
  filterState[el.dataset.filterMulti] = new Set(values);
}

function closeMultiSelectMenus(except = null) {
  document.querySelectorAll(".multi-select-menu").forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
}

function filteredPlaybackVideos() {
  const selectedAccounts = new Set(getSelectedValues("#filter-accounts"));
  const selectedVideos = new Set(getSelectedValues("#filter-videos"));
  const playMin = getNumberValue("#filter-play-min");
  const playMax = getNumberValue("#filter-play-max");
  const likeMin = getNumberValue("#filter-like-min");
  const likeMax = getNumberValue("#filter-like-max");
  const dateFrom = dateToUnixStart($("#filter-date-from").value);
  const dateTo = dateToUnixEnd($("#filter-date-to").value);

  return playbackState.videos.filter((video) => {
    if (selectedAccounts.size && !selectedAccounts.has(accountKey(video.accountHandle))) return false;
    if (selectedVideos.size && !selectedVideos.has(video.rowId)) return false;
    if (playMin != null && video.play_count < playMin) return false;
    if (playMax != null && video.play_count > playMax) return false;
    if (likeMin != null && video.digg_count < likeMin) return false;
    if (likeMax != null && video.digg_count > likeMax) return false;
    if (dateFrom != null && video.create_time < dateFrom) return false;
    if (dateTo != null && video.create_time > dateTo) return false;
    return true;
  });
}

function renderPlaybackAggregate(videos = filteredPlaybackVideos()) {
  const sum = (key) => videos.reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
  const plays = sum("play_count");
  const visibleAccountCount = new Set(videos.map((video) => accountKey(video.accountHandle))).size;
  $("#pd-accounts").textContent = fmt(visibleAccountCount || accounts.length);
  $("#pd-videos").textContent = fmt(videos.length);
  $("#pd-plays").textContent = fmt(plays);
  $("#pd-likes").textContent = fmt(sum("digg_count"));
  $("#pd-comments").textContent = fmt(sum("comment_count"));
  $("#pd-avg").textContent = fmt(videos.length ? Math.round(plays / videos.length) : 0);
}

function sortedPlaybackVideos(videos = filteredPlaybackVideos()) {
  const { sortKey, sortDir } = playbackState;
  return [...videos].sort((a, b) => ((a[sortKey] || 0) - (b[sortKey] || 0)) * sortDir);
}

function renderPlaybackTable(videos = filteredPlaybackVideos()) {
  const body = $("#playback-body");
  if (!videos.length) {
    body.innerHTML = `<tr class="no-results"><td colspan="9">没有匹配的播放数据</td></tr>`;
    return;
  }

  body.innerHTML = sortedPlaybackVideos(videos)
    .map((video) => {
      const avatar = video.accountAvatar
        ? `<img class="avatar-xs" src="${esc(video.accountAvatar)}" alt="" loading="lazy">`
        : `<span class="avatar-xs text-avatar">${esc(video.accountHandle.slice(0, 1).toUpperCase())}</span>`;
      return `<tr class="clickable-row" tabindex="0" data-row-id="${esc(video.rowId)}">
        <td>
          <div class="account-cell">
            ${avatar}
            <div>
              <b>${esc(video.accountName || video.accountHandle)}</b>
              <span>@${esc(video.accountHandle)}</span>
            </div>
          </div>
        </td>
        <td><img class="thumb" loading="lazy" src="${esc(video.cover || "")}" alt=""></td>
        <td class="col-title"><div class="vid-title">${esc(video.title || "(无标题)")}</div></td>
        <td class="num">${fmt(video.play_count)}</td>
        <td class="num">${fmt(video.digg_count)}</td>
        <td class="num">${fmt(video.comment_count)}</td>
        <td class="num">${fmt(video.share_count)}</td>
        <td class="num">${fmt(video.collect_count)}</td>
        <td class="num">${fmtDate(video.create_time)}</td>
      </tr>`;
    })
    .join("");
}

async function refreshPlaybackData(options = {}) {
  if (playbackState.loading) return;

  const autoAll = $("#playback-auto-all").checked;
  playbackState.loading = true;
  playbackState.videos = [];
  playbackState.errors = [];
  renderPlayback();

  const statusEl = $("#playback-status");
  setStatus(statusEl, "loading", options.reason === "startup" ? "正在实时拉取固定账号数据…" : "正在实时刷新播放数据…");

  for (let i = 0; i < accounts.length; i++) {
    let account = accounts[i];
    try {
      setStatus(
        statusEl,
        "loading",
        `正在拉取 @${esc(account.handle)} (${i + 1}/${accounts.length})… 已加载 <b>${playbackState.videos.length}</b> 条`
      );
      account = await refreshAccount(account.handle, { quiet: true });
      const rows = await fetchPlaybackVideosForAccount(account, autoAll, statusEl, i + 1, accounts.length);
      playbackState.videos.push(...rows);
      renderPlayback();
    } catch (err) {
      const message = err.message || String(err);
      account.status = "error";
      account.error = message;
      playbackState.errors.push(`@${account.handle}: ${message}`);
      renderAccounts();
    }

    if (i < accounts.length - 1) await sleep(ACCOUNT_DELAY_MS);
  }

  playbackState.loading = false;
  renderAccounts();
  renderPlayback();

  if (playbackState.errors.length) {
    const errorItems = playbackState.errors.map((item) => `<li>${esc(item)}</li>`).join("");
    setStatus(
      statusEl,
      "error",
      `已实时加载 <b>${playbackState.videos.length}</b> 条，${playbackState.errors.length} 个账号失败。<ul class="status-list">${errorItems}</ul>`
    );
  } else {
    setStatus(statusEl, "", `已实时更新 <b>${playbackState.videos.length}</b> 条播放数据。`);
  }
}

async function fetchPlaybackVideosForAccount(account, autoAll, statusEl, accountIndex, totalAccounts) {
  let cursor = 0;
  let hasMore = false;
  let page = 0;
  const rows = [];

  do {
    page++;
    const { data } = await apiGet(
      `/api/posts?unique_id=${encodeURIComponent(account.handle)}` +
        `&cursor=${cursor}&count=${PAGE_SIZE}`
    );
    rows.push(...(data.videos || []).map((video) => normalisePlaybackVideo(video, account)));
    cursor = data.cursor || cursor;
    hasMore = Boolean(data.hasMore);

    setStatus(
      statusEl,
      "loading",
      `正在拉取 @${esc(account.handle)} (${accountIndex}/${totalAccounts})… 已加载 <b>${playbackState.videos.length + rows.length}</b> 条`
    );

    if (!autoAll) break;
    if (hasMore && page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (autoAll && hasMore && page < MAX_PAGES);

  return rows;
}

function normalisePlaybackVideo(video, account) {
  const id = video.video_id || video.id || "";
  const accountHandle = account.handle;
  const authorHandle = (video.author && video.author.unique_id) || accountHandle;
  const url = `https://www.tiktok.com/@${authorHandle}/video/${id}`;
  return {
    rowId: `${accountKey(accountHandle)}:${id}`,
    id,
    url,
    embedUrl: id ? `https://www.tiktok.com/embed/v2/${id}` : url,
    accountHandle,
    accountName: account.profile && account.profile.nickname,
    accountAvatar: account.profile && account.profile.avatar,
    authorHandle,
    title: video.title || "",
    cover: video.origin_cover || video.cover || "",
    play_count: Number(video.play_count) || 0,
    digg_count: Number(video.digg_count) || 0,
    comment_count: Number(video.comment_count) || 0,
    share_count: Number(video.share_count) || 0,
    collect_count: Number(video.collect_count) || 0,
    create_time: Number(video.create_time) || 0,
  };
}

/* ------------------------------ overview ------------------------------ */

function getOverviewMetric() {
  const metric = $("#overview-metric").value;
  return OVERVIEW_METRICS[metric] ? metric : "play_count";
}

function buildDailyOverview(metric) {
  const from = $("#overview-date-from").value;
  const to = $("#overview-date-to").value;
  const groups = new Map();

  playbackState.videos.forEach((video) => {
    const day = fmtDate(video.create_time);
    if (day === "—") return;
    if (from && day < from) return;
    if (to && day > to) return;
    if (!groups.has(day)) groups.set(day, { day, value: 0, videos: [] });
    const group = groups.get(day);
    const value = Number(video[metric]) || 0;
    group.value += value;
    group.videos.push({ ...video, overviewValue: value });
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      videos: group.videos.sort((a, b) => b.overviewValue - a.overviewValue).slice(0, 3),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function renderOverview() {
  const empty = $("#overview-empty");
  const emptyDetail = $("#overview-empty-detail");
  const chartCard = $("#overview-chart-card");
  const leaders = $("#overview-leaders");
  const metric = getOverviewMetric();
  const metricMeta = OVERVIEW_METRICS[metric];
  const daily = buildDailyOverview(metric);

  $("#overview-chart-title").textContent = metricMeta.title;
  $("#overview-chart-total").textContent = daily.length
    ? `合计 ${fmt(daily.reduce((sum, day) => sum + day.value, 0))}`
    : "";

  if (!daily.length) {
    empty.hidden = false;
    emptyDetail.textContent = playbackState.loading
      ? "正在实时拉取数据。"
      : "暂无可展示的发布日数据。";
    chartCard.hidden = true;
    leaders.hidden = true;
    $("#overview-chart").innerHTML = "";
    leaders.innerHTML = "";
    return;
  }

  empty.hidden = true;
  chartCard.hidden = false;
  leaders.hidden = false;
  renderOverviewChart(daily);
  renderOverviewLeaders(daily, metricMeta);
}

function renderOverviewChart(daily) {
  const width = Math.max(760, daily.length * 128);
  const height = 320;
  const pad = { top: 58, right: 28, bottom: 44, left: 58 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const maxValue = Math.max(...daily.map((day) => day.value), 1);
  const yTicks = [0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));
  const points = daily.map((day, index) => {
    const x = pad.left + (daily.length === 1 ? chartW / 2 : (chartW / (daily.length - 1)) * index);
    const y = pad.top + chartH - (day.value / maxValue) * chartH;
    return { ...day, x, y };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");

  $("#overview-chart").innerHTML = `<svg class="overview-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="每日发布内容数据折线图">
    <g class="chart-grid">
      ${yTicks.map((tick) => {
        const y = pad.top + chartH - (tick / maxValue) * chartH;
        return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line>
          <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end">${esc(fmt(tick))}</text>`;
      }).join("")}
    </g>
    <line class="chart-axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
    ${points.length > 1 ? `<polyline class="chart-line" points="${line}"></polyline>` : ""}
    <g class="chart-points">
      ${points.map((point) => `<g>
        <circle cx="${point.x}" cy="${point.y}" r="5"></circle>
        <text class="point-value" x="${point.x}" y="${Math.max(18, point.y - 14)}" text-anchor="middle">${esc(fmt(point.value))}</text>
        <text class="point-date" x="${point.x}" y="${height - 15}" text-anchor="middle">${esc(point.day.slice(5))}</text>
      </g>`).join("")}
    </g>
  </svg>`;
}

function renderOverviewLeaders(daily, metricMeta) {
  $("#overview-leaders").innerHTML = daily
    .map((day) => `<article class="daily-group">
      <div class="daily-group-head">
        <h3>${esc(day.day)}</h3>
        <span>${esc(metricMeta.label)} ${esc(fmt(day.value))}</span>
      </div>
      <div class="leader-grid">
        ${day.videos.length
          ? day.videos.map((video, index) => renderLeaderCard(video, index + 1, metricMeta)).join("")
          : `<div class="leader-empty">当天暂无内容</div>`}
      </div>
    </article>`)
    .join("");
}

function renderLeaderCard(video, rank, metricMeta) {
  const cover = video.cover
    ? `<img src="${esc(video.cover)}" alt="" loading="lazy">`
    : `<div class="leader-cover-empty">暂无封面</div>`;
  return `<button type="button" class="leader-card" data-row-id="${esc(video.rowId)}">
    <span class="leader-rank">TOP ${rank}</span>
    <span class="leader-cover">${cover}</span>
    <span class="leader-info">
      <span class="leader-title">${esc(video.title || "(无标题)")}</span>
      <span class="leader-account">@${esc(video.accountHandle)}</span>
      <span class="leader-value">${esc(metricMeta.label)} ${esc(fmt(video.overviewValue))}</span>
    </span>
  </button>`;
}

/* ------------------------------- drawer ------------------------------- */

function findVideoByRowId(rowId) {
  return playbackState.videos.find((item) => item.rowId === rowId);
}

function openVideoDrawer(rowId) {
  const video = findVideoByRowId(rowId);
  if (!video) return;

  $("#drawer-account").textContent = `@${video.accountHandle}`;
  $("#drawer-title").textContent = video.title || "(无标题)";
  $("#drawer-iframe").src = video.embedUrl;
  $("#drawer-play").textContent = fmt(video.play_count);
  $("#drawer-like").textContent = fmt(video.digg_count);
  $("#drawer-comment").textContent = fmt(video.comment_count);
  $("#drawer-share").textContent = fmt(video.share_count);
  $("#drawer-collect").textContent = fmt(video.collect_count);
  $("#drawer-date").textContent = fmtDate(video.create_time);
  $("#drawer-source").href = video.url;
  $("#video-drawer").hidden = false;
  document.body.classList.add("drawer-open");
}

function closeVideoDrawer() {
  $("#video-drawer").hidden = true;
  $("#drawer-iframe").src = "about:blank";
  document.body.classList.remove("drawer-open");
}

/* ------------------------------- events ------------------------------- */

$("#btn-refresh-playback").addEventListener("click", () => refreshPlaybackData());
$("#btn-refresh-accounts").addEventListener("click", () => refreshAllAccounts());

document.querySelectorAll("th.playback-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.playbackSort;
    if (playbackState.sortKey === key) {
      playbackState.sortDir *= -1;
    } else {
      playbackState.sortKey = key;
      playbackState.sortDir = -1;
    }
    renderPlaybackTable();
  });
});

document.querySelectorAll("[data-filter]").forEach((el) => {
  const eventName = el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(eventName, () => {
    renderPlayback();
    if (el.matches("#filter-date-from, #filter-date-to")) updateDateShortcutState("playback");
  });
});

document.querySelectorAll("[data-date-target][data-date-range]").forEach((button) => {
  button.addEventListener("click", () => {
    setDateRange(button.dataset.dateTarget, button.dataset.dateRange);
  });
});

$("#playback-filters").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-multi-toggle]");
  if (toggle) {
    const root = toggle.closest(".multi-select");
    const menu = root.querySelector(".multi-select-menu");
    closeMultiSelectMenus(menu);
    menu.hidden = !menu.hidden;
    return;
  }

  const action = e.target.closest("[data-multi-action]");
  if (!action) return;
  const root = action.closest(".multi-select");
  const key = root.dataset.filterMulti;
  if (action.dataset.multiAction === "all") {
    filterState[key] = new Set([...root.querySelectorAll("[data-multi-option]")].map((item) => item.value));
  } else {
    filterState[key] = new Set();
  }
  renderPlayback();
});

$("#playback-filters").addEventListener("change", (e) => {
  const option = e.target.closest("[data-multi-option]");
  if (!option) return;
  const root = option.closest(".multi-select");
  const key = root.dataset.filterMulti;
  if (option.checked) {
    filterState[key].add(option.value);
  } else {
    filterState[key].delete(option.value);
  }
  renderPlayback();
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".multi-select")) return;
  closeMultiSelectMenus();
});

$("#btn-reset-filters").addEventListener("click", () => {
  filterState.accounts = new Set();
  filterState.videos = new Set();
  closeMultiSelectMenus();
  document.querySelectorAll("[data-filter]").forEach((el) => {
    if (!el.matches("#filter-date-from, #filter-date-to")) el.value = "";
  });
  setDateRange("playback", "7", { render: false });
  renderPlayback();
});

["#overview-date-from", "#overview-date-to", "#overview-metric"].forEach((selector) => {
  const el = $(selector);
  const eventName = el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(eventName, () => {
    renderOverview();
    if (selector === "#overview-date-from" || selector === "#overview-date-to") {
      updateDateShortcutState("overview");
    }
  });
});

$("#overview-leaders").addEventListener("click", (e) => {
  const card = e.target.closest("[data-row-id]");
  if (card) openVideoDrawer(card.dataset.rowId);
});

$("#playback-body").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-row-id]");
  if (row) openVideoDrawer(row.dataset.rowId);
});

$("#playback-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest("tr[data-row-id]");
  if (!row) return;
  e.preventDefault();
  openVideoDrawer(row.dataset.rowId);
});

$("#accounts-list").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-action]");
  if (!button) return;

  const handle = button.dataset.account;
  if (button.dataset.action === "refresh") {
    await refreshAccount(handle);
    return;
  }

  if (button.dataset.action === "open") {
    setMode("playback");
    renderPlaybackFilters();
    setSelectedValues("#filter-accounts", [accountKey(handle)]);
    setSelectedValues("#filter-videos", []);
    renderPlayback();
  }
});

document.querySelectorAll("[data-drawer-close]").forEach((el) => {
  el.addEventListener("click", closeVideoDrawer);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#video-drawer").hidden) closeVideoDrawer();
});

initializeDateFilters();
renderAccounts();
renderPlayback();
refreshPlaybackData({ reason: "startup" });
