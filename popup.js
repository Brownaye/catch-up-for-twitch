// Catch Up for Twitch - toolbar popup (launcher + quick settings).

const DEFAULT_SETTINGS = { lookbackDays: 7, sleepStart: "23:00", sleepEnd: "08:00" };

const els = {
  inboxSection: document.getElementById("inboxSection"),
  unread: document.getElementById("unread"),
  unreadLabel: document.getElementById("unreadLabel"),
  openBtn: document.getElementById("openBtn"),
  settingsSection: document.getElementById("settingsSection"),
  lookbackDays: document.getElementById("lookbackDays"),
  sleepStart: document.getElementById("sleepStart"),
  sleepEnd: document.getElementById("sleepEnd"),
  setup: document.getElementById("setup"),
  connectedView: document.getElementById("connectedView"),
  status: document.getElementById("status"),
};

let settings = { ...DEFAULT_SETTINGS };

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no_response" });
    });
  });
}

function saveSettings() {
  chrome.storage.local.set({ settings });
}

function renderSettings() {
  els.lookbackDays.value = settings.lookbackDays;
  els.sleepStart.value = settings.sleepStart;
  els.sleepEnd.value = settings.sleepEnd;
}

function setStatus(text, cls = "") {
  els.status.textContent = text;
  els.status.className = cls;
}

async function renderConnection(status) {
  const connected = !!status.connected;
  els.setup.style.display = connected ? "none" : "block";
  els.connectedView.style.display = connected ? "block" : "none";
  els.inboxSection.style.display = connected ? "block" : "none";
  els.settingsSection.style.display = connected ? "block" : "none";

  if (!connected) {
    setStatus(
      status.authExpired
        ? "Your Twitch login expired. Reconnect to keep catching up."
        : "Not connected yet. One quick Twitch login and your inbox fills up.",
      status.authExpired ? "err" : ""
    );
    return;
  }

  if (!status.selectedCount) {
    els.unread.textContent = "–";
    els.unread.classList.add("zero");
    els.unreadLabel.textContent = "no channels picked yet";
    els.openBtn.textContent = "Pick channels";
    setStatus(`Connected as ${status.userName || status.userLogin || "you"}.`);
    return;
  }

  els.openBtn.textContent = "Open Catch Up";
  const res = await send({ type: "GET_UNREAD" });
  const n = res.ok ? res.unread : 0;
  els.unread.textContent = String(n);
  els.unread.classList.toggle("zero", n === 0);
  els.unreadLabel.textContent =
    (n === 1 ? "unread VOD" : "unread VODs") + ` across ${status.selectedCount} channel${status.selectedCount === 1 ? "" : "s"}`;
  setStatus(`Connected as ${status.userName || status.userLogin || "you"}. Refreshes every 30 minutes.`);
}

/* load */
chrome.storage.local.get("settings", (data) => {
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  renderSettings();
});
send({ type: "GET_STATUS" }).then(renderConnection);

/* settings handlers */
els.lookbackDays.addEventListener("change", () => {
  let n = Math.round(Number(els.lookbackDays.value));
  if (!Number.isFinite(n)) n = DEFAULT_SETTINGS.lookbackDays;
  n = Math.min(60, Math.max(1, n));
  els.lookbackDays.value = n;
  settings.lookbackDays = n;
  saveSettings();
  send({ type: "GET_STATUS" }).then(renderConnection);
});
for (const [el, key] of [[els.sleepStart, "sleepStart"], [els.sleepEnd, "sleepEnd"]]) {
  el.addEventListener("change", () => {
    if (!el.value) el.value = DEFAULT_SETTINGS[key];
    settings[key] = el.value;
    saveSettings();
  });
}

/* launcher */
els.openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
  window.close();
});

/* connection handlers */
document.getElementById("connectBtn").addEventListener("click", async () => {
  setStatus("Opening Twitch login...");
  const res = await send({ type: "LOGIN" });
  if (res.ok) {
    const status = await send({ type: "GET_STATUS" });
    await renderConnection(status);
  } else {
    setStatus("Couldn't connect: " + (res.error || "unknown error"), "err");
  }
});

document.getElementById("disconnectBtn").addEventListener("click", async () => {
  await send({ type: "LOGOUT" });
  renderConnection({ connected: false });
});
