# Chrome Web Store listing text

## Description

Your favourite streamers go live while you're asleep. Twitch shows you a wall of past broadcasts and no way to tell which ones you've already seen.

Catch Up for Twitch turns that into an inbox. Pick the channels you care about, and the extension lists every VOD from the last few days in one place, marks what you've watched, and lets you jump back into a stream exactly where you left off.

WHAT YOU GET

• One row per channel, newest VOD first, with a purple dot until you've caught up
• Each row shows the latest unwatched VOD: thumbnail, title, when it aired in your local time, how long it ran, and how long ago
• "Catch up" opens the VOD in a new tab and resumes from where you stopped
• Expand a row to see every VOD in the window, each with its own Watch and Mark read buttons
• A red LIVE pill when a channel is streaming right now
• Filters: All, Missed while asleep (streams that overlapped your sleep hours), and Unread
• Toolbar badge with your unread count, refreshed every 30 minutes
• Look back from 1 to 60 days

PRIVACY

No servers, no tracking, no data collection. The extension talks only to Twitch's own API. Your Twitch login, channel list, settings and watch history stay in your browser, and uninstalling removes them. Full policy: https://github.com/Brownaye/catch-up-for-twitch/blob/main/PRIVACY.md

CONNECTING TWITCH

A one-time Twitch login is required because Twitch's API only answers authenticated requests. The extension asks for a single read-only permission (your follow list). It never sees your password, and you can revoke access at any time from your Twitch account's Connections page.

Made by the developer of Uptime Badges for Twitch. Open source: https://github.com/Brownaye/catch-up-for-twitch

Not affiliated with Twitch Interactive, Inc.

## Fields

Category:      Entertainment
Language:      English
Store icon:    icons/icon128.png
Screenshots:   store/screenshot-*.png (1280x800, take with DevTools, see README)
Small tile:    store/small-promo-tile.png
Marquee tile:  store/marquee-promo-tile.png
Official URL:  None
Homepage URL:  https://github.com/Brownaye/catch-up-for-twitch
Support URL:   https://github.com/Brownaye/catch-up-for-twitch/issues
Mature:        Off

## Privacy tab

Single purpose:
  Shows an inbox of recent VODs from Twitch channels you choose, with watched tracking and resume.

identity:
  Runs the Twitch OAuth login and receives the access token. Twitch's API only answers authenticated requests.
storage:
  Saves the user's chosen channels, settings, watched VODs and resume positions locally in the browser.
alarms:
  Wakes the extension every 30 minutes to refresh the unread count on the toolbar badge.
Host permissions:
  api.twitch.tv to read the follow list, each channel's VODs and live status; id.twitch.tv for the login; www.twitch.tv so a small script on VOD pages can save the playback position.
Remote code: No.

Data usage: tick "Authentication information" and "Website content".
  Certify: not sold, not used for purposes unrelated to the core function, not used for creditworthiness.
Privacy policy URL:
  https://github.com/Brownaye/catch-up-for-twitch/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public.  Regions: all.  Payments: free.
