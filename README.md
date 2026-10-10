<div align="center">
  <img width="112" src="public/icons/icon-128.png" alt="WebDM logo">
</div>
<h1 align="center">WebDM Integration</h1>
<p align="center">The Chromium browser extension for <a href="https://github.com/Mashrafi-Zaman/webdm">WebDM (Web Download Manager)</a></p>
<p align="center">
  <a href="https://github.com/Mashrafi-Zaman/webdm-extension/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Mashrafi-Zaman/webdm-extension?color=FF6A3D&label=latest%20release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Mashrafi-Zaman/webdm-extension?color=172A46"></a>
  <img alt="Browsers" src="https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Opera-172A46">
</p>

WebDM Integration connects your browser to the WebDM desktop app. It hands downloads and videos over to WebDM, which
downloads them with multiple connections, merges video and audio, and keeps your download list in one place.

> **The extension does nothing on its own.** It needs the
> [WebDM app](https://github.com/Mashrafi-Zaman/webdm/releases/latest) (Windows 10/11 x64) installed and running.

## What it does

- **Captures downloads.** When the browser starts downloading a file type on your list (zip, rar, 7z, iso, exe, msi,
  pdf, mp3, mp4, mkv, ...), the download is cancelled in the browser and sent to WebDM. If the app doesn't answer, the
  browser keeps the download.
- **Right-click menu:** *Download with WebDM* for links, images, video and audio, and *Download selected links* for
  a selection that contains links (a small *Download selected* button also appears next to the selection).
- **Finds videos on the page** and shows a small floating WebDM button on the player, including players inside
  iframes. It lists one entry per video, with its qualities:
  - HLS streams (`.m3u8`), including AES-128 encrypted ones
  - plain video files (mp4, webm, ...)
  - streams the page plays from numbered segments without a playlist (rebuilt into one file)
  - players that load picture and sound as two separate files (DASH-style, e.g. Facebook), merged by the app
- **Video sites** (YouTube, Facebook, Instagram, X, TikTok, Vimeo, ...): adds *Download with WebDM (best)*, which
  sends only the page address to the app; the app reads it with yt-dlp and lets you pick the quality.
- **Per-site switches** in the options: turn WebDM off completely on popular sites, or add your own URL patterns.

DRM-protected streams (Widevine, PlayReady, FairPlay) are not supported and never will be.

## Supported browsers

Chrome, Microsoft Edge, Brave, Opera and other Chromium-based browsers (Manifest V3). Firefox is not supported.

## Installation

The extension is not in the Chrome Web Store; install it from the release zip:

1. Download `WebDM_Extension_<version>_chromium.zip` from the
   [WebDM releases](https://github.com/Mashrafi-Zaman/webdm/releases/latest) (it is also attached to this
   repository's releases).
2. Unzip it to a folder you will keep, for example `C:\Users\<you>\WebDM Extension`. The browser loads the extension
   from that folder every time it starts, so don't delete or move it.
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`, Opera: `opera://extensions`).
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Pin WebDM Integration to the toolbar and click its icon. With the WebDM app running, the popup says it is
   connected.

**Why not a `.crx` file?** On Windows, Chrome and Edge only allow `.crx` extensions installed from their own stores
(or pushed by company policy); a `.crx` file from anywhere else is blocked or disabled. *Load unpacked* is the
supported way to run an extension from outside the store. All release builds share the same extension ID
(`aciclgnjjaijdpnkkgileppmbpldobjj`), which is the ID the app trusts for native messaging.

**Updating:** unzip the new version over the same folder, then click the reload button of WebDM Integration on the
extensions page. If the browser asks on startup whether to disable developer-mode extensions, keep it enabled.

## Permissions and why they are needed

| Permission                                         | Used for                                                                                                     |
|----------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Access to all sites (`*://*/*`) and content scripts | Showing the download button and the *Download selected* button on any page; finding players, also in iframes |
| `webRequest`                                       | Seeing which media requests (playlists, segments, video files) and file downloads a page makes                |
| `downloads`                                        | Cancelling a browser download that was handed over to WebDM                                                   |
| `cookies`                                          | Passing a download's cookies to WebDM so files behind a login still work (video pages: only if you allow it)  |
| `declarativeNetRequestWithHostAccess`              | Adding the page's Referer/Origin to the extension's own playlist requests; many video servers require them    |
| `scripting`                                        | Adding WebDM to tabs that were already open when the extension was installed or reloaded                       |
| `tabs`                                             | Reading the tab's address and title (download page and video name)                                             |
| `contextMenus`                                     | The *Download with WebDM* entries in the right-click menu                                                      |
| `nativeMessaging`                                  | Talking to the WebDM app through its native messaging host (`com.webdm.app`)                                   |
| `storage`                                          | Your extension settings, and the videos found in each open tab                                                 |
| `notifications`                                    | The "download added" notice when silent add is on                                                              |

## Privacy

WebDM Integration has no analytics, no telemetry, no accounts and no server of its own.

- **Sent to the WebDM app on your computer, and nowhere else:** when you download something, the extension sends the
  link, the page address and title, the request headers the site expects (Cookie, Referer, User-Agent) and, for
  videos, the playlist or segment addresses. They go to `http://localhost:<port>` (15515 by default) or through
  native messaging to the app installed on the same machine.
- **Video pages:** for *Download with WebDM (best)*, the site's cookies are attached only if you turned on
  *Use browser cookies* in the app (Settings → Tools). The app uses them to read that page and doesn't save them.
- **Requests to the sites you visit:** to list qualities and sizes, the extension reads the same playlists and checks
  the size of the same video files the page is already playing, from the same servers.
- **Stored in your browser:** settings in `storage.local`; the videos found in each tab in `storage.session`, which
  the browser clears when it restarts. The optional detection log (toolbar popup, for bug reports) stays in the
  browser until you export it, and cookie and authorization values are replaced with `[redacted]`.

## Build from source

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run pack:chrome
```

The unpacked extension is written to `dist/chrome` and the zip to `dist/chrome.zip`. Load `dist/chrome` with
**Load unpacked** as described above; `npm run watch:chrome` rebuilds it on every change.

## Repositories

| Repository                                                                            | Description                   |
|---------------------------------------------------------------------------------------|-------------------------------|
| [WebDM](https://github.com/Mashrafi-Zaman/webdm)                                      | The desktop app (Windows x64) |
| [WebDM Integration](https://github.com/Mashrafi-Zaman/webdm-extension) (you are here) | The browser extension         |

Bugs and ideas: [WebDM issues](https://github.com/Mashrafi-Zaman/webdm/issues).

## License and credits

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

WebDM Integration is a modified fork of the
[AB Download Manager browser integration](https://github.com/amir1376/ab-download-manager-browser-integration) by
amir1376. It is not affiliated with or endorsed by the AB Download Manager project.
