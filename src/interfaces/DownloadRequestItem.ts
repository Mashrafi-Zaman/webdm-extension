export interface DownloadRequestItem {
    link: string
    downloadPage: string | null
    headers: DownloadRequestHeaders | null
    description: string | null,
    suggestedName: string | null,
    type: "hls" | "http" | "segments" | "av" | "page"
    // type "segments" (a stream rebuilt from its segments; see REST-API.yml): ordered segment URLs,
    // init segment, and a separate audio track if the stream has one
    init?: string | null,
    segments?: string[],
    audioInit?: string | null,
    audioSegments?: string[],
    // type "segments": shown in the app's dialog
    duration?: number | null,
    estimatedSize?: number | null,
    quality?: string | null,
    // type "av" (separate video + audio files, merged by the app): file URLs and full sizes (sizes only when the
    // server answers Range requests)
    video?: string,
    audio?: string | null,
    videoSize?: number | null,
    audioSize?: number | null,
    // type "page" only, and only when the app allows it (capability "page.cookies"): that site's cookies
    cookies?: {
        name: string, value: string, domain: string, path: string,
        secure: boolean, httpOnly: boolean, expirationDate: number | null,
    }[],
}
export type DownloadRequestHeaders = Record<string, string>
