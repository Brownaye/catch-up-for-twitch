// Catch Up for Twitch - resume-position tracker.
//
// Runs only on https://www.twitch.tv/videos/* pages. Every 15 seconds it
// reads the player's current time from the <video> element and saves it
// as the resume position for that VOD. Once playback passes 90% of the
// VOD, the VOD is marked watched. If there is no video element (or the
// page has navigated away from a VOD), it does nothing.

(() => {
  const TICK_MS = 15 * 1000;
  const WATCHED_AT = 0.9;      // fraction of the VOD that counts as "watched"
  const MIN_DELTA_S = 5;       // skip writes when the position barely moved
  const MIN_POSITION_S = 10;   // ignore the first few seconds (page still loading)

  let lastSaved = { id: null, seconds: -Infinity };

  function currentVodId() {
    const m = /^\/videos\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function findVideo() {
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      if (Number.isFinite(v.duration) && v.duration > 0) return v;
    }
    return null;
  }

  function tick() {
    const id = currentVodId();
    if (!id) return;
    const video = findVideo();
    if (!video) return;

    const seconds = Math.floor(video.currentTime);
    const duration = video.duration;
    if (!Number.isFinite(seconds) || seconds < MIN_POSITION_S) return;
    if (id === lastSaved.id && Math.abs(seconds - lastSaved.seconds) < MIN_DELTA_S) return;
    lastSaved = { id, seconds };

    const finished = Number.isFinite(duration) && duration > 0 && seconds / duration >= WATCHED_AT;

    try {
      chrome.storage.local.get(["resume", "watched"], (data) => {
        if (chrome.runtime.lastError) return;
        const resume = { ...(data.resume || {}) };
        resume[id] = { seconds, updatedAt: Date.now() };
        const update = { resume };
        if (finished) {
          const watched = { ...(data.watched || {}) };
          if (!watched[id]) {
            watched[id] = Date.now();
            update.watched = watched;
          }
          // Next open should start from the beginning rather than the credits.
          delete resume[id];
        }
        chrome.storage.local.set(update, () => void chrome.runtime.lastError);
      });
    } catch {
      // Extension was reloaded or uninstalled under this tab; go quiet.
    }
  }

  const timer = setInterval(() => {
    // Stop cleanly if the extension context has gone away.
    if (!chrome.runtime || !chrome.runtime.id) {
      clearInterval(timer);
      return;
    }
    tick();
  }, TICK_MS);

  // Save on tab close / navigation as well, so short sessions are not lost.
  window.addEventListener("pagehide", () => {
    lastSaved = { id: null, seconds: -Infinity };
    tick();
  });
})();
