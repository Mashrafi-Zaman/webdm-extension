/**
 * Video pages the app's site downloader (yt-dlp) handles well. For these the media list gets a
 * "Download with WebDM (best)" row that sends only the page URL ({type: "page"}); it is shown only when the app
 * supports "page" jobs.
 */

// YouTube support (removed from the media blacklist, page button on watch/shorts). Off for a Chrome Web Store build:
// `npm run build:chrome-store` sets WEBDM_STORE_BUILD=1.
export const YOUTUBE_ENABLED = process.env.WEBDM_STORE_BUILD !== "1"

type SitePattern = { hosts: string[], path: RegExp, pageOnly?: boolean }

const VIDEO_PAGES: SitePattern[] = [
    // pageOnly: nothing else WebDM detects on these pages is useful (YouTube's own requests are pieces of streams)
    {hosts: ["youtube.com"], path: /^\/(watch|shorts\/[^/]+|live\/[^/]+)/, pageOnly: true},
    {hosts: ["youtu.be"], path: /^\/[\w-]{6,}/, pageOnly: true},
    {hosts: ["facebook.com"], path: /^\/(reel\/|watch\/?|share\/[rv]\/|[^/]+\/videos\/|video\.php)/},
    {hosts: ["fb.watch"], path: /^\/[\w-]+/},
    {hosts: ["instagram.com"], path: /^\/(reels?|p|tv)\/[\w-]+/},
    {hosts: ["x.com", "twitter.com"], path: /^\/[^/]+\/status\/\d+/},
    {hosts: ["tiktok.com"], path: /^\/@[^/]+\/video\/\d+/},
    {hosts: ["vimeo.com"], path: /^\/\d+/},
    {hosts: ["dailymotion.com"], path: /^\/video\//},
    {hosts: ["reddit.com"], path: /^\/r\/[^/]+\/comments\//},
    {hosts: ["twitch.tv"], path: /^\/(videos\/\d+|[^/]+\/clip\/)/},
]

function matchPage(pageUrl: string): SitePattern | null {
    try {
        const url = new URL(pageUrl)
        const host = url.hostname.toLowerCase()
        const site = VIDEO_PAGES.find(p => p.hosts.some(h => host === h || host.endsWith("." + h)))
        if (!site || !site.path.test(url.pathname + (url.pathname === "/watch" ? url.search : ""))) return null
        if (!YOUTUBE_ENABLED && site.hosts.some(h => h.startsWith("youtu"))) return null
        return site
    } catch (e) {
        return null
    }
}

/** Is this a single video's page that yt-dlp can download ("Download with WebDM (best)")? */
export function isVideoPage(pageUrl: string): boolean {
    return matchPage(pageUrl) !== null
}

/** On these pages only the page row is listed (e.g. YouTube) */
export function isPageOnlySite(pageUrl: string): boolean {
    return matchPage(pageUrl)?.pageOnly === true
}
