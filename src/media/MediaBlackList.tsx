import {YOUTUBE_ENABLED} from "~/media/SiteDownloader";

// Pages/resources where media detection is off. YouTube is not blacklisted (YOUTUBE_ENABLED): its
// watch/shorts pages get the "Download with WebDM (best)" row, which sends the
// page URL to the app (yt-dlp). Its own requests are never listed (see isPageOnlySite).
export const MEDIA_BLACKLIST_URLS: string[] = YOUTUBE_ENABLED ? [] : [
    "youtu.be",
    "*.youtube.com",
    "youtube.com",
]
