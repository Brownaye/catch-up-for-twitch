// Catch Up for Twitch - resume-position tracker.
//
// Runs on every https://www.twitch.tv page (Twitch is a single-page app,
// so a VOD reached by in-site navigation never triggers a fresh load) but
// only acts while the URL is /videos/<id>. Every 15 seconds it reads the
// player's current time from the main <video> element and saves it as the
// resume position for that VOD. Once playback passes 90% of the VOD, the
// VOD is marked watched. Off a VOD page, or without a player, it does
// nothing.

(() => {
  const TICK_MS = 15 * 1000;
  const WATCHED_AT = 0.9;      // fraction of the VOD that counts as "watched"
  const MIN_DELTA_S = 5;       // skip writes when the position barely moved
  const MIN_POSITION_S = 10;   // ignore the first few seconds (page still loading)
  const MIN_DURATION_S = 60;   // shorter <video>s are ads / previews, not the VOD
  const RESUME_MAX = 500;      // keep storage bounded whatever the page does

  let lastSaved = { id: null, seconds: -Infinity };

  function currentVodId() {
    const m = /^\/videos\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // The main player, not a preview or ad element the page may also hold.
  function findVideo() {
    const inPlayer = document.querySelector('[data-a-target="video-player"] video, .video-player video');
    if (inPlayer && Number.isFinite(inPlayer.duration) && inPlayer.duration >= MIN_DURATION_S) return inPlayer;
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      if (Number.isFinite(v.duration) && v.duration >= MIN_DURATION_S && (!best || v.duration > best.duration)) best = v;
    }
    return best;
  }

  function capResume(resume) {
    const entries = Object.entries(resume);
    if (entries.length <= RESUME_MAX) return resume;
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    return Object.fromEntries(entries.slice(0, RESUME_MAX));
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
        const update = { resume: capResume(resume) };
        if (finished) {
          const watched = { ...(data.watched || {}) };
          if (!watched[id]) {
            watched[id] = Date.now();
            update.watched = watched;
          }
          // Next open should start from the beginning rather than the credits.
          delete resume[id];
          update.resume = capResume(resume);
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
  window.addEventListener("pagehide", (e) => {
    if (!e.isTrusted) return; // page scripts can dispatch fake events into this world
    lastSaved = { id: null, seconds: -Infinity };
    tick();
  });
})();
