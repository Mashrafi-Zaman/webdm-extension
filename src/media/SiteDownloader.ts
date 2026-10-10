/**
 * Sites the app's site downloader (yt-dlp, Prompt 10) handles well. For these the media list gets a
 * "Download with WebDM (best)" row that sends only the page URL ({type: "page"}).
 * Hidden until the app supports it.
 */
export const PAGE_DOWNLOAD_ENABLED = false

const SITE_DOWNLOADER_HOSTS = [
    "facebook.com", "fb.watch", "instagram.com", "youtube.com", "youtu.be", "x.com", "twitter.com",
    "tiktok.com", "vimeo.com", "dailymotion.com", "reddit.com", "twitch.tv",
]

export function isSiteDownloaderSite(pageUrl: string): boolean {
    try {
        const host = new URL(pageUrl).hostname.toLowerCase()
        return SITE_DOWNLOADER_HOSTS.some(h => host === h || host.endsWith("." + h))
    } catch (e) {
        return false
    }
}
