import {DownloadLinkInterceptor} from "~/linkgrabber/DownloadLinkInterceptor";
import {Manifest3DownloadLinkInterceptor} from "~/linkgrabber/Manifest3DownloadLinkInterceptor";
import {MediaRegistry} from "~/media/MediaRegistry";

/** Registers all request/download/tab listeners synchronously. */
export function redirectDownloadLinksToMe(): {
    mediaRegistry: MediaRegistry,
    interceptor: DownloadLinkInterceptor,
} {
    const downloadMediaRegistry = new MediaRegistry()
    downloadMediaRegistry.boot()
    const downloadLinkInterceptor: DownloadLinkInterceptor = new Manifest3DownloadLinkInterceptor()
    downloadLinkInterceptor.redirectDownloadsToExtension()
    downloadLinkInterceptor.setOnMediaDetectedListener(downloadMediaRegistry)
    return {
        mediaRegistry: downloadMediaRegistry,
        interceptor: downloadLinkInterceptor,
    }
}
