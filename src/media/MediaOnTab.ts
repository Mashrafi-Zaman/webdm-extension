import browser from "webextension-polyfill";
import {InterceptedMediaResult, InterceptedMediaType} from "~/linkgrabber/LinkGrabberResponse";
import {inRange} from "~/utils/NumberUtils";
import {run} from "~/utils/ScopeFunctions";
import {MasterPlaylist, MediaPlaylist} from "hls-parser/types";
import * as HLSUtils from "~/media/HLSUtils";
import * as MultiMediaUtils from "~/media/MultiMediaUtils"
import _ from "lodash";
import HLS from "hls-parser"
import {getContentDisposition, getContentLength, getContentType} from "~/utils/HeaderUtils";
import {getFileExtension, getFileFromUrl, getFileNameWithoutExtension} from "~/utils/URLUtils";
import {getFileNameFromHeader} from "~/utils/ExtractFileNameFromHeader";
import {TabMediaStore} from "~/media/TabMediaStore";

// ---------- persisted (serializable) per-tab state ----------

type HeadersRecord = Record<string, string>

type HttpMediaEntry = {
    kind: "http",
    url: string,
    requestHeaders: HeadersRecord,
    name?: string,
    extension: string,
    size?: number,
}

export type HLSVariantInfo = {
    url: string, // absolute
    bandwidth?: number,
    width?: number,
    height?: number,
    frameRate?: number,
}

type HLSMasterEntry = {
    kind: "hls-master",
    url: string,
    requestHeaders: HeadersRecord,
    // null = the master's content is not known (yet / any more) and must be fetched
    variants: HLSVariantInfo[] | null,
    isEncrypted?: boolean,
}

type HLSMediaPlaylistEntry = {
    kind: "hls-media",
    url: string,
    requestHeaders: HeadersRecord,
    extension?: string,
    duration?: number,
    isEncrypted?: boolean,
    isSupported: boolean,
}

type MediaEntry = HttpMediaEntry | HLSMasterEntry | HLSMediaPlaylistEntry

export type TabMediaState = {
    entries: Record<string, MediaEntry>,
}

export function emptyTabMediaState(): TabMediaState {
    return {entries: {}}
}

// ---------- what the content script receives ----------

export type DownloadableMediaQuality = {
    label: string, // e.g. "1080p"
    uri: string,
    requestHeaders?: Record<string, string>,
    displayName: string,
    suggestedFullName: string,
    duration?: string,
    bandwidth?: string,
    resolution?: string,
    extension?: string,
}

export type DownloadableMedia = {
    type: InterceptedMediaType,
    uri: string,
    requestHeaders?: Record<string, string>,
    displayName?: string
    suggestedFullName?: string,
    duration?: string,
    bandwidth?: string,
    resolution?: string,
    extension?: string,
    size?: string,
    // for HLS master playlists: one entry per video, best quality first (uri/displayName above = qualities[0])
    qualities?: DownloadableMediaQuality[],
}

export interface OnMedialListUpdated {
    onListUpdated(list: DownloadableMedia[]): void;
}

function headersToRecord(headers: Headers): HeadersRecord {
    const record: HeadersRecord = {}
    headers.forEach((value, key) => {
        record[key] = value
    })
    return record
}

/**
 * Detected media of one tab. State is persisted in [TabMediaStore] (storage.session) so it survives
 * MV3 service-worker restarts; it's cleared when the tab navigates or closes.
 */
export class MediaOnTab {
    private state: TabMediaState = emptyTabMediaState()
    private generation = 0 // bumped on reset, so results of an old page are dropped
    private readonly inFlight = new Set<string>()
    private readonly failed = new Set<string>()
    private isClosed = false

    public constructor(
        public readonly tabId: number,
        private readonly onMediaListUpdated: OnMedialListUpdated,
        private readonly store: TabMediaStore,
    ) {
    }

    /** Load persisted state, then finish any HLS work that was interrupted (e.g. by a service-worker restart). */
    async restore() {
        this.state = await this.store.load(this.tabId) ?? emptyTabMediaState()
        const generation = this.generation
        const pending: Promise<void>[] = []
        for (const entry of Object.values(this.state.entries)) {
            if (entry.kind !== "hls-master") continue
            if (entry.variants === null) {
                // master playlist data was lost: fetch it again
                pending.push(this.processHLS(entry.url, entry.requestHeaders, generation))
                continue
            }
            for (const variant of entry.variants) {
                if (!this.state.entries[variant.url]) {
                    pending.push(this.processHLS(variant.url, entry.requestHeaders, generation))
                }
            }
        }
        await Promise.all(pending)
    }

    close(): void {
        this.isClosed = true
        this.reset()
    }

    reset() {
        this.generation++
        this.state = emptyTabMediaState()
        this.inFlight.clear()
        this.failed.clear()
    }

    async process(mediaResult: InterceptedMediaResult) {
        const generation = this.generation
        switch (mediaResult.mediaType) {
            case "hls":
                await this.processHLS(mediaResult.url, headersToRecord(mediaResult.requestHeaders), generation)
                break
            case "http":
                await this.processHttp(mediaResult.url, mediaResult.requestHeaders, mediaResult.responseHeaders, generation)
                break
        }
    }

    private isStale(generation: number) {
        return this.isClosed || generation !== this.generation
    }

    private async processHttp(
        url: string, requestHeaders: Headers, responseHeaders: Headers, generation: number,
    ) {
        if (this.state.entries[url]) {
            return
        }
        let filenameWithExtension: string | null = null;
        let extension: string | null = null;
        const contentDisposition = getContentDisposition(responseHeaders);
        if (contentDisposition) {
            filenameWithExtension = getFileNameFromHeader(contentDisposition)
        }
        if (!filenameWithExtension) {
            filenameWithExtension = getFileFromUrl(url)
        }
        if (filenameWithExtension) {
            extension = getFileExtension(filenameWithExtension)
        }
        if (!extension) {
            const contentType = getContentType(responseHeaders)
            if (contentType) {
                extension = MultiMediaUtils.getExtensionFromContentType(contentType)
            }
        }
        if (!extension) {
            // no extension ignore it
            return
        }
        const entry: HttpMediaEntry = {
            kind: "http",
            url: url,
            requestHeaders: headersToRecord(requestHeaders),
            extension: extension,
            name: filenameWithExtension ? getFileNameWithoutExtension(filenameWithExtension) : undefined,
            size: getContentLength(responseHeaders) ?? undefined,
        }
        await this.commit(generation, entry)
    }

    private async processHLS(url: string, requestHeaders: HeadersRecord, generation: number): Promise<void> {
        const existing = this.state.entries[url]
        if (existing && !(existing.kind === "hls-master" && existing.variants === null)) {
            return // already known
        }
        if (this.inFlight.has(url) || this.failed.has(url)) {
            return
        }
        this.inFlight.add(url)
        try {
            const content = await fetchHLSText(url, requestHeaders)
            if (this.isStale(generation)) return
            const playlist = content === null ? null : parseHLS(content)
            if (playlist === null) {
                this.failed.add(url)
                return
            }
            if (playlist.isMasterPlaylist) {
                await this.onMasterPlaylist(url, requestHeaders, playlist, generation)
            } else {
                await this.onMediaPlaylist(url, requestHeaders, playlist, generation)
            }
        } finally {
            this.inFlight.delete(url)
        }
    }

    private async onMasterPlaylist(url: string, requestHeaders: HeadersRecord, playlist: MasterPlaylist, generation: number) {
        const variants: HLSVariantInfo[] = _.uniqBy(
            playlist.variants.map((variant) => ({
                // variant URIs are usually relative to the master playlist; store them absolute
                url: resolveUrl(variant.uri, url),
                bandwidth: variant.bandwidth,
                width: variant.resolution?.width,
                height: variant.resolution?.height,
                frameRate: variant.frameRate,
            })),
            v => v.url,
        )
        const entry: HLSMasterEntry = {
            kind: "hls-master",
            url: url,
            requestHeaders: requestHeaders,
            variants: variants,
            isEncrypted: HLSUtils.isPlayListEncrypted(playlist),
        }
        await this.commit(generation, entry)
        if (entry.isEncrypted) {
            return
        }
        // fetch each variant (media playlist) to learn duration / segment type / encryption
        await Promise.all(variants.map(v => this.processHLS(v.url, requestHeaders, generation)))
    }

    private async onMediaPlaylist(url: string, requestHeaders: HeadersRecord, playlist: MediaPlaylist, generation: number) {
        if (playlist.segments.length == 0) {
            return // empty list?
        }
        const filename = getFileFromUrl(resolveUrl(playlist.segments[0].uri, url))
        const extension = filename ? getFileExtension(filename) : undefined
        const entry: HLSMediaPlaylistEntry = {
            kind: "hls-media",
            url: url,
            requestHeaders: requestHeaders,
            extension: extension ?? undefined,
            duration: _.sumBy(playlist.segments, segment => segment.duration),
            isEncrypted: HLSUtils.isMediaPlayListEncrypted(playlist),
            isSupported: extension === "ts", // we only support ts files for now
        }
        await this.commit(generation, entry)
    }

    private async commit(generation: number, entry: MediaEntry) {
        if (this.isStale(generation)) {
            return
        }
        this.state.entries[entry.url] = entry
        await this.store.save(this.tabId, this.state)
        await this.publish()
    }

    /** Send the current list to the tab's content script. */
    async publish() {
        if (this.isClosed) {
            return
        }
        const tab = await this.getTab()
        const tabTitle = tab?.title
        const tabUrl = tab?.url
        if (!tabTitle || !tabUrl) {
            return
        }
        this.onMediaListUpdated.onListUpdated(
            buildDownloadableMediaList(this.state, {pageTitle: tabTitle, pageUrlHash: shortSafeHash(tabUrl, 6)})
        )
    }

    private async getTab() {
        try {
            return (await browser.tabs.get(this.tabId))
        } catch (e) {
            return null
        }
    }
}

// ---------- building the list shown to the user ----------

type PageInfo = { pageTitle: string, pageUrlHash: string }

export function buildDownloadableMediaList(state: TabMediaState, pageInfo: PageInfo): DownloadableMedia[] {
    const entries = Object.values(state.entries)
    const variantUrls = new Set<string>()
    const result: DownloadableMedia[] = []

    for (const entry of entries) {
        if (entry.kind !== "hls-master" || !entry.variants) continue
        entry.variants.forEach(v => variantUrls.add(v.url))
        if (entry.isEncrypted) continue
        const qualities = createQualities(entry, state, pageInfo)
        if (qualities.length == 0) continue // variants are still being processed
        const best = qualities[0]
        result.push({
            type: "hls",
            uri: best.uri,
            requestHeaders: best.requestHeaders,
            displayName: best.displayName,
            suggestedFullName: best.suggestedFullName,
            duration: best.duration,
            bandwidth: best.bandwidth,
            resolution: best.resolution,
            extension: best.extension,
            qualities: qualities,
        })
    }
    for (const entry of entries) {
        if (entry.kind === "hls-media") {
            // variants of a known master are shown inside the master's quality list
            if (variantUrls.has(entry.url) || !entry.isSupported || entry.isEncrypted) continue
            const name = `${pageInfo.pageTitle} - ${pageInfo.pageUrlHash}`
            result.push({
                type: "hls",
                uri: entry.url,
                requestHeaders: entry.requestHeaders,
                displayName: pageInfo.pageTitle,
                suggestedFullName: `${name}.${entry.extension}`,
                duration: entry.duration !== undefined ? createDurationString(entry.duration) : undefined,
                extension: entry.extension,
            })
        } else if (entry.kind === "http") {
            const mediaProps: string[] = []
            let name: string
            if (entry.name) {
                name = entry.name
                mediaProps.push(name)
            } else {
                name = pageInfo.pageTitle
                mediaProps.push(pageInfo.pageTitle, pageInfo.pageUrlHash)
            }
            result.push({
                type: "http",
                uri: entry.url,
                requestHeaders: entry.requestHeaders,
                displayName: name,
                suggestedFullName: mediaProps.join("-") + "." + entry.extension,
                extension: entry.extension,
                size: entry.size !== undefined ? createSizeString(entry.size) : undefined,
            })
        }
    }
    return result
}

function createQualities(master: HLSMasterEntry, state: TabMediaState, pageInfo: PageInfo): DownloadableMediaQuality[] {
    const usable = (master.variants ?? [])
        .map(variant => ({variant, media: state.entries[variant.url]}))
        .filter((x): x is { variant: HLSVariantInfo, media: HLSMediaPlaylistEntry } =>
            x.media?.kind === "hls-media" && x.media.isSupported && !x.media.isEncrypted
        )
        .sort((a, b) =>
            (b.variant.height ?? 0) - (a.variant.height ?? 0)
            || (b.variant.bandwidth ?? 0) - (a.variant.bandwidth ?? 0)
        )
    // "720p" is ambiguous when a master has two 720p variants: add the bitrate then
    const heightCounts = _.countBy(usable, x => x.variant.height ?? "none")
    return usable.map(({variant, media}, index) => {
        let label: string
        if (variant.height) {
            label = `${variant.height}p`
            if (heightCounts[variant.height] > 1 && variant.bandwidth) {
                label += ` (${createBandwidthString(variant.bandwidth)})`
            }
        } else if (variant.bandwidth) {
            label = createBandwidthString(variant.bandwidth)
        } else {
            label = `Quality ${index + 1}`
        }
        const displayName = `${pageInfo.pageTitle} - ${label}`
        return {
            label: label,
            uri: media.url,
            requestHeaders: media.requestHeaders,
            displayName: displayName,
            suggestedFullName: `${displayName}.${media.extension}`,
            duration: media.duration !== undefined ? createDurationString(media.duration) : undefined,
            bandwidth: variant.bandwidth ? createBandwidthString(variant.bandwidth) : undefined,
            resolution: variant.width && variant.height ? `${variant.width}x${variant.height}` : undefined,
            extension: media.extension,
        }
    })
}

function createBandwidthString(bandwidth: number) {
    const kbps = Math.round(bandwidth / 1000); // 500 kbps
    return `${kbps}kbps`
}

function createSizeString(size: number): string {
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let unitIndex = -1;
    do {
        size /= 1024;
        unitIndex++;
    } while (size >= 1024 && unitIndex < units.length - 1);
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function createDurationString(duration: number) {
    const seconds = Math.floor(duration % 60)
    const minutes = Math.floor((duration / 60) % 60)
    const hours = Math.floor(duration / 3600)
    const m = minutes.toString().padStart(2, "0");
    const s = seconds.toString().padStart(2, "0");
    if (hours == 0) {
        return `${m}:${s}`
    } else {
        const h = hours.toString().padStart(2, "0");
        return `${h}:${m}:${s}`
    }
}

// ---------- HLS fetching / parsing ----------

function parseHLS(hlsContent: string) {
    try {
        return HLS.parse(hlsContent)
    } catch (e) {
        return null
    }
}

function resolveUrl(uri: string, base: string) {
    try {
        return new URL(uri, base).toString()
    } catch (e) {
        return uri
    }
}

async function fetchHLSText(url: string, requestHeaders: HeadersRecord) {
    const response = await run(async () => {
        try {
            return await fetch(new Request(url, {headers: requestHeaders}));
        } catch (e) {
            return null
        }
    })
    if (!response) {
        return null
    }
    if (!inRange(response.status, 200, 299)) {
        return null;
    }
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? null
    const contentTypeMatch = contentType !== null && HLSUtils.isHLSContentType(contentType)
    const length = getContentLength(response.headers)
    const smallEnough = length !== null && length < HLSUtils.MAX_HLS_PLAYLIST_SIZE
    // some servers don't send a proper content-type; we only got here because the url ends with .m3u8
    // or the content-type matched, so accept the body if the type matches or the size is known and small
    if (contentTypeMatch || smallEnough || (contentType === null && looksLikePlaylistUrl(url))) {
        const text = await response.text()
        if (text.length > HLSUtils.MAX_HLS_PLAYLIST_SIZE || !text.trimStart().startsWith("#EXTM3U")) {
            return null
        }
        return text
    }
    return null
}

function looksLikePlaylistUrl(url: string) {
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".m3u8")
    } catch (e) {
        return false
    }
}

/**
 * Generates a short unique string based on a URL.
 * This helps when a user downloads multiple videos from the same website,
 * as the default file names might be identical. The generated string
 * serves as a postfix to differentiate the files.
 */
function shortSafeHash(url: string, length = 6): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
        // mix character codes with a prime to reduce collisions
        hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
    }
    let str = '';
    for (let i = 0; i < length; i++) {
        str = String.fromCharCode(97 + (hash % 26)) + str;
        hash = Math.floor(hash / 26);
    }
    return str;
}
