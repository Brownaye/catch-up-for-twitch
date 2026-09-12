// Catch Up for Twitch - background service worker.
//
// Owns everything that talks to Twitch: the OAuth flow, the Helix request
// helper, the per-channel VOD cache, the 30-minute refresh alarm and the
// toolbar badge. The pages (popup / app / welcome) only ever send messages
// here and read chrome.storage.local. The access token never leaves the
// browser.

// Twitch application client ID (public identifier, safe to ship).
// Registered at dev.twitch.tv as "Catch Up VOD Inbox" with this extension's
// chrome.identity redirect URL. The extension ID is pinned by the "key"
// field in manifest.json so that URL never changes.
const CLIENT_ID = "u43rfuhg2k45p387nuptypgdi8h5kt";

const REDIRECT_URI = chrome.identity.getRedirectURL();
const HELIX = "https://api.twitch.tv/helix";

const CACHE_TTL = 5 * 60 * 1000;          // VODs / live status stay fresh this long
const USER_CACHE_TTL = 24 * 60 * 60 * 1000; // names + avatars change rarely
const REFRESH_ALARM = "catchup-refresh";
const REFRESH_MINUTES = 30;
const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000; // watched / resume entries older than this are dropped
const VOD_CONCURRENCY = 4;                // parallel /videos requests
const VODS_PER_CHANNEL = 100;             // Helix max per request; covers a 60-day window for daily streamers
const BADGE_COLOR = "#9147ff";
const MAX_LOOKBACK_DAYS = 60;

const DEFAULT_SETTINGS = {
  lookbackDays: 7,
  sleepStart: "23:00",
  sleepEnd: "08:00",
};

/* ---------- storage helpers ---------- */

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStored(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getSettings() {
  const { settings } = await getStored(["settings"]);
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const days = Number(merged.lookbackDays);
  merged.lookbackDays = Number.isFinite(days) ? Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.round(days))) : 7;
  return merged;
}

async function getSelectedChannels() {
  const { selectedChannels } = await getStored(["selectedChannels"]);
  return Array.isArray(selectedChannels) ? [...new Set(selectedChannels.filter(Boolean))] : [];
}

/* ---------- toolbar badge ---------- */

// Purple unread count normally; red "!" while the stored token is expired
// (same convention as Uptime Badges).
async function renderBadge(unread) {
  const { authExpired } = await getStored(["authExpired"]);
  if (authExpired) {
    chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    chrome.action.setBadgeText({ text: "!" });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  chrome.action.setBadgeText({ text: unread > 0 ? String(unread > 999 ? "999+" : unread) : "" });
}

/* ---------- auth ---------- */

// Run the implicit grant flow. Non-interactive succeeds only while the
// user's twitch.tv session cookie is still valid, which lets us renew an
// expired token without any UI.
async function authorize(interactive) {
  const authUrl =
    "https://id.twitch.tv/oauth2/authorize" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&response_type=token" +
    "&scope=user:read:follows" +
    (interactive ? "&force_verify=true" : "");

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive,
  });

  const params = new URLSearchParams(new URL(redirectResponse).hash.substring(1));
  const accessToken = params.get("access_token");
  if (!accessToken) throw new Error("Twitch did not return an access token.");

  await setStored({
    accessToken,
    connected: true,
    authExpired: false,
    authBannerDismissed: false,
  });

  // Who am I? Needed for /channels/followed.
  const me = await helixGet("/users", [], accessToken);
  const user = (me.data || [])[0];
  if (user) {
    await setStored({
      userId: user.id,
      userLogin: user.login,
      userName: user.display_name,
      userAvatar: user.profile_image_url,
    });
  }

  await refreshBadgeFromCache();
  return accessToken;
}

function login() {
  return authorize(true);
}

async function logout() {
  await setStored({
    accessToken: null,
    connected: false,
    authExpired: false,
    authBannerDismissed: false,
  });
  chrome.action.setBadgeText({ text: "" });
}

// Token came back 401: try a silent renewal first, and only surface the
// expiry (toolbar alert + in-page banner) if that fails too.
let renewInFlight = null;
function handleExpiredToken() {
  if (!renewInFlight) {
    renewInFlight = (async () => {
      try {
        return await authorize(false);
      } catch {
        await setStored({ accessToken: null, connected: false, authExpired: true });
        await renderBadge(0);
        return null;
      } finally {
        renewInFlight = null;
      }
    })();
  }
  return renewInFlight;
}

/* ---------- Helix request helper ---------- */

class HelixError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;     // not_connected | unauthorized | network | http
    this.status = status;
  }
}

// GET a Helix endpoint. `query` is a list of [key, value] pairs so a key
// can repeat (user_id=a&user_id=b). Handles 401 -> silent renew -> retry,
// and a single wait-and-retry on 429.
async function helixGet(path, query = [], tokenOverride = null) {
  let accessToken = tokenOverride;
  if (!accessToken) {
    ({ accessToken } = await getStored(["accessToken"]));
    if (!accessToken) throw new HelixError("not_connected", "Not connected to Twitch.");
  }

  const qs = query
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${HELIX}${path}${qs ? `?${qs}` : ""}`;

  const doFetch = async (token) => {
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, "Client-Id": CLIENT_ID },
      });
    } catch (err) {
      throw new HelixError("network", `Network error: ${err.message || err}`);
    }
  };

  let resp = await doFetch(accessToken);

  if (resp.status === 401 && !tokenOverride) {
    accessToken = await handleExpiredToken();
    if (!accessToken) throw new HelixError("unauthorized", "Twitch login expired.", 401);
    resp = await doFetch(accessToken);
  }
  if (resp.status === 401) throw new HelixError("unauthorized", "Twitch login expired.", 401);

  if (resp.status === 429) {
    const reset = Number(resp.headers.get("Ratelimit-Reset")) * 1000;
    const waitMs = Math.min(10000, Math.max(1000, reset ? reset - Date.now() : 2000));
    await new Promise((r) => setTimeout(r, waitMs));
    resp = await doFetch(accessToken);
  }

  if (!resp.ok) {
    throw new HelixError("http", `Twitch returned HTTP ${resp.status} for ${path}.`, resp.status);
  }
  return resp.json();
}

// Run `fn` over `items` with at most `limit` in flight at once.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------- cache ---------- */

// cache: { users: { [id]: { id, login, name, avatar, fetchedAt } },
//          vods:  { [channelId]: { fetchedAt, items, everHadVods, error? } },
//          live:  { fetchedAt, byId: { [channelId]: { startedAt, title, game, viewers } } } }
async function loadCache() {
  const { cache } = await getStored(["cache"]);
  const c = cache && typeof cache === "object" ? cache : {};
  c.users = c.users || {};
  c.vods = c.vods || {};
  c.live = c.live || { fetchedAt: 0, byId: {} };
  return c;
}

function saveCache(cache) {
  return setStored({ cache });
}

/* ---------- Twitch data ---------- */

// Every channel the signed-in user follows, following the cursor until it
// runs out. Duplicates (Helix occasionally repeats across pages) are dropped.
async function fetchFollowedChannels() {
  const { userId } = await getStored(["userId"]);
  if (!userId) throw new HelixError("not_connected", "Not connected to Twitch.");

  const seen = new Map();
  let cursor = null;
  let guard = 0;
  do {
    const json = await helixGet("/channels/followed", [
      ["user_id", userId],
      ["first", 100],
      ["after", cursor],
    ]);
    for (const f of json.data || []) {
      if (!seen.has(f.broadcaster_id)) {
        seen.set(f.broadcaster_id, {
          id: f.broadcaster_id,
          login: f.broadcaster_login,
          name: f.broadcaster_name,
          followedAt: f.followed_at,
        });
      }
    }
    cursor = json.pagination && json.pagination.cursor ? json.pagination.cursor : null;
  } while (cursor && ++guard < 100); // 100 pages = 10,000 follows, well past Twitch's cap

  return [...seen.values()];
}

// Display names + avatars, 100 ids per request, cached for a day.
// Ids Helix does not return (deleted / banned) are recorded as missing so
// we do not ask for them again until the cache entry ages out.
async function ensureUsers(cache, ids, force = false) {
  const now = Date.now();
  const stale = [...new Set(ids)].filter((id) => {
    const u = cache.users[id];
    return force || !u || now - (u.fetchedAt || 0) > USER_CACHE_TTL;
  });
  if (stale.length === 0) return;

  for (const batch of chunk(stale, 100)) {
    const json = await helixGet("/users", batch.map((id) => ["id", id]));
    const got = new Set();
    for (const u of json.data || []) {
      got.add(u.id);
      cache.users[u.id] = {
        id: u.id,
        login: u.login,
        name: u.display_name,
        avatar: u.profile_image_url,
        fetchedAt: now,
      };
    }
    for (const id of batch) {
      if (!got.has(id)) {
        const prev = cache.users[id] || { id };
        cache.users[id] = { ...prev, missing: true, fetchedAt: now };
      }
    }
  }
}

// "4h12m33s" -> seconds. Helix omits units that are zero ("47m2s", "58s").
function parseDuration(str) {
  if (typeof str !== "string") return 0;
  const m = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function normalizeVod(v) {
  return {
    id: v.id,
    channelId: v.user_id,
    title: v.title || "",
    createdAt: v.created_at,
    duration: parseDuration(v.duration),
    durationText: v.duration || "",
    // Helix hands back a template; a VOD still being recorded has no thumbnail yet.
    thumbnail: (v.thumbnail_url || "").replace("%{width}", "320").replace("%{height}", "180"),
    url: v.url || `https://www.twitch.tv/videos/${v.id}`,
    views: v.view_count || 0,
    streamId: v.stream_id || null,
  };
}

// Archive VODs for one channel. Returns the cache entry; on failure keeps
// whatever was cached before and records the error on it.
async function fetchChannelVods(cache, channelId, force) {
  const now = Date.now();
  const entry = cache.vods[channelId];
  if (!force && entry && !entry.error && now - (entry.fetchedAt || 0) < CACHE_TTL) return entry;

  try {
    const json = await helixGet("/videos", [
      ["user_id", channelId],
      ["type", "archive"],
      ["first", VODS_PER_CHANNEL],
    ]);
    const items = (json.data || []).map(normalizeVod);
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    cache.vods[channelId] = { fetchedAt: now, items, everHadVods: items.length > 0 };
  } catch (err) {
    if (err.code === "unauthorized" || err.code === "not_connected") throw err;
    // Helix answers 404/400 for a deleted or banned broadcaster; treat as "no VODs".
    if (err.code === "http" && (err.status === 404 || err.status === 400)) {
      cache.vods[channelId] = { fetchedAt: now, items: [], everHadVods: false, unavailable: true };
    } else {
      cache.vods[channelId] = {
        ...(entry || { items: [], everHadVods: false }),
        fetchedAt: entry ? entry.fetchedAt : 0,
        error: err.code || "error",
      };
    }
  }
  return cache.vods[channelId];
}

// Who is live right now, 100 ids per request.
async function fetchLive(cache, ids, force) {
  const now = Date.now();
  if (!force && now - (cache.live.fetchedAt || 0) < CACHE_TTL) return cache.live;

  const byId = {};
  try {
    for (const batch of chunk(ids, 100)) {
      const json = await helixGet("/streams", [["first", 100], ...batch.map((id) => ["user_id", id])]);
      for (const s of json.data || []) {
        byId[s.user_id] = {
          startedAt: s.started_at,
          title: s.title || "",
          game: s.game_name || "",
          viewers: s.viewer_count || 0,
          login: s.user_login,
        };
      }
    }
    cache.live = { fetchedAt: now, byId };
  } catch (err) {
    if (err.code === "unauthorized" || err.code === "not_connected") throw err;
    cache.live = { ...cache.live, error: err.code || "error" };
  }
  return cache.live;
}

/* ---------- inbox ---------- */

// Build the inbox from the cache: one entry per selected channel with the
// VODs that fall inside the lookback window, newest first, plus flags the
// UI needs. Pure function of (cache, selected, settings, watched, resume).
function buildInbox(cache, selected, settings, watched, resume) {
  const now = Date.now();
  const windowStart = now - settings.lookbackDays * 24 * 60 * 60 * 1000;
  let unread = 0;

  const channels = selected.map((id) => {
    const user = cache.users[id] || { id };
    const entry = cache.vods[id];
    const vods = (entry ? entry.items : [])
      .filter((v) => Date.parse(v.createdAt) >= windowStart)
      .map((v) => ({
        ...v,
        watched: !!(watched && watched[v.id]),
        resume: resume && resume[v.id] ? resume[v.id].seconds || 0 : 0,
      }));
    const unreadHere = vods.filter((v) => !v.watched).length;
    unread += unreadHere;

    const liveInfo = cache.live.byId && cache.live.byId[id];
    return {
      id,
      login: user.login || "",
      name: user.name || user.login || `Channel ${id}`,
      avatar: user.avatar || "",
      missing: !!user.missing || !!(entry && entry.unavailable),
      live: liveInfo || null,
      vods,
      unread: unreadHere,
      everHadVods: !!(entry && entry.everHadVods),
      fetched: !!(entry && entry.fetchedAt),
      error: entry && entry.error ? entry.error : null,
      latestAt: vods.length ? Date.parse(vods[0].createdAt) : 0,
    };
  });

  channels.sort((a, b) => b.latestAt - a.latestAt || a.name.localeCompare(b.name));
  return { channels, unread, fetchedAt: cache.live.fetchedAt || 0 };
}

// Refresh (respecting the 5-minute cache unless `force`) and return the
// inbox. Concurrent callers (popup + alarm) share one in-flight run.
let inboxInFlight = null;
function getInbox(force = false) {
  if (inboxInFlight) return inboxInFlight;
  inboxInFlight = (async () => {
    try {
      return await refreshInbox(force);
    } finally {
      inboxInFlight = null;
    }
  })();
  return inboxInFlight;
}

async function refreshInbox(force) {
  const { accessToken, authExpired } = await getStored(["accessToken", "authExpired"]);
  if (!accessToken) {
    return { ok: false, error: authExpired ? "unauthorized" : "not_connected" };
  }

  const [selected, settings, cache] = await Promise.all([getSelectedChannels(), getSettings(), loadCache()]);

  // Forget VOD caches for channels that were unticked.
  const selectedSet = new Set(selected);
  for (const id of Object.keys(cache.vods)) if (!selectedSet.has(id)) delete cache.vods[id];

  let errors = 0;
  let authError = null;
  if (selected.length > 0) {
    try {
      await ensureUsers(cache, selected, false);
    } catch (err) {
      if (err.code === "unauthorized" || err.code === "not_connected") authError = err;
      else errors++;
    }

    if (!authError) {
      try {
        await fetchLive(cache, selected, force);
        if (cache.live.error) errors++;
      } catch (err) {
        authError = err;
      }
    }

    if (!authError) {
      try {
        await mapPool(selected, VOD_CONCURRENCY, async (id) => {
          const entry = await fetchChannelVods(cache, id, force);
          if (entry.error) errors++;
        });
      } catch (err) {
        authError = err;
      }
    }
  }

  await saveCache(cache);

  const { watched, resume } = await getStored(["watched", "resume"]);
  const inbox = buildInbox(cache, selected, settings, watched || {}, resume || {});
  await renderBadge(inbox.unread);

  if (authError) {
    return { ok: false, error: authError.code, ...inbox };
  }
  return { ok: true, errors, settings, ...inbox };
}

// Recompute the unread count from what is already cached (no network).
async function refreshBadgeFromCache() {
  const { accessToken, watched, resume } = await getStored(["accessToken", "watched", "resume"]);
  if (!accessToken) {
    await renderBadge(0);
    return;
  }
  const [selected, settings, cache] = await Promise.all([getSelectedChannels(), getSettings(), loadCache()]);
  const inbox = buildInbox(cache, selected, settings, watched || {}, resume || {});
  await renderBadge(inbox.unread);
}

/* ---------- watched / resume ---------- */

// watched: { [vodId]: msTimestamp }  (truthy = watched; the timestamp lets us prune)
// resume:  { [vodId]: { seconds, updatedAt } }
async function setWatched(ids, on) {
  const { watched } = await getStored(["watched"]);
  const next = { ...(watched || {}) };
  const now = Date.now();
  for (const id of ids) {
    if (on) next[id] = now;
    else delete next[id];
  }
  await setStored({ watched: next });
}

async function markAllRead() {
  const [selected, settings, cache] = await Promise.all([getSelectedChannels(), getSettings(), loadCache()]);
  const inbox = buildInbox(cache, selected, settings, {}, {});
  const ids = inbox.channels.flatMap((c) => c.vods.map((v) => v.id));
  await setWatched(ids, true);
  return ids.length;
}

// Drop watched / resume entries older than 90 days so storage does not grow forever.
async function pruneOld() {
  const { watched, resume } = await getStored(["watched", "resume"]);
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const w = {};
  for (const [id, at] of Object.entries(watched || {})) {
    // Legacy `true` values have no timestamp; stamp them now so they age out later.
    if (at === true) w[id] = Date.now();
    else if (typeof at === "number" && at >= cutoff) w[id] = at;
  }
  const r = {};
  for (const [id, val] of Object.entries(resume || {})) {
    if (val && typeof val === "object" && typeof val.seconds === "number" && (val.updatedAt || 0) >= cutoff) {
      r[id] = val;
    }
  }
  await setStored({ watched: w, resume: r });
}

/* ---------- opening a VOD ---------- */

function formatResume(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${m}m${sec}s`;
}

// Open https://www.twitch.tv/videos/<id>, resuming where the user left off,
// and mark it watched. chrome.tabs.create needs no extra permission.
async function openVod(id) {
  const { resume } = await getStored(["resume"]);
  const pos = resume && resume[id] ? resume[id].seconds : 0;
  let url = `https://www.twitch.tv/videos/${encodeURIComponent(id)}`;
  if (pos && pos > 5) url += `?t=${formatResume(pos)}`;
  await setWatched([id], true);
  await chrome.tabs.create({ url });
  await refreshBadgeFromCache();
  return url;
}

/* ---------- alarms / lifecycle ---------- */

function ensureAlarm() {
  chrome.alarms.get(REFRESH_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) getInbox(false).catch(() => {});
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  pruneOld();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  pruneOld();
});

// Badge text does not survive a browser restart; restore it whenever the
// worker spins up.
refreshBadgeFromCache().catch(() => {});
ensureAlarm();

// The content script marks VODs watched and the pages edit settings /
// selection directly in storage; keep the badge in step.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.watched || changes.selectedChannels || changes.settings || changes.authExpired) {
    refreshBadgeFromCache().catch(() => {});
  }
});

/* ---------- messages ---------- */

function reply(promise, sendResponse) {
  promise
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.code || String(err.message || err) }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "LOGIN":
      return reply(login().then(() => ({ ok: true })), sendResponse);

    case "LOGOUT":
      return reply(logout().then(() => ({ ok: true })), sendResponse);

    case "GET_STATUS":
      return reply(
        getStored(["connected", "authExpired", "userId", "userLogin", "userName", "userAvatar", "selectedChannels"]).then(
          (data) => ({
            ok: true,
            connected: !!data.connected,
            authExpired: !!data.authExpired,
            userId: data.userId || null,
            userLogin: data.userLogin || null,
            userName: data.userName || null,
            userAvatar: data.userAvatar || null,
            selectedCount: Array.isArray(data.selectedChannels) ? data.selectedChannels.length : 0,
          })
        ),
        sendResponse
      );

    // Follow list with avatars, for the channel picker.
    case "GET_FOLLOWED":
      return reply(
        (async () => {
          const follows = await fetchFollowedChannels();
          const cache = await loadCache();
          try {
            await ensureUsers(cache, follows.map((f) => f.id), !!message.force);
          } finally {
            await saveCache(cache);
          }
          const channels = follows.map((f) => {
            const u = cache.users[f.id] || {};
            return { id: f.id, login: u.login || f.login, name: u.name || f.name, avatar: u.avatar || "" };
          });
          channels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
          return { ok: true, channels };
        })(),
        sendResponse
      );

    case "SET_SELECTED":
      return reply(
        (async () => {
          const ids = [...new Set((message.ids || []).filter(Boolean))];
          await setStored({ selectedChannels: ids });
          return { ok: true, count: ids.length };
        })(),
        sendResponse
      );

    case "GET_INBOX":
      return reply(getInbox(!!message.force), sendResponse);

    case "GET_UNREAD":
      return reply(
        (async () => {
          const { accessToken, watched, resume } = await getStored(["accessToken", "watched", "resume"]);
          if (!accessToken) return { ok: false, error: "not_connected" };
          const [selected, settings, cache] = await Promise.all([getSelectedChannels(), getSettings(), loadCache()]);
          const inbox = buildInbox(cache, selected, settings, watched || {}, resume || {});
          return { ok: true, unread: inbox.unread, channels: inbox.channels.length };
        })(),
        sendResponse
      );

    case "MARK_WATCHED":
      return reply(setWatched(message.ids || [], message.watched !== false).then(() => ({ ok: true })), sendResponse);

    case "MARK_ALL_READ":
      return reply(markAllRead().then((count) => ({ ok: true, count })), sendResponse);

    case "OPEN_VOD":
      return reply(openVod(message.id).then((url) => ({ ok: true, url })), sendResponse);

    case "OPEN_APP":
      return reply(chrome.tabs.create({ url: chrome.runtime.getURL("app.html") }).then(() => ({ ok: true })), sendResponse);
  }
  return false;
});
