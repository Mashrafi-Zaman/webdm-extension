import urlMatch from "match-url-wildcard"
import {YOUTUBE_ENABLED} from "~/media/SiteDownloader";

/**
 * Popular sites the user can turn WebDM off for (options page, "Popular sites"). On a site that is off WebDM
 * does nothing: no download button, no media detection, no download capture, no selection popup.
 */
export type PopularSite = { id: string, name: string, patterns: string[] }

const SITES: PopularSite[] = [
    {id: "youtube", name: "YouTube", patterns: ["youtube.com", "*.youtube.com", "youtu.be", "youtube-nocookie.com", "*.youtube-nocookie.com"]},
    {id: "facebook", name: "Facebook", patterns: ["facebook.com", "*.facebook.com", "fb.watch", "*.fbcdn.net"]},
    {id: "instagram", name: "Instagram", patterns: ["instagram.com", "*.instagram.com", "*.cdninstagram.com"]},
    {id: "x", name: "X (Twitter)", patterns: ["x.com", "*.x.com", "twitter.com", "*.twitter.com", "*.twimg.com"]},
    {id: "tiktok", name: "TikTok", patterns: ["tiktok.com", "*.tiktok.com", "*.tiktokcdn.com"]},
    {id: "vimeo", name: "Vimeo", patterns: ["vimeo.com", "*.vimeo.com", "*.vimeocdn.com"]},
    {id: "dailymotion", name: "Dailymotion", patterns: ["dailymotion.com", "*.dailymotion.com", "*.dmcdn.net"]},
    {id: "reddit", name: "Reddit", patterns: ["reddit.com", "*.reddit.com", "*.redd.it"]},
    {id: "twitch", name: "Twitch", patterns: ["twitch.tv", "*.twitch.tv", "*.ttvnw.net"]},
]

/** the sites shown in the options page (YouTube only in builds that support it) */
export function popularSites(): PopularSite[] {
    return SITES.filter(site => site.id !== "youtube" || YOUTUBE_ENABLED)
}

/** URL patterns (match-url-wildcard) of the sites the user turned off */
export function disabledSitePatterns(disabledSiteIds: string[]): string[] {
    if (!disabledSiteIds.length) return []
    return SITES.filter(site => disabledSiteIds.includes(site.id)).flatMap(site => site.patterns)
}

/** Is WebDM turned off for the site of this URL? */
export function isSiteDisabled(url: string | undefined | null, disabledSiteIds: string[]): boolean {
    if (!url || !disabledSiteIds.length) return false
    try {
        return urlMatch(url, disabledSitePatterns(disabledSiteIds))
    } catch (e) {
        return false
    }
}
