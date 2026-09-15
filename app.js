// Catch Up for Twitch - extension page (channel picker + inbox).
//
// All Twitch traffic goes through the service worker; this file only
// renders what it gets back and writes settings / selections to storage.

const DEFAULT_SETTINGS = { lookbackDays: 7, sleepStart: "23:00", sleepEnd: "08:00" };

const $ = (id) => document.getElementById(id);
const els = {
  unreadPill: $("unreadPill"),
  inboxActions: $("inboxActions"),
  refreshBtn: $("refreshBtn"),
  markAllBtn: $("markAllBtn"),
  manageBtn: $("manageBtn"),
  settingsBtn: $("settingsBtn"),
  settingsPanel: $("settingsPanel"),
  lookbackDays: $("lookbackDays"),
  sleepStart: $("sleepStart"),
  sleepEnd: $("sleepEnd"),
  whoAmI: $("whoAmI"),
  disconnectBtn: $("disconnectBtn"),
  banner: $("banner"),
  bannerText: $("bannerText"),
  bannerAction: $("bannerAction"),
  bannerDismiss: $("bannerDismiss"),
  connectView: $("connectView"),
  connectBtn: $("connectBtn"),
  connectStatus: $("connectStatus"),
  pickerView: $("pickerView"),
  pickerSub: $("pickerSub"),
  pickerCancel: $("pickerCancel"),
  pickerSearch: $("pickerSearch"),
  selectAll: $("selectAll"),
  selectNone: $("selectNone"),
  pickerList: $("pickerList"),
  pickerCount: $("pickerCount"),
  pickerNext: $("pickerNext"),
  inboxView: $("inboxView"),
  inboxList: $("inboxList"),
  inboxEmpty: $("inboxEmpty"),
  countAsleep: $("countAsleep"),
  countUnread: $("countUnread"),
  countSaved: $("countSaved"),
  lastRefreshed: $("lastRefreshed"),
};

const state = {
  status: null,           // GET_STATUS result
  settings: { ...DEFAULT_SETTINGS },
  followed: [],           // picker: [{ id, login, name, avatar }]
  picked: new Set(),      // picker: ticked ids
  inbox: null,            // GET_INBOX result
  filter: "all",          // all | asleep | unread | saved
  expanded: new Set(),    // channel ids with the VOD list open
  caughtUpDismissed: false, // "You're caught up" block hidden via its Clear button until something new arrives
  loading: false,
};

/* ---------- messaging ---------- */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no_response" });
    });
  });
}

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStored(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

/* ---------- formatting (always the user's local timezone) ---------- */

const fmtStart = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const fmtStartWithYear = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fmtRelative = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatStart(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? fmtStart : fmtStartWithYear).format(d);
}

// 15153 -> "4h 12m"; 2700 -> "45m"; 40 -> "40s"
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return fmtRelative.format(-mins, "minute");
  const hours = Math.round(ms / 3600000);
  if (hours < 48) return fmtRelative.format(-hours, "hour");
  const days = Math.round(ms / 86400000);
  return fmtRelative.format(-days, "day");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const EXPIRY_SOON_MS = 48 * 3600 * 1000;
const EXPIRY_TITLE = "Estimated from Twitch's storage policy: 7 days for most channels, 14 for affiliates, 60 for partners.";

// { text, soon } for a VOD's estimated deletion, or null when unknown.
function expiryInfo(vod) {
  if (vod.gone) return { text: "Expired", soon: true, gone: true };
  if (!vod.expiresAt) return null;
  const ms = vod.expiresAt - Date.now();
  if (ms <= 0) return { text: "Expiring now", soon: true };
  const hours = Math.ceil(ms / 3600000);
  if (hours < 24) return { text: `Expires in ${plural(hours, "hour")}`, soon: true };
  const days = Math.ceil(ms / 86400000);
  return { text: `Expires in ${plural(days, "day")}`, soon: ms < EXPIRY_SOON_MS };
}

function savedCount() {
  return state.inbox && Array.isArray(state.inbox.saved) ? state.inbox.saved.length : 0;
}

/* ---------- "missed while asleep" ---------- */

function parseHHMM(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || "");
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

// True when the stream's live window (created_at -> created_at + duration)
// overlapped any sleep period, evaluated in local time. Sleep periods that
// cross midnight (23:00 -> 08:00) are handled by ending on the next day.
function overlapsSleep(vod, settings) {
  const start = Date.parse(vod.createdAt);
  if (!Number.isFinite(start)) return false;
  const end = start + Math.max(60, vod.duration || 0) * 1000;

  const sleepStart = parseHHMM(settings.sleepStart, 23 * 60);
  const sleepEnd = parseHHMM(settings.sleepEnd, 8 * 60);
  if (sleepStart === sleepEnd) return false;

  // Walk each local calendar day the stream touched (plus one either side).
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  const stop = end + 24 * 3600 * 1000;

  while (day.getTime() <= stop) {
    const s = new Date(day);
    s.setHours(Math.floor(sleepStart / 60), sleepStart % 60, 0, 0);
    const e = new Date(day);
    e.setHours(Math.floor(sleepEnd / 60), sleepEnd % 60, 0, 0);
    if (sleepEnd <= sleepStart) e.setDate(e.getDate() + 1);
    if (s.getTime() < end && e.getTime() > start) return true;
    day.setDate(day.getDate() + 1);
  }
  return false;
}

function vodMatchesFilter(vod) {
  if (state.filter === "unread") return !vod.watched;
  if (state.filter === "asleep") return overlapsSleep(vod, state.settings);
  return true;
}

/* ---------- views ---------- */

function showView(name) {
  els.connectView.hidden = name !== "connect";
  els.pickerView.hidden = name !== "picker";
  els.inboxView.hidden = name !== "inbox";
  els.inboxActions.hidden = name !== "inbox";
  if (name !== "inbox") els.settingsPanel.hidden = true;
  els.settingsBtn.setAttribute("aria-expanded", String(!els.settingsPanel.hidden));
}

function showBanner(text, actionLabel, onAction, kind = "err") {
  els.banner.className = `banner ${kind}`;
  els.bannerText.textContent = text;
  els.bannerAction.hidden = !actionLabel;
  els.bannerAction.textContent = actionLabel || "";
  els.bannerAction.onclick = onAction || null;
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

function setUnreadPill(n) {
  els.unreadPill.textContent = `${n} unread`;
  els.unreadPill.classList.toggle("zero", n === 0);
}

/* ---------- auth ---------- */

async function connect(button, statusEl) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Opening Twitch login…";
  if (statusEl) statusEl.textContent = "";
  const res = await send({ type: "LOGIN" });
  button.disabled = false;
  button.textContent = original;
  if (res.ok) {
    hideBanner();
    await boot();
  } else if (statusEl) {
    statusEl.textContent = "Couldn't connect: " + (res.error || "unknown error") + ". Please try again.";
  } else {
    showBanner("Couldn't reconnect: " + (res.error || "unknown error"), "Try again", () => connect(els.bannerAction));
  }
}

function showReconnectBanner() {
  showBanner("Your Twitch login expired.", "Reconnect", () => connect(els.bannerAction));
}

/* ---------- settings ---------- */

async function loadSettings() {
  const { settings } = await getStored(["settings"]);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  els.lookbackDays.value = state.settings.lookbackDays;
  els.sleepStart.value = state.settings.sleepStart;
  els.sleepEnd.value = state.settings.sleepEnd;
}

function saveSettings() {
  return setStored({ settings: state.settings });
}

els.lookbackDays.addEventListener("change", async () => {
  let n = Math.round(Number(els.lookbackDays.value));
  if (!Number.isFinite(n)) n = DEFAULT_SETTINGS.lookbackDays;
  n = Math.min(60, Math.max(1, n));
  els.lookbackDays.value = n;
  state.settings.lookbackDays = n;
  await saveSettings();
  loadInbox(false); // cache already holds up to 100 VODs; the worker just refilters
});

for (const [el, key] of [[els.sleepStart, "sleepStart"], [els.sleepEnd, "sleepEnd"]]) {
  el.addEventListener("change", async () => {
    if (!el.value) {
      el.value = DEFAULT_SETTINGS[key];
    }
    state.settings[key] = el.value;
    await saveSettings();
    renderInbox();
  });
}

els.settingsBtn.addEventListener("click", () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
  els.settingsBtn.setAttribute("aria-expanded", String(!els.settingsPanel.hidden));
  if (!els.settingsPanel.hidden) els.lookbackDays.focus();
});

els.disconnectBtn.addEventListener("click", async () => {
  await send({ type: "LOGOUT" });
  state.inbox = null;
  await boot();
});

function renderWhoAmI() {
  els.whoAmI.textContent = "";
  const s = state.status;
  if (!s || !s.connected) return;
  if (s.userAvatar) {
    const img = document.createElement("img");
    img.src = s.userAvatar;
    img.alt = "";
    els.whoAmI.appendChild(img);
  }
  els.whoAmI.appendChild(document.createTextNode(`Connected as ${s.userName || s.userLogin || "you"}`));
}

/* ---------- screen 1: channel picker ---------- */

let pickerLoaded = false;

async function openPicker(cancelable) {
  showView("picker");
  els.pickerCancel.hidden = !cancelable;
  els.pickerSearch.value = "";

  const { selectedChannels } = await getStored(["selectedChannels"]);
  state.picked = new Set(Array.isArray(selectedChannels) ? selectedChannels : []);

  if (!pickerLoaded) {
    els.pickerSub.textContent = "Loading your follows…";
    els.pickerList.textContent = "";
    const res = await send({ type: "GET_FOLLOWED" });
    if (!res.ok) {
      if (res.error === "unauthorized") showReconnectBanner();
      else if (res.error === "not_connected") return boot();
      else showBanner("Couldn't load your follow list (" + res.error + ").", "Retry", () => openPicker(cancelable));
      els.pickerSub.textContent = "Couldn't load follows.";
      return;
    }
    state.followed = res.channels;
    pickerLoaded = true;
  }
  // Drop ticks for channels no longer followed.
  const known = new Set(state.followed.map((c) => c.id));
  for (const id of [...state.picked]) if (!known.has(id)) state.picked.delete(id);

  els.pickerSub.textContent = `You follow ${plural(state.followed.length, "channel")}`;
  renderPickerList();
  els.pickerSearch.focus();
}

function pickerVisible() {
  const q = els.pickerSearch.value.trim().toLowerCase();
  if (!q) return state.followed;
  return state.followed.filter((c) => c.name.toLowerCase().includes(q) || c.login.toLowerCase().includes(q));
}

function renderPickerList() {
  const frag = document.createDocumentFragment();
  const visible = pickerVisible();
  for (const c of visible) {
    const li = document.createElement("li");
    const label = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.picked.has(c.id);
    cb.dataset.id = c.id;
    cb.addEventListener("change", () => {
      if (cb.checked) state.picked.add(c.id);
      else state.picked.delete(c.id);
      renderPickerCount();
    });

    const img = document.createElement("img");
    img.className = "avatar";
    img.loading = "lazy";
    img.alt = "";
    if (c.avatar) img.src = c.avatar;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    if (c.login && c.login.toLowerCase() !== c.name.toLowerCase()) {
      const login = document.createElement("span");
      login.className = "login";
      login.textContent = ` ${c.login}`;
      name.appendChild(login);
    }

    label.append(cb, img, name);
    li.appendChild(label);
    frag.appendChild(li);
  }
  els.pickerList.textContent = "";
  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.style.padding = "14px";
    li.textContent = state.followed.length ? "No channels match that search." : "You don't follow any channels yet.";
    frag.appendChild(li);
  }
  els.pickerList.appendChild(frag);
  renderPickerCount();
}

function renderPickerCount() {
  els.pickerCount.textContent = `${plural(state.picked.size, "channel")} selected`;
  els.pickerNext.disabled = state.picked.size === 0;
}

els.pickerSearch.addEventListener("input", renderPickerList);

els.selectAll.addEventListener("click", () => {
  // "Select all" applies to what is currently visible so a search can be used to bulk-tick.
  for (const c of pickerVisible()) state.picked.add(c.id);
  renderPickerList();
});

els.selectNone.addEventListener("click", () => {
  for (const c of pickerVisible()) state.picked.delete(c.id);
  renderPickerList();
});

els.pickerNext.addEventListener("click", async () => {
  els.pickerNext.disabled = true;
  els.pickerNext.textContent = "Saving…";
  await send({ type: "SET_SELECTED", ids: [...state.picked] });
  els.pickerNext.textContent = "Next";
  await openInbox(true);
});

els.pickerCancel.addEventListener("click", () => openInbox(false));

/* ---------- screen 2: inbox ---------- */

async function openInbox(force) {
  showView("inbox");
  await loadInbox(force);
}

async function loadInbox(force) {
  if (state.loading) return;
  state.loading = true;
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Refreshing…";
  if (!state.inbox) {
    els.inboxList.textContent = "";
    els.inboxEmpty.hidden = false;
    els.inboxEmpty.textContent = "Loading VODs…";
  }

  const res = await send({ type: "GET_INBOX", force: !!force });

  state.loading = false;
  els.refreshBtn.disabled = false;
  els.refreshBtn.textContent = "Refresh";

  if (!res.ok) {
    if (res.error === "unauthorized") {
      showReconnectBanner();
    } else if (res.error === "not_connected") {
      return boot();
    } else {
      showBanner("Couldn't reach Twitch (" + res.error + "). Showing what was cached.", "Retry", () => loadInbox(true));
    }
    // A partial inbox may still have been returned alongside the error.
    if (Array.isArray(res.channels)) state.inbox = res;
  } else {
    if (res.errors > 0) {
      showBanner(`Some channels couldn't be refreshed (${res.errors}). Showing cached VODs for those.`, "Retry", () => loadInbox(true), "warn");
    } else {
      hideBanner();
    }
    state.inbox = res;
    if (res.settings) state.settings = { ...state.settings, ...res.settings };
  }
  renderInbox();
}

function channelView(ch) {
  const visible = ch.vods.filter(vodMatchesFilter);
  const primary = visible.find((v) => !v.watched) || visible[0] || null;
  return { visible, primary, unread: visible.filter((v) => !v.watched).length };
}

function renderInbox() {
  const inbox = state.inbox;
  if (!inbox) return;

  const allVods = inbox.channels.flatMap((c) => c.vods);
  const unreadTotal = allVods.filter((v) => !v.watched).length;
  const asleepUnread = allVods.filter((v) => !v.watched && overlapsSleep(v, state.settings)).length;
  setUnreadPill(unreadTotal);
  if (unreadTotal > 0) state.caughtUpDismissed = false;
  els.countUnread.textContent = unreadTotal ? `(${unreadTotal})` : "";
  els.countAsleep.textContent = asleepUnread ? `(${asleepUnread})` : "";
  els.countSaved.textContent = savedCount() ? `(${savedCount()})` : "";
  els.markAllBtn.disabled = unreadTotal === 0;

  for (const chip of document.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === state.filter));
  }

  els.lastRefreshed.textContent = inbox.fetchedAt
    ? `Last refreshed ${fmtTime.format(new Date(inbox.fetchedAt))}. Refreshes in the background every 30 minutes.`
    : "";

  els.inboxList.classList.toggle("savedlist", state.filter === "saved");
  els.inboxList.setAttribute("aria-label", state.filter === "saved" ? "Saved VODs" : "Channels");
  if (state.filter === "saved") {
    renderSavedView();
    return;
  }

  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const ch of inbox.channels) {
    const view = channelView(ch);
    // Under a filter, hide channels with nothing that matches.
    if (state.filter !== "all" && view.visible.length === 0) continue;
    frag.appendChild(renderChannelRow(ch, view));
    shown++;
  }
  els.inboxList.textContent = "";
  els.inboxList.appendChild(frag);

  // Empty states.
  els.inboxEmpty.textContent = "";
  if (inbox.channels.length === 0) {
    els.inboxEmpty.hidden = false;
    els.inboxEmpty.append(
      emptyBlock("📺", "No channels picked yet", "Choose the channels you want to catch up on."),
      makeButton("Pick channels", () => openPicker(false))
    );
  } else if (unreadTotal === 0 && !state.caughtUpDismissed) {
    els.inboxEmpty.hidden = false;
    els.inboxEmpty.append(
      emptyBlock("✅", "You're caught up", `Nothing unwatched from the last ${plural(state.settings.lookbackDays, "day")}. Nice.`),
      makeButton("Clear", () => {
        state.caughtUpDismissed = true;
        renderInbox();
      }, "secondary")
    );
  } else if (shown === 0 && state.filter === "asleep") {
    els.inboxEmpty.hidden = false;
    els.inboxEmpty.append(emptyBlock("🌙", "Nothing streamed while you slept", `No unwatched VODs overlapped ${state.settings.sleepStart}–${state.settings.sleepEnd} in the last ${plural(state.settings.lookbackDays, "day")}.`));
  } else {
    els.inboxEmpty.hidden = true;
  }
}

/* ---------- saved for later ---------- */

function renderSavedView() {
  const list = state.inbox.saved || [];
  els.inboxList.textContent = "";
  els.inboxEmpty.textContent = "";
  if (list.length === 0) {
    els.inboxEmpty.hidden = false;
    els.inboxEmpty.append(
      emptyBlock("🔖", "Nothing saved yet", "Hit the bookmark on any VOD to keep it here until you've watched it, with a countdown to when Twitch deletes it.")
    );
    return;
  }
  els.inboxEmpty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const vod of list) {
    const ch = vod.channel || {};
    const li = document.createElement("li");
    li.dataset.id = vod.id;
    if (vod.gone) li.classList.add("gone");

    const who = document.createElement("div");
    who.className = "who";
    const img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.loading = "lazy";
    if (ch.avatar) img.src = ch.avatar;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ch.name || ch.login || "Channel";
    who.append(img, name);

    const controls = document.createElement("div");
    controls.className = "controls";
    if (!vod.gone) {
      const watch = makeButton(vod.watched ? "Watch again" : "Watch", () => openVod(vod, ch), vod.watched ? "secondary" : "");
      if (vod.resume > 5 && !vod.watched) watch.title = `Resume from ${formatDuration(vod.resume)}`;
      const mark = makeButton(vod.watched ? "Mark unread" : "Mark read", () => setWatched([vod.id], !vod.watched), "secondary");
      mark.setAttribute("aria-pressed", String(vod.watched));
      controls.append(watch, mark);
    }
    controls.appendChild(makeButton("Remove", () => toggleSaved(vod, ch), "secondary"));

    li.append(who, renderVod(vod, ch, true), controls);
    frag.appendChild(li);
  }
  els.inboxList.appendChild(frag);
}

const BOOKMARK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

function saveButton(vod, ch) {
  const b = makeButton("", () => toggleSaved(vod, ch), "icon save" + (vod.saved ? " on" : ""));
  b.innerHTML = BOOKMARK_SVG;
  b.setAttribute("aria-pressed", String(!!vod.saved));
  b.setAttribute("aria-label", vod.saved ? "Remove from saved" : "Save for later");
  b.title = vod.saved ? "Remove from saved" : "Save for later";
  return b;
}

// Flip the saved state locally first so the page never waits on storage.
async function toggleSaved(vod, ch) {
  const on = !vod.saved;
  applySaved(vod, ch, on);
  const channel = { id: ch.id, login: ch.login, name: ch.name, avatar: ch.avatar };
  const res = await send({ type: "SET_SAVED", id: vod.id, saved: on, vod, channel });
  if (!res.ok) {
    applySaved(vod, ch, !on);
    showBanner("Couldn't update saved VODs (" + res.error + ").", "", null);
  }
}

function applySaved(vod, ch, on) {
  if (!state.inbox) return;
  for (const c of state.inbox.channels) for (const v of c.vods) if (v.id === vod.id) v.saved = on;
  const list = state.inbox.saved || (state.inbox.saved = []);
  const i = list.findIndex((v) => v.id === vod.id);
  if (on && i === -1) {
    list.push({ ...vod, saved: true, savedAt: Date.now(), gone: 0, channel: { id: ch.id, login: ch.login, name: ch.name, avatar: ch.avatar } });
    list.sort((a, b) => (a.gone ? 1 : 0) - (b.gone ? 1 : 0) || a.expiresAt - b.expiresAt);
  } else if (!on && i !== -1) {
    list.splice(i, 1);
  }
  renderInbox();
}

function emptyBlock(icon, title, text) {
  const wrap = document.createElement("div");
  const big = document.createElement("div");
  big.className = "big";
  big.textContent = icon;
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  wrap.append(big, h, p);
  return wrap;
}

function makeButton(label, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

function renderChannelRow(ch, view) {
  const li = document.createElement("li");
  li.dataset.id = ch.id;
  const expanded = state.expanded.has(ch.id);

  const row = document.createElement("div");
  row.className = "chan" + (view.unread > 0 ? " has-unread" : "");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", String(expanded));
  row.setAttribute("aria-label", `${ch.name}, ${plural(view.unread, "unread VOD")}`);

  // Unread dot
  const dot = document.createElement("span");
  dot.className = "dot";
  row.appendChild(dot);

  // Avatar + name (+ LIVE pill)
  const who = document.createElement("div");
  who.className = "who";
  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.loading = "lazy";
  if (ch.avatar) img.src = ch.avatar;
  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = ch.name;
  meta.appendChild(name);
  if (ch.live) {
    const live = document.createElement("a");
    live.className = "tag live";
    live.href = `https://www.twitch.tv/${encodeURIComponent(ch.login || ch.live.login || "")}`;
    live.target = "_blank";
    live.rel = "noopener";
    live.textContent = "LIVE";
    live.title = [ch.live.title, ch.live.game, `${ch.live.viewers} viewers`].filter(Boolean).join(" · ");
    live.addEventListener("click", (e) => e.stopPropagation());
    meta.appendChild(live);
  } else if (ch.missing) {
    meta.appendChild(tag("Unavailable", "This channel could not be found on Twitch (deleted, renamed or banned)."));
  } else if (ch.fetched && !ch.everHadVods && !ch.error) {
    meta.appendChild(tag("VODs off", "This channel has no past broadcasts saved. They may have VODs turned off."));
  }
  who.append(img, meta);
  row.appendChild(who);

  // Middle: primary VOD, or the blank state
  if (view.primary) {
    row.appendChild(renderVod(view.primary, ch, false));
  } else {
    const none = document.createElement("span");
    none.className = "none";
    if (ch.error && !ch.fetched) none.textContent = "Couldn't load VODs";
    else if (ch.missing) none.textContent = "Channel unavailable";
    else if (ch.fetched && !ch.everHadVods) none.textContent = "No past broadcasts";
    else none.textContent = `No VODs in the last ${plural(state.settings.lookbackDays, "day")}`;
    row.appendChild(none);
  }

  // Right: Catch up + chevron
  const controls = document.createElement("div");
  controls.className = "controls";
  if (view.primary) {
    const btn = makeButton(view.primary.watched ? "Watch again" : "Catch up", () => openVod(view.primary, ch), view.primary.watched ? "secondary" : "");
    if (view.primary.resume > 5 && !view.primary.watched) btn.title = `Resume from ${formatDuration(view.primary.resume)}`;
    controls.appendChild(btn);
    controls.appendChild(saveButton(view.primary, ch));
  }
  const chev = makeButton("", () => toggleExpanded(ch.id), "icon chev");
  chev.setAttribute("aria-label", expanded ? "Collapse" : `Show all VODs for ${ch.name}`);
  chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  controls.appendChild(chev);
  row.appendChild(controls);

  row.addEventListener("click", () => toggleExpanded(ch.id));
  row.addEventListener("keydown", (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleExpanded(ch.id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...els.inboxList.querySelectorAll(".chan")];
      const i = rows.indexOf(row);
      const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) next.focus();
    }
  });

  li.appendChild(row);
  if (expanded) li.appendChild(renderVodList(ch, view));
  return li;
}

function tag(text, title) {
  const t = document.createElement("span");
  t.className = "tag muted";
  t.textContent = text;
  if (title) t.title = title;
  return t;
}

function renderVod(vod, ch, showTitleAttr) {
  const wrap = document.createElement("div");
  wrap.className = "vod" + (vod.watched ? " watched" : "");

  const tw = document.createElement("div");
  tw.className = "thumb-wrap";
  const isProcessing = !vod.thumbnail || vod.thumbnail.includes("404_processing") || vod.thumbnail.includes("_404/");
  if (vod.gone) {
    const ph = document.createElement("div");
    ph.className = "thumb placeholder";
    ph.textContent = "Expired";
    tw.appendChild(ph);
  } else if (isProcessing) {
    const ph = document.createElement("div");
    ph.className = "thumb placeholder";
    ph.textContent = ch.live ? "LIVE NOW" : "Processing";
    tw.appendChild(ph);
  } else {
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.loading = "lazy";
    img.src = vod.thumbnail;
    img.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "thumb placeholder";
      ph.textContent = "No preview";
      img.replaceWith(ph);
    });
    tw.appendChild(img);
  }
  const dur = document.createElement("span");
  dur.className = "dur";
  dur.textContent = formatDuration(vod.duration);
  tw.appendChild(dur);

  const info = document.createElement("div");
  info.className = "info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = vod.title || "(untitled)";
  title.title = vod.title || "";
  if (vod.watched) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓ ";
    tick.setAttribute("aria-label", "Watched");
    title.prepend(tick);
  }

  const line1 = document.createElement("div");
  line1.className = "line";
  // Helix has no category on VODs; use the live category when the VOD is the current stream.
  const game = ch.live && ch.live.title === vod.title ? ch.live.game : "";
  const parts = [];
  if (game) parts.push(game);
  parts.push(formatStart(vod.createdAt));
  parts.push(formatDuration(vod.duration));
  parts.push(formatAge(vod.createdAt));
  if (vod.resume > 5 && !vod.watched) parts.push(`resume at ${formatDuration(vod.resume)}`);
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      line1.appendChild(sep);
    }
    const s = document.createElement("span");
    s.textContent = p;
    line1.appendChild(s);
  });

  const exp = expiryInfo(vod);
  if (exp) {
    const sep = document.createElement("span");
    sep.className = "sep";
    const e = document.createElement("span");
    e.className = "expiry" + (exp.soon ? " soon" : "");
    e.textContent = exp.text;
    e.title = exp.gone ? "Twitch no longer has this VOD." : EXPIRY_TITLE;
    line1.append(sep, e);
  }

  info.append(title, line1);
  wrap.append(tw, info);
  return wrap;
}

function renderVodList(ch, view) {
  const ul = document.createElement("ul");
  ul.className = "vodlist";
  ul.setAttribute("aria-label", `VODs from ${ch.name}`);
  if (view.visible.length === 0) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = state.filter === "all" ? "No VODs in this window." : "No VODs match this filter.";
    li.appendChild(span);
    ul.appendChild(li);
    return ul;
  }
  for (const vod of view.visible) {
    const li = document.createElement("li");
    li.appendChild(renderVod(vod, ch, true));
    const controls = document.createElement("div");
    controls.className = "controls";
    const watch = makeButton("Watch", () => openVod(vod, ch), vod.watched ? "secondary" : "");
    if (vod.resume > 5 && !vod.watched) watch.title = `Resume from ${formatDuration(vod.resume)}`;
    const mark = makeButton(vod.watched ? "Mark unread" : "Mark read", () => setWatched([vod.id], !vod.watched), "secondary");
    mark.setAttribute("aria-pressed", String(vod.watched));
    controls.append(watch, mark, saveButton(vod, ch));
    li.appendChild(controls);
    ul.appendChild(li);
  }
  return ul;
}

function toggleExpanded(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderInbox();
  const row = els.inboxList.querySelector(`li[data-id="${CSS.escape(id)}"] .chan`);
  if (row) row.focus();
}

async function openVod(vod, ch) {
  applyWatched([vod.id], true);
  const res = await send({ type: "OPEN_VOD", id: vod.id });
  if (!res.ok) showBanner("Couldn't open the VOD (" + res.error + ").", "", null);
}

// Update local state immediately so the UI does not wait for storage.
function applyWatched(ids, on) {
  if (!state.inbox) return;
  const set = new Set(ids);
  for (const ch of state.inbox.channels) {
    for (const v of ch.vods) if (set.has(v.id)) v.watched = on;
    ch.unread = ch.vods.filter((v) => !v.watched).length;
  }
  for (const v of state.inbox.saved || []) if (set.has(v.id)) v.watched = on;
  renderInbox();
}

async function setWatched(ids, on) {
  applyWatched(ids, on);
  await send({ type: "MARK_WATCHED", ids, watched: on });
}

els.refreshBtn.addEventListener("click", () => loadInbox(true));

els.markAllBtn.addEventListener("click", async () => {
  if (!state.inbox) return;
  const ids = state.inbox.channels.flatMap((c) => c.vods.filter((v) => !v.watched).map((v) => v.id));
  if (ids.length === 0) return;
  await setWatched(ids, true);
});

els.manageBtn.addEventListener("click", () => openPicker(true));

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    state.filter = chip.dataset.filter;
    renderInbox();
  });
}

els.connectBtn.addEventListener("click", () => connect(els.connectBtn, els.connectStatus));
els.bannerDismiss.addEventListener("click", hideBanner);

// The content script marks VODs watched / saves resume positions while a
// VOD tab is open; reflect that here without a refetch.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !state.inbox) return;
  if (changes.watched) {
    const watched = changes.watched.newValue || {};
    for (const ch of state.inbox.channels) {
      for (const v of ch.vods) v.watched = !!watched[v.id];
      ch.unread = ch.vods.filter((v) => !v.watched).length;
    }
    for (const v of state.inbox.saved || []) v.watched = !!watched[v.id];
    renderInbox();
  }
  if (changes.resume) {
    const resume = changes.resume.newValue || {};
    for (const ch of state.inbox.channels) {
      for (const v of ch.vods) v.resume = resume[v.id] ? resume[v.id].seconds || 0 : 0;
    }
    for (const v of state.inbox.saved || []) v.resume = resume[v.id] ? resume[v.id].seconds || 0 : 0;
    renderInbox();
  }
  if (changes.authExpired && changes.authExpired.newValue) showReconnectBanner();
});

/* ---------- boot ---------- */

async function boot() {
  hideBanner();
  await loadSettings();
  state.status = await send({ type: "GET_STATUS" });
  renderWhoAmI();

  if (!state.status.connected) {
    setUnreadPill(0);
    showView("connect");
    if (state.status.authExpired) showReconnectBanner();
    return;
  }
  if (!state.status.selectedCount) {
    await openPicker(false);
    return;
  }
  await openInbox(false);
}

boot();
