# WebDM Integration

The browser extension for [WebDM (Web Download Manager)](https://github.com/Mashrafi-Zaman/webdm), for Chromium
browsers (Chrome, Edge, Brave, Opera). Firefox is not supported.

## Usage

To use this extension you need the [WebDM app](https://github.com/Mashrafi-Zaman/webdm/releases/latest).

### This extension does the following

- Adds `Download with WebDM` to the browser's context menu
- Captures downloads (zip, exe, pdf, ...) and sends them to WebDM
- Shows a `Download selected` popup when you select part of a page that contains links
- Detects videos (direct files, HLS, streams rebuilt from segments, separate video + audio, players in iframes) and
  shows a download button with one entry per video and its qualities
- On video sites (YouTube, Facebook, Instagram ...) offers `Download with WebDM (best)`, which sends the page to the app
  (yt-dlp); you can turn WebDM off per site in the options

## How To Build

```bash
# install dependencies
npm i

# Chromium build (Chrome, Edge, Brave, Opera)
npm run pack:chrome

# Chrome Web Store build (YouTube support off)
npm run build:chrome-store
```

The extension is written to `./dist/chrome` (and `./dist/chrome.zip`); load it with "Load unpacked" in
`chrome://extensions` (developer mode).

## Repositories And Source Code

| Repository                                                                       | Description                                              |
|----------------------------------------------------------------------------------|----------------------------------------------------------|
| [WebDM](https://github.com/Mashrafi-Zaman/webdm)                                 | The **application** that runs on your **PC**             |
| [WebDM Integration](https://github.com/Mashrafi-Zaman/webdm-extension) (You are here) | The **browser extension** to install in your **browser** |

This extension is a modified fork of the
[AB Download Manager browser integration](https://github.com/amir1376/ab-download-manager-browser-integration) by
amir1376 (Apache License 2.0); see [NOTICE](NOTICE) and [LICENSE](LICENSE). It is not affiliated with or endorsed by the
AB Download Manager project.
