# Catch Up for Twitch — notes for future sessions

Chrome extension (Manifest V3) that shows an inbox of recent VODs for the
Twitch channels the user has ticked. Sibling of **Uptime Badges for Twitch**
(`../uptime-badges-for-twitch`, also on GitHub at
`Brownaye/uptime-badges-for-twitch`); the two must look and behave like a
matched pair.

## Hard rules

- **No build step.** The folder is loaded directly via `chrome://extensions`
  → Load unpacked. No npm, no bundler, no TypeScript, no frameworks. Vanilla
  JS / HTML / CSS only, and nothing may require a compile step.
- **Match the Uptime Badges theme.** All colours, radii and the font come
  from `theme.css` variables (`--bg`, `--panel`, `--accent`, `--live`, …).
  Do not hard-code colours in pages; add a variable if one is missing.
  Layout primitives are the same: bold 14px `<header>` with a 1px bottom
  border, stacked `.section` blocks, `.row` flex lines (label left, control
  right), purple primary buttons, `.secondary` panel buttons.
- **Only ever talk to Twitch.** `api.twitch.tv` and `id.twitch.tv` (plus the
  content script on `www.twitch.tv/videos/*`). No other hosts, no analytics,
  no remote code.
- **Minimal permissions.** `identity`, `storage`, `alarms` and the three
  Twitch hosts. No `tabs` permission — `chrome.tabs.create` works without it.
- **All times in the user's local timezone** via `Intl.DateTimeFormat` /
  `Intl.RelativeTimeFormat`. Never assume AEST or any fixed offset.
- **Accessible.** Real `<button>`s, keyboard-navigable rows (Enter/Space to
  expand, arrow keys to move), visible `:focus-visible` outlines.
- **Do not change the `key` field in `manifest.json`.** It is the Chrome
  Web Store's public key for this item, so load-unpacked and store installs
  share the extension ID `cmlhgkcghkodgadoibcgfkmkjkjcnagm`, which is the
  OAuth redirect URL registered in the Twitch app. The private half is held
  by the Web Store; there is no local .pem to manage.

## Architecture

```
background.js   service worker: OAuth, helixGet(), cache, alarm, badge, messages
app.html/js     one page, two views: #pickerView (screen 1) and #inboxView (screen 2);
                the Saved chip swaps #inboxList into a flat list (class .savedlist)
popup.html/js   320px launcher + quick settings
welcome.html/js first-run page (opened on install)
content.js      on twitch.tv/videos/*: saves resume position every 15s, marks watched at 90%
theme.css       shared variables + primitives
icons/          PNGs + make-icons.ps1 (System.Drawing, no dependencies)
```

Pages never call Twitch directly. They send messages to the worker
(`LOGIN`, `LOGOUT`, `GET_STATUS`, `GET_FOLLOWED`, `SET_SELECTED`,
`GET_INBOX {force}`, `GET_UNREAD`, `MARK_WATCHED`, `MARK_ALL_READ`,
`SET_SAVED {id, saved, vod, channel}`, `OPEN_VOD`, `OPEN_APP`) and read/write `chrome.storage.local` for settings.
The worker's `buildInbox()` is a pure function of (cache, selected channels,
settings, watched, resume, saved) so the badge and the page always agree. It
returns `channels` (grouped inbox) and `saved` (flat list, soonest to expire
first, expired last).

### Twitch details worth remembering

- OAuth is the implicit grant through `chrome.identity.launchWebAuthFlow`,
  scope `user:read:follows` only. Client ID is registered as
  "Catch Up VOD Inbox" (Twitch rejects app names containing "Twitch").
- On 401: try a silent (non-interactive) re-auth once; if that fails set
  `authExpired`, show a red "!" badge and a Reconnect banner.
- `/videos` returns **no game/category**. The UI only shows a game when the
  VOD is the stream that is live right now (from `/streams`).
- `/videos` is fetched with `first=100` per channel (one request) so a
  60-day window is covered. Filtering to the lookback window happens in
  `buildInbox`, so changing the window never refetches.
- Thumbnail URLs are templates (`%{width}x%{height}`); a VOD still being
  recorded has a `404_processing` placeholder.
- Duration strings look like `4h12m33s`, `47m2s`, `58s`.
- Deleted/banned channels: `/users` omits them (recorded as `missing`),
  `/videos` may 404 (recorded as `unavailable`).
- **VOD expiry is an estimate**: `created_at` + 7 days (regular), 14
  (affiliate) or 60 (partner) from `/users` `broadcaster_type`, stored as
  `type` on the user cache entry. Prime/Turbo channels also get 60 days but
  Helix cannot tell us, so "" is treated as a 7-day floor. User cache entries
  without `type` are refetched.
- `/videos?id=a&id=b` (100 max) silently drops ids it cannot find and 404s
  when none exist; `verifySaved()` uses that to stamp `gone` on saved VODs.
  It runs on every inbox refresh, gated by `cache.savedCheckedAt` + the
  5-minute TTL.

## Storage schema (`chrome.storage.local`)

```
accessToken, connected, authExpired, authBannerDismissed   // as in Uptime Badges
userId, userLogin, userName, userAvatar
selectedChannels: string[]                                 // broadcaster IDs
settings: { lookbackDays: 7, sleepStart: "23:00", sleepEnd: "08:00" }
watched:  { [vodId]: msTimestamp }        // truthy = watched; timestamp enables 90-day pruning
resume:   { [vodId]: { seconds, updatedAt } }
saved:    { [vodId]: { savedAt, channelId, vod: <normalizeVod()>,      // "Save for later"; snapshot so it
                       channel: { login, name, avatar, type }, gone? } } // outlives the window / untick
cache:    { users: { [id]: {id, login, name, avatar, fetchedAt, missing?} },
            vods:  { [channelId]: { fetchedAt, items, everHadVods, error?, unavailable? } },
            live:  { fetchedAt, byId: { [channelId]: { startedAt, title, game, viewers, login } } } }
```

Cache TTLs: VODs and live 5 minutes, users 24 hours. `watched` and `resume`
entries older than 90 days are pruned on install/startup; `saved` entries
that have been `gone` for 30 days are dropped too.

## Releasing

Two different zips, both built into `dist/` (gitignored):

- **Store upload** (`…-store.zip`): extension files at the zip root with the
  manifest `key` line removed, per Google's flow. Uploaded on the dashboard's
  Package tab.
- **GitHub release** (`catch-up-for-twitch-<ver>.zip`): a top-level
  `catch-up-for-twitch/` folder with the `key` kept, plus README and PRIVACY.
  Loaded unpacked it gets the store's extension ID, so Twitch login works.
  Published with `gh release create v<ver> dist/<zip> --latest`.

Bump `version` in manifest.json before either; the store rejects a version
that is not higher than the last upload.

## Testing

Load unpacked, open the service-worker console from `chrome://extensions`,
and use `chrome.runtime.sendMessage({type: "GET_INBOX", force: true}, console.log)`
to inspect raw data. Reload the extension after every code change.
