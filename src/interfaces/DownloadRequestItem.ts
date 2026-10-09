export interface DownloadRequestItem {
    link: string
    downloadPage: string | null
    headers: DownloadRequestHeaders | null
    description: string | null,
    suggestedName: string | null,
    type: "hls" | "http" | "segments"
    // type "segments" (a stream rebuilt from its segments; see REST-API.yml): ordered segment URLs,
    // init segment, and a separate audio track if the stream has one
    init?: string | null,
    segments?: string[],
    audioInit?: string | null,
    audioSegments?: string[],
}
export type DownloadRequestHeaders = Record<string, string>
