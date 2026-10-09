import browser from "webextension-polyfill";
import {InterceptedMediaResult, InterceptedMediaType} from "~/linkgrabber/LinkGrabberResponse";
import {inRange} from "~/utils/NumberUtils";
import {run} from "~/utils/ScopeFunctions";
import {MasterPlaylist, MediaPlaylist} from "hls-parser/types";
import * as HLSUtils from "~/media/HLSUtils";
import {HLSEncryption} from "~/media/HLSUtils";
import * as MultiMediaUtils from "~/media/MultiMediaUtils"
import _ from "lodash";
import HLS from "hls-parser"
import {getContentDisposition, getContentLength, getContentType} from "~/utils/HeaderUtils";
import {getFileExtension, getFileFromUrl, getFileNameWithoutExtension} from "~/utils/URLUtils";
import {getFileNameFromHeader} from "~/utils/ExtractFileNameFromHeader";
import {TabMediaStore} from "~/media/TabMediaStore";
import * as SegmentUtils from "~/media/SegmentUtils";
import {SegmentTrack} from "~/media/SegmentUtils";
import {redactHeaders} from "~/media/DetectionDebugLog";

// ---------- persisted (serializable) per-tab state ----------

type HeadersRecord = Record<string, string>

type BaseEntry = {
    url: string,
    requestHeaders: HeadersRecord,
    frameId: number, // frame whose content script shows this item
}

type HttpMediaEntry = BaseEntry & {
    kind: "http",
    name?: string,
    extension: string,
    size?: number,
    viaScript?: boolean, // fetched by XHR/fetch, not by a media element
}

export type HLSVariantInfo = {
    url: string, // absolute
    bandwidth?: number,
    width?: number,
    height?: number,
    frameRate?: number,
}

type HLSMasterEntry = BaseEntry & {
    kind: "hls-master",
    // null = the master's content is not known (yet / any more) and must be fetched
    variants: HLSVariantInfo[] | null,
    encryption?: HLSEncryption,
}

type HLSSegmentFormat = "ts" | "fmp4" | "unsupported"

type HLSMediaPlaylistEntry = BaseEntry & {
    kind: "hls-media",
    format: HLSSegmentFormat,
    extension?: string, // of the downloaded file: ts / mp4 / aac ...
    duration?: number,
    encryption: HLSEncryption,
    // SegmentUtils group keys of this playlist's segments (to link captured segments to it)
    segmentKeys?: string[],
}

type DASHEntry = BaseEntry & {
    kind: "dash",
    duration?: number,
    maxHeight?: number,
    isDrm: boolean,
    segmentKeys?: string[],
}

type MediaEntry = HttpMediaEntry | HLSMasterEntry | HLSMediaPlaylistEntry | DASHEntry

/** Segments of one stream/quality seen in a frame (see SegmentUtils.parseSegment). */
type SegmentGroup = {
    key: string,
    frameId: number,
    base: string, // origin + directory
    template?: string, // URL with "{N}"; absent if the segments aren't numbered
    pad?: number,
    initUrl?: string,
    min?: number,
    max?: number,
    count: number,
    track: SegmentTrack,
    mime?: string, // from the MSE hook
    contentType?: string,
    height?: number,
    token: string,
    headers: HeadersRecord,
    sizes: number[], // sample of segment sizes (bytes)
    probe?: { status: "running" | "done" | "failed", first?: number, last?: number },
}

export type TabMediaState = {
    entries: Record<string, MediaEntry>,
    // frameId -> URL of the document in that frame (as reported by its content script / requests)
    frames: Record<string, string>,
    segmentGroups: Record<string, SegmentGroup>,
    // frameId -> duration (s) of the frame's main <video>, for streams rebuilt from segments
    frameDurations: Record<string, number>,
}

export function emptyTabMediaState(): TabMediaState {
    return {entries: {}, frames: {}, segmentGroups: {}, frameDurations: {}}
}

/** A stream rebuilt from numbered segments, sent to the app as {type: "segments"} */
export type SegmentsTrackJob = {
    init?: string,
    template: string,
    first: number,
    last: number,
    pad?: number,
}
export type SegmentsJob = {
    video: SegmentsTrackJob,
    audio?: SegmentsTrackJob,
    headers: Record<string, string>,
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
    size?: string,
    note?: string,
    segmentsJob?: SegmentsJob,
}

export type DownloadableMedia = {
    type: InterceptedMediaType | "segments",
    uri: string,
    requestHeaders?: Record<string, string>,
    displayName?: string
    suggestedFullName?: string,
    duration?: string,
    bandwidth?: string,
    resolution?: string,
    extension?: string,
    size?: string,
    // extra info shown in the list, e.g. "encrypted (supported)"
    note?: string,
    // false: listed for information only (e.g. DASH until the app supports it)
    downloadable?: boolean,
    // type "segments": the stream rebuilt from its numbered segments
    segmentsJob?: SegmentsJob,
    // for HLS master playlists: one entry per video, best quality first (uri/displayName above = qualities[0])
    qualities?: DownloadableMediaQuality[],
}

export interface OnMedialListUpdated {
    // called once per frame that has (or had) media
    onListUpdated(frameId: number, list: DownloadableMedia[]): void;
}

function headersToRecord(headers: Headers): HeadersRecord {
    const record: HeadersRecord = {}
    headers.forEach((value, key) => {
        record[key] = value
    })
    return record
}

function withReferer(headers: HeadersRecord, frameUrl: string | undefined): HeadersRecord {
    // the app sends these headers when downloading; players inside iframes are often only served
    // when the request comes "from" the iframe's page
    if (!frameUrl || !/^https?:/i.test(frameUrl)) {
        return headers
    }
    const refererKey = Object.keys(headers).find(k => k.toLowerCase() === "referer")
    if (refererKey) {
        // browsers usually send only the origin to other sites (strict-origin-when-cross-origin);
        // upgrade that to the full frame URL, but keep a referer that points somewhere else
        if (!isOriginOnlyRefererOf(headers[refererKey], frameUrl)) {
            return headers
        }
        const {[refererKey]: _, ...rest} = headers
        return {...rest, "Referer": frameUrl}
    }
    return {...headers, "Referer": frameUrl}
}

function isOriginOnlyRefererOf(referer: string, frameUrl: string) {
    try {
        const origin = new URL(frameUrl).origin
        return referer === origin || referer === origin + "/"
    } catch (e) {
        return false
    }
}

/**
 * Detected media of one tab, grouped by frame. State is persisted in [TabMediaStore] (storage.session) so it
 * survives MV3 service-worker restarts; it's cleared when the tab navigates or closes.
 */
export class MediaOnTab {
    private state: TabMediaState = emptyTabMediaState()
    private generation = 0 // bumped on reset, so results of an old page are dropped
    private readonly inFlight = new Set<string>()
    private readonly failed = new Set<string>()
    private readonly publishedFrames = new Set<number>()
    private isClosed = false

    public constructor(
        public readonly tabId: number,
        private readonly onMediaListUpdated: OnMedialListUpdated,
        private readonly store: TabMediaStore,
    ) {
    }

    /** Load persisted state, then finish any HLS work that was interrupted (e.g. by a service-worker restart). */
    async restore() {
        const stored = await this.store.load(this.tabId)
        this.state = {...emptyTabMediaState(), ...stored}
        const generation = this.generation
        const pending: Promise<void>[] = []
        for (const entry of Object.values(this.state.entries)) {
            if (entry.kind !== "hls-master") continue
            const target = {frameId: entry.frameId, headers: entry.requestHeaders}
            if (entry.variants === null) {
                // master playlist data was lost: fetch it again
                pending.push(this.processHLS(entry.url, target, generation, undefined))
                continue
            }
            for (const variant of entry.variants) {
                if (!this.state.entries[variant.url]) {
                    pending.push(this.processHLS(variant.url, target, generation, undefined))
                }
            }
        }
        // probes of segment groups interrupted by a service-worker restart
        for (const group of Object.values(this.state.segmentGroups)) {
            if (group.probe?.status === "running") {
                group.probe = undefined
                this.maybeProbe(group, generation)
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
        this.publishedFrames.clear()
    }

    getFrameUrl(frameId: number): string | undefined {
        return this.state.frames[String(frameId)]
    }

    /** A copy of the state with sensitive header values redacted (debug export). */
    getStateSnapshot(): TabMediaState {
        const copy = JSON.parse(JSON.stringify(this.state)) as TabMediaState
        const redact = (headers: HeadersRecord) => redactHeaders(headers) ?? {}
        Object.values(copy.entries).forEach(e => e.requestHeaders = redact(e.requestHeaders))
        Object.values(copy.segmentGroups).forEach(g => g.headers = redact(g.headers))
        return copy
    }

    /** A frame's content script told us its URL; if the frame navigated, forget its old media. */
    async setFrameUrl(frameId: number, url: string) {
        const key = String(frameId)
        const old = this.state.frames[key]
        if (old === url) {
            return
        }
        if (old !== undefined) {
            for (const [entryUrl, entry] of Object.entries(this.state.entries)) {
                if (entry.frameId === frameId) {
                    delete this.state.entries[entryUrl]
                }
            }
            for (const [groupKey, group] of Object.entries(this.state.segmentGroups)) {
                if (group.frameId === frameId) {
                    delete this.state.segmentGroups[groupKey]
                }
            }
            delete this.state.frameDurations[key]
        }
        this.state.frames[key] = url
        await this.store.save(this.tabId, this.state)
    }

    /** Duration of the frame's main <video> (used for streams rebuilt from segments). */
    async setFrameDuration(frameId: number, duration: number) {
        if (!Number.isFinite(duration) || duration <= 0 || this.state.frameDurations[String(frameId)] === duration) {
            return
        }
        this.state.frameDurations[String(frameId)] = duration
        this.scheduleSave()
        if (Object.values(this.state.segmentGroups).some(g => g.frameId === frameId)) {
            await this.publish()
        }
    }

    async process(mediaResult: InterceptedMediaResult) {
        const generation = this.generation
        const frameId = mediaResult.frameId !== undefined && mediaResult.frameId >= 0 ? mediaResult.frameId : 0
        if (mediaResult.frameUrl && !this.state.frames[String(frameId)]) {
            this.state.frames[String(frameId)] = mediaResult.frameUrl
        }
        const frameUrl = this.getFrameUrl(frameId) ?? mediaResult.frameUrl
        const target = {
            frameId: frameId,
            headers: withReferer(headersToRecord(mediaResult.requestHeaders), frameUrl),
        }
        switch (mediaResult.mediaType) {
            case "hls":
                await this.processHLS(mediaResult.url, target, generation, mediaResult.content)
                break
            case "dash":
                await this.processDASH(mediaResult.url, target, generation, mediaResult.content)
                break
            case "http":
                await this.processHttp(mediaResult.url, target, mediaResult.responseHeaders, generation, mediaResult.viaScript ?? false)
                break
            case "segment":
                await this.processSegment(mediaResult, target, generation)
                break
        }
    }

    // ---------- segments ----------

    private saveTimer: ReturnType<typeof setTimeout> | null = null

    /** Segments arrive every few seconds: persist at most every 2 s. */
    private scheduleSave() {
        if (this.saveTimer !== null) {
            return
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            if (!this.isClosed) {
                this.store.save(this.tabId, this.state)
            }
        }, 2000)
    }

    private async processSegment(mediaResult: InterceptedMediaResult, target: Target, generation: number) {
        const contentType = getContentType(mediaResult.responseHeaders)
        // URLs the page appended to a MediaSource are segments even if their name doesn't say so
        const parsed = SegmentUtils.parseSegment(mediaResult.url, contentType, mediaResult.rangeHeader)
            ?? (mediaResult.mime ? SegmentUtils.parseSegment(mediaResult.url, "video/iso.segment", null) : null)
        if (!parsed) {
            return
        }
        let group = this.state.segmentGroups[parsed.groupKey]
        const isNew = !group
        if (!group) {
            const url = new URL(mediaResult.url)
            group = {
                key: parsed.groupKey,
                frameId: target.frameId,
                base: url.origin + url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1),
                count: 0,
                track: parsed.trackHint,
                token: parsed.qualityToken,
                height: parsed.height,
                headers: target.headers,
                sizes: [],
            }
            this.state.segmentGroups[parsed.groupKey] = group
        }
        const before = JSON.stringify([group.initUrl, group.track, group.mime, group.template !== undefined])
        if (parsed.isInit) {
            group.initUrl = mediaResult.url
        } else if (parsed.number !== undefined && parsed.template) {
            group.template = parsed.template // the latest URL (fresh query string, e.g. tokens)
            group.pad = parsed.pad
            group.min = group.min === undefined ? parsed.number : Math.min(group.min, parsed.number)
            group.max = group.max === undefined ? parsed.number : Math.max(group.max, parsed.number)
            group.count++
            group.headers = target.headers
        }
        const size = getContentLength(mediaResult.responseHeaders)
        if (size && group.sizes.length < 20 && !parsed.isInit) {
            group.sizes.push(size)
        }
        if (mediaResult.mime) {
            group.mime = mediaResult.mime
        }
        if (contentType && !contentType.includes("iso.segment") && !contentType.includes("octet-stream")) {
            group.contentType = contentType
        }
        group.track = detectGroupTrack(group, parsed.trackHint)
        this.scheduleSave()
        const changed = isNew || before !== JSON.stringify([group.initUrl, group.track, group.mime, group.template !== undefined])
        this.maybeProbe(group, generation)
        if (changed && !this.isStale(generation)) {
            await this.publish()
        }
    }

    private runningProbes = 0

    /** Work out the first and last segment number of a numbered group by probing the server. */
    private maybeProbe(group: SegmentGroup, generation: number) {
        if (group.probe || !group.template || group.max === undefined) {
            return
        }
        // one segment alone could be anything; an init segment or a second segment makes it a stream
        if (!group.initUrl && group.count < 2) {
            return
        }
        if (hasManifestFor(group, this.state) || this.runningProbes >= 3) {
            return
        }
        group.probe = {status: "running"}
        this.runningProbes++
        run(async () => {
            try {
                const result = await probeSegmentRange(group)
                if (this.isStale(generation)) return
                group.probe = result.last !== undefined
                    ? {status: "done", first: result.first, last: result.last}
                    : {status: "failed"}
                result.sizes.forEach(s => group.sizes.length < 20 && group.sizes.push(s))
            } catch (e) {
                group.probe = {status: "failed"}
            } finally {
                this.runningProbes--
            }
            this.scheduleSave()
            await this.publish()
            // a group that waited because 3 probes were running
            Object.values(this.state.segmentGroups).forEach(g => this.maybeProbe(g, generation))
        })
    }

    private isStale(generation: number) {
        return this.isClosed || generation !== this.generation
    }

    private async processHttp(
        url: string, target: Target, responseHeaders: Headers, generation: number, viaScript: boolean,
    ) {
        if (this.state.entries[url] || this.inFlight.has(url)) {
            return
        }
        this.inFlight.add(url)
        try {
            if (!hasAnyHeader(responseHeaders)) {
                // reported by the page (media element / resource timing): we didn't see the response
                responseHeaders = await fetchHeadersOnly(url, target.headers) ?? responseHeaders
                if (this.isStale(generation)) return
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
                frameId: target.frameId,
                requestHeaders: target.headers,
                extension: extension,
                name: filenameWithExtension ? getFileNameWithoutExtension(filenameWithExtension) : undefined,
                size: getContentLength(responseHeaders) ?? undefined,
                viaScript: viaScript || undefined,
            }
            await this.commit(generation, entry)
        } finally {
            this.inFlight.delete(url)
        }
    }

    private async processHLS(url: string, target: Target, generation: number, content: string | undefined): Promise<void> {
        const existing = this.state.entries[url]
        if (existing && !(existing.kind === "hls-master" && existing.variants === null)) {
            return // already known
        }
        if (this.inFlight.has(url) || this.failed.has(url)) {
            return
        }
        this.inFlight.add(url)
        try {
            const text = content ?? await fetchPlaylistText(url, target.headers, "hls")
            if (this.isStale(generation)) return
            const playlist = text === null ? null : parseHLS(text)
            if (playlist === null) {
                this.failed.add(url)
                return
            }
            if (playlist.isMasterPlaylist) {
                await this.onMasterPlaylist(url, target, playlist, generation)
            } else {
                await this.onMediaPlaylist(url, target, playlist, generation)
            }
        } finally {
            this.inFlight.delete(url)
        }
    }

    private async onMasterPlaylist(url: string, target: Target, playlist: MasterPlaylist, generation: number) {
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
            frameId: target.frameId,
            requestHeaders: target.headers,
            variants: variants,
            encryption: HLSUtils.getMasterPlaylistEncryption(playlist),
        }
        await this.commit(generation, entry)
        if (entry.encryption === "drm") {
            return
        }
        // fetch each variant (media playlist) to learn duration / segment format / encryption
        await Promise.all(variants.map(v => this.processHLS(v.url, target, generation, undefined)))
    }

    private async onMediaPlaylist(url: string, target: Target, playlist: MediaPlaylist, generation: number) {
        if (playlist.segments.length == 0) {
            return // empty list?
        }
        const {format, extension} = getSegmentFormat(playlist, url)
        const entry: HLSMediaPlaylistEntry = {
            kind: "hls-media",
            url: url,
            frameId: target.frameId,
            requestHeaders: target.headers,
            format: format,
            extension: extension,
            duration: _.sumBy(playlist.segments, segment => segment.duration),
            encryption: HLSUtils.getMediaPlaylistEncryption(playlist),
            segmentKeys: segmentKeysOf(
                playlist.segments.slice(0, 300).flatMap(segment => [segment.uri, segment.map?.uri])
                    .filter((uri): uri is string => !!uri)
                    .map(uri => resolveUrl(uri, url)),
            ),
        }
        await this.commit(generation, entry)
    }

    private async processDASH(url: string, target: Target, generation: number, content: string | undefined) {
        if (this.state.entries[url] || this.inFlight.has(url) || this.failed.has(url)) {
            return
        }
        this.inFlight.add(url)
        try {
            const text = content ?? await fetchPlaylistText(url, target.headers, "dash")
            if (this.isStale(generation)) return
            if (text === null || !/<MPD[\s>]/.test(text)) {
                this.failed.add(url)
                return
            }
            const entry: DASHEntry = {
                kind: "dash",
                url: url,
                frameId: target.frameId,
                requestHeaders: target.headers,
                ...parseMPDSummary(text, url),
            }
            await this.commit(generation, entry)
        } finally {
            this.inFlight.delete(url)
        }
    }

    private async commit(generation: number, entry: MediaEntry) {
        if (this.isStale(generation)) {
            return
        }
        this.state.entries[entry.url] = entry
        await this.store.save(this.tabId, this.state)
        await this.publish()
    }

    /** Send each frame its current list (a frame that no longer has media gets an empty list). */
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
        const lists = buildDownloadableMediaLists(this.state, {pageTitle: tabTitle, pageUrlHash: shortSafeHash(tabUrl, 6)})
        const frames = new Set<number>([...lists.keys(), ...this.publishedFrames])
        for (const frameId of frames) {
            const list = lists.get(frameId) ?? []
            if (list.length > 0) {
                this.publishedFrames.add(frameId)
            } else {
                this.publishedFrames.delete(frameId)
            }
            this.onMediaListUpdated.onListUpdated(frameId, list)
        }
    }

    private async getTab() {
        try {
            return (await browser.tabs.get(this.tabId))
        } catch (e) {
            return null
        }
    }
}

type Target = { frameId: number, headers: HeadersRecord }

// ---------- segment groups ----------

function detectGroupTrack(group: SegmentGroup, hint: SegmentTrack): SegmentTrack {
    const fromType = (type: string | undefined): SegmentTrack | null => {
        const t = type?.toLowerCase() ?? ""
        if (t.startsWith("video/")) return "video"
        if (t.startsWith("audio/")) return "audio"
        return null
    }
    // the MSE SourceBuffer type is the most reliable. Servers often label every fMP4 segment "video/mp4", even
    // audio ones, so after that: an audio/* response type, then the URL naming (a1 / v1 / audio ...), then video/*
    const fromMime = fromType(group.mime)
    if (fromMime) return fromMime
    if (fromType(group.contentType) === "audio") return "audio"
    if (hint !== "unknown") return hint
    if (group.track !== "unknown") return group.track
    return fromType(group.contentType) ?? "unknown"
}

function directoryOf(url: string): string | null {
    try {
        const u = new URL(url)
        return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1)
    } catch (e) {
        return null
    }
}

/** Is this group part of a stream whose manifest (HLS/DASH) we captured? Then only the manifest is listed. */
function hasManifestFor(group: SegmentGroup, state: TabMediaState): boolean {
    for (const entry of Object.values(state.entries)) {
        if (entry.kind !== "hls-master" && entry.kind !== "hls-media" && entry.kind !== "dash") continue
        if ((entry.kind === "hls-media" || entry.kind === "dash") && entry.segmentKeys?.includes(group.key)) {
            return true
        }
        if (entry.frameId === group.frameId) {
            return true
        }
        const dir = directoryOf(entry.url)
        if (dir && group.base.startsWith(dir)) {
            return true
        }
    }
    return false
}

/**
 * First and last segment number of a numbered group, by probing the server with 1-byte range requests
 * (exponential then binary search; at most 64 requests), using the page's request headers.
 */
async function probeSegmentRange(group: SegmentGroup): Promise<{ first?: number, last?: number, sizes: number[] }> {
    const sizes: number[] = []
    let requests = 0
    const headers: HeadersRecord = {}
    Object.entries(group.headers).forEach(([k, v]) => {
        if (k.toLowerCase() !== "range") headers[k] = v
    })
    headers["Range"] = "bytes=0-0"
    const exists = async (n: number): Promise<boolean> => {
        if (n < 0 || requests >= 64) return false
        requests++
        const response = await fetchWithTimeout(
            new Request(SegmentUtils.segmentUrl(group.template!, n, group.pad), {headers}), 10_000,
        )
        if (!response || !(response.status === 200 || response.status === 206)) return false
        const total = /\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "")?.[1]
        const size = total ? parseInt(total) : (response.status === 200 ? getContentLength(response.headers) : null)
        if (size) sizes.push(size)
        try {
            await response.body?.cancel()
        } catch (e) {
            // ignore
        }
        return true
    }
    const min = group.min!, max = group.max!
    if (!(await exists(max))) {
        // the URL pattern doesn't work outside the player (e.g. per-segment signed URLs)
        return {sizes}
    }
    let lo = max
    let hi: number | undefined
    for (let step = 1; hi === undefined && requests < 40; step *= 2) {
        if (await exists(lo + step)) {
            lo = lo + step
        } else {
            hi = lo + step
        }
    }
    hi ??= lo + 1
    while (hi - lo > 1 && requests < 64) {
        const mid = Math.floor((lo + hi) / 2)
        if (await exists(mid)) lo = mid
        else hi = mid
    }
    // first: usually 0 or 1, otherwise the smallest number that exists below what the player fetched
    let first = min
    if (min > 0) {
        if (await exists(0)) {
            first = 0
        } else if (min > 1 && await exists(1)) {
            first = 1
        } else if (min > 1) {
            let a = 1, b = min
            while (b - a > 1 && requests < 64) {
                const mid = Math.floor((a + b) / 2)
                if (await exists(mid)) b = mid
                else a = mid
            }
            first = b
        }
    }
    return {first, last: lo, sizes}
}

function trackJob(group: SegmentGroup): SegmentsTrackJob {
    return {
        init: group.initUrl,
        template: group.template!,
        first: group.probe?.first ?? group.min!,
        last: group.probe?.last ?? group.max!,
        pad: group.pad,
    }
}

function segmentCount(job: SegmentsTrackJob) {
    return job.last - job.first + 1
}

function estimatedSize(group: SegmentGroup, job: SegmentsTrackJob): number | undefined {
    return group.sizes.length ? _.mean(group.sizes) * segmentCount(job) : undefined
}

/** One entry per frame for streams rebuilt from segments; video groups become its qualities (high to low). */
function buildRebuiltStreams(
    state: TabMediaState,
    pageInfo: PageInfo,
    add: (frameId: number, item: DownloadableMedia) => void,
) {
    const usable = Object.values(state.segmentGroups).filter(g =>
        g.template && g.min !== undefined && g.max !== undefined
        && g.probe && g.probe.status !== "running"
        && !hasManifestFor(g, state)
    )
    for (const [frameKey, groups] of Object.entries(_.groupBy(usable, g => g.frameId))) {
        const frameId = Number(frameKey)
        const audioGroups = groups.filter(g => g.track === "audio")
        let videoGroups = groups.filter(g => g.track !== "audio")
        const audioOnly = videoGroups.length === 0
        if (audioOnly) {
            videoGroups = audioGroups
        }
        // separate audio track: pair the most complete audio group with every video quality
        const audio = audioOnly ? undefined : _.maxBy(audioGroups, g => segmentCount(trackJob(g)))
        const audioJob = audio ? trackJob(audio) : undefined
        const sorted = _.orderBy(videoGroups, [g => g.height ?? 0, g => segmentCount(trackJob(g))], ["desc", "desc"])
        const frameUrl = state.frames[String(frameId)]
        const duration = state.frameDurations[String(frameId)]
        const usedLabels = new Map<string, number>()
        const qualities: DownloadableMediaQuality[] = sorted.map((group, index) => {
            const job = trackJob(group)
            let label = group.height ? `${group.height}p` : (group.token || `Quality ${index + 1}`)
            const seen = usedLabels.get(label) ?? 0
            usedLabels.set(label, seen + 1)
            if (seen > 0) label = `${label} (${seen + 1})`
            const extension = /\.ts(\?|$)/i.test(job.template) ? "ts" : "mp4"
            const displayName = `${pageInfo.pageTitle} - ${label} (rebuilt)`
            const size = [estimatedSize(group, job), audio && audioJob ? estimatedSize(audio, audioJob) : 0]
                .reduce<number | undefined>((sum, s) => s === undefined || sum === undefined ? undefined : sum + s, 0)
            const notes = [
                group.probe?.status === "failed" ? "rebuilt from the segments seen so far" : "rebuilt from segments",
                audioJob ? "video + audio" : undefined,
            ].filter(Boolean)
            return {
                label: label,
                uri: job.init ?? SegmentUtils.segmentUrl(job.template, job.first, job.pad),
                requestHeaders: withReferer(group.headers, frameUrl),
                displayName: displayName,
                suggestedFullName: `${displayName}.${extension}`,
                duration: duration ? createDurationString(duration) : undefined,
                resolution: undefined,
                size: size ? `~${createSizeString(Math.round(size))}` : undefined,
                extension: extension,
                note: `${notes.join(", ")} (${segmentCount(job)} segments)`,
                segmentsJob: {
                    video: job,
                    audio: audioJob,
                    headers: withReferer(group.headers, frameUrl),
                },
            }
        })
        if (!qualities.length) continue
        const best = qualities[0]
        add(frameId, {
            type: "segments",
            uri: best.uri,
            requestHeaders: best.requestHeaders,
            displayName: best.displayName,
            suggestedFullName: best.suggestedFullName,
            duration: best.duration,
            size: best.size,
            extension: best.extension,
            note: best.note,
            segmentsJob: best.segmentsJob,
            qualities: qualities,
        })
    }
}

// ---------- building the lists shown to the user ----------

type PageInfo = { pageTitle: string, pageUrlHash: string }

function encryptionNote(encryption: HLSEncryption | undefined): string | undefined {
    switch (encryption) {
        case "aes-128":
            return "encrypted (supported)"
        case "sample-aes":
            return "encrypted (SAMPLE-AES, needs ffmpeg)"
        default:
            return undefined
    }
}

/** frameId -> list for that frame */
export function buildDownloadableMediaLists(state: TabMediaState, pageInfo: PageInfo): Map<number, DownloadableMedia[]> {
    const entries = Object.values(state.entries)
    const variantUrls = new Set<string>()
    const framesWithStreams = new Set<number>()
    const result = new Map<number, DownloadableMedia[]>()
    const add = (frameId: number, item: DownloadableMedia) => {
        let list = result.get(frameId)
        if (!list) {
            list = []
            result.set(frameId, list)
        }
        list.push(item)
    }

    // a frame that fetches stream segments plays a stream: whole MP4s fetched by its scripts are its segments too
    Object.values(state.segmentGroups).forEach(g => framesWithStreams.add(g.frameId))
    for (const entry of entries) {
        if (entry.kind === "hls-master" || entry.kind === "hls-media" || entry.kind === "dash") {
            framesWithStreams.add(entry.frameId)
        }
        if (entry.kind !== "hls-master" || !entry.variants) continue
        entry.variants.forEach(v => variantUrls.add(v.url))
        if (entry.encryption === "drm") continue
        const qualities = createQualities(entry, state, pageInfo)
        if (qualities.length == 0) continue // variants are still being processed
        const best = qualities[0]
        add(entry.frameId, {
            type: "hls",
            uri: best.uri,
            requestHeaders: best.requestHeaders,
            displayName: best.displayName,
            suggestedFullName: best.suggestedFullName,
            duration: best.duration,
            bandwidth: best.bandwidth,
            resolution: best.resolution,
            extension: best.extension,
            note: best.note ?? encryptionNote(entry.encryption),
            qualities: qualities,
        })
    }
    for (const entry of entries) {
        if (entry.kind === "hls-media") {
            // variants of a known master are shown inside the master's quality list
            if (variantUrls.has(entry.url) || entry.format === "unsupported" || entry.encryption === "drm") continue
            const name = `${pageInfo.pageTitle} - ${pageInfo.pageUrlHash}`
            add(entry.frameId, {
                type: "hls",
                uri: entry.url,
                requestHeaders: withReferer(entry.requestHeaders, state.frames[String(entry.frameId)]),
                displayName: pageInfo.pageTitle,
                suggestedFullName: `${name}.${entry.extension}`,
                duration: entry.duration !== undefined ? createDurationString(entry.duration) : undefined,
                extension: entry.extension,
                note: encryptionNote(entry.encryption),
            })
        } else if (entry.kind === "dash") {
            if (entry.isDrm) continue
            add(entry.frameId, {
                type: "dash",
                uri: entry.url,
                requestHeaders: withReferer(entry.requestHeaders, state.frames[String(entry.frameId)]),
                displayName: `${pageInfo.pageTitle} - DASH`,
                suggestedFullName: `${pageInfo.pageTitle} - ${pageInfo.pageUrlHash}.mp4`,
                duration: entry.duration !== undefined ? createDurationString(entry.duration) : undefined,
                resolution: entry.maxHeight ? `up to ${entry.maxHeight}p` : undefined,
                extension: "mpd",
                note: "needs yt-dlp/ffmpeg",
                downloadable: false,
            })
        } else if (entry.kind === "http") {
            // MP4/audio fetched by a script in a frame that plays a stream are almost always that stream's segments
            if (entry.viaScript && framesWithStreams.has(entry.frameId)) continue
            const mediaProps: string[] = []
            let name: string
            if (entry.name) {
                name = entry.name
                mediaProps.push(name)
            } else {
                name = pageInfo.pageTitle
                mediaProps.push(pageInfo.pageTitle, pageInfo.pageUrlHash)
            }
            add(entry.frameId, {
                type: "http",
                uri: entry.url,
                requestHeaders: withReferer(entry.requestHeaders, state.frames[String(entry.frameId)]),
                displayName: name,
                suggestedFullName: mediaProps.join("-") + "." + entry.extension,
                extension: entry.extension,
                size: entry.size !== undefined ? createSizeString(entry.size) : undefined,
            })
        }
    }
    buildRebuiltStreams(state, pageInfo, add)
    return result
}

function createQualities(master: HLSMasterEntry, state: TabMediaState, pageInfo: PageInfo): DownloadableMediaQuality[] {
    const usable = (master.variants ?? [])
        .map(variant => ({variant, media: state.entries[variant.url]}))
        .filter((x): x is { variant: HLSVariantInfo, media: HLSMediaPlaylistEntry } =>
            x.media?.kind === "hls-media" && x.media.format !== "unsupported" && x.media.encryption !== "drm"
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
            requestHeaders: withReferer(media.requestHeaders, state.frames[String(master.frameId)]),
            displayName: displayName,
            suggestedFullName: `${displayName}.${media.extension}`,
            duration: media.duration !== undefined ? createDurationString(media.duration) : undefined,
            bandwidth: variant.bandwidth ? createBandwidthString(variant.bandwidth) : undefined,
            resolution: variant.width && variant.height ? `${variant.width}x${variant.height}` : undefined,
            extension: media.extension,
            note: encryptionNote(media.encryption),
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

// ---------- HLS / DASH parsing ----------

function parseHLS(hlsContent: string) {
    try {
        return HLS.parse(hlsContent)
    } catch (e) {
        return null
    }
}

function getSegmentFormat(playlist: MediaPlaylist, playlistUrl: string): { format: HLSSegmentFormat, extension?: string } {
    const first = playlist.segments[0]
    const filename = getFileFromUrl(resolveUrl(first.uri, playlistUrl))
    const segmentExtension = filename ? getFileExtension(filename)?.toLowerCase() : undefined
    const hasInitSection = playlist.segments.some(segment => !!segment.map)
    if (hasInitSection || (segmentExtension && HLSUtils.HLS_FMP4_SEGMENT_EXTENSIONS.includes(segmentExtension))) {
        return {format: "fmp4", extension: "mp4"}
    }
    if (!segmentExtension) {
        // segments without a file extension (e.g. "segment?id=1") are usually MPEG-TS
        return {format: "ts", extension: "ts"}
    }
    if (HLSUtils.HLS_TS_SEGMENT_EXTENSIONS.includes(segmentExtension)) {
        return {format: "ts", extension: segmentExtension}
    }
    return {format: "unsupported"}
}

const DRM_SYSTEM_IDS = [
    "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
    "9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
    "94ce86fb-07ff-4f43-adb8-93d2fa968ca2", // FairPlay
]

/** Small regex-based MPD summary (service workers have no DOMParser). */
function parseMPDSummary(mpd: string, mpdUrl: string): {
    duration?: number, maxHeight?: number, isDrm: boolean, segmentKeys: string[],
} {
    const lower = mpd.toLowerCase()
    const isDrm = DRM_SYSTEM_IDS.some(id => lower.includes(id))
    let duration: number | undefined
    const d = /mediaPresentationDuration\s*=\s*"P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"/i.exec(mpd)
    if (d) {
        const [days, hours, minutes, seconds] = d.slice(1).map(v => v ? parseFloat(v) : 0)
        duration = days * 86400 + hours * 3600 + minutes * 60 + seconds
    }
    const heights = Array.from(mpd.matchAll(/\bheight\s*=\s*"(\d+)"/gi), m => parseInt(m[1]))
    const maxHeight = heights.length ? Math.max(...heights) : undefined
    return {duration, maxHeight, isDrm, segmentKeys: mpdSegmentKeys(mpd, mpdUrl)}
}

/** Group keys of the segments a DASH manifest describes (from SegmentTemplate media/initialization URLs). */
function mpdSegmentKeys(mpd: string, mpdUrl: string): string[] {
    const ids = Array.from(mpd.matchAll(/<Representation\b[^>]*\bid\s*=\s*"([^"]+)"/gi), m => m[1])
    const templates = Array.from(mpd.matchAll(/\b(?:media|initialization)\s*=\s*"([^"]+)"/gi), m => m[1])
    const baseUrl = /<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/i.exec(mpd)?.[1]
    const base = baseUrl ? resolveUrl(baseUrl, mpdUrl) : mpdUrl
    const urls: string[] = []
    for (const template of templates.slice(0, 50)) {
        for (const id of (ids.length ? ids.slice(0, 20) : [""])) {
            const sample = template
                .replace(/\$RepresentationID\$/g, id)
                .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, width) => width ? "1".padStart(parseInt(width), "0") : "1")
                .replace(/\$(?:Time|Bandwidth)(?:%0\d+d)?\$/g, "0")
            urls.push(resolveUrl(sample, base))
        }
    }
    return segmentKeysOf(urls)
}

function segmentKeysOf(urls: string[]): string[] {
    const keys = new Set<string>()
    for (const url of urls) {
        const parsed = SegmentUtils.parseSegment(url, "video/iso.segment", null)
        if (parsed) keys.add(parsed.groupKey)
    }
    return Array.from(keys)
}

function resolveUrl(uri: string, base: string) {
    try {
        return new URL(uri, base).toString()
    } catch (e) {
        return uri
    }
}

function hasAnyHeader(headers: Headers) {
    let any = false
    headers.forEach(() => {
        any = true
    })
    return any
}

async function fetchWithTimeout(request: Request, timeoutMs: number) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(request, {signal: controller.signal})
    } catch (e) {
        return null
    } finally {
        clearTimeout(timer)
    }
}

/** Response headers of a media URL we only know by URL (HEAD request). */
async function fetchHeadersOnly(url: string, requestHeaders: HeadersRecord): Promise<Headers | null> {
    if (!/^https?:/i.test(url)) {
        return null
    }
    const response = await fetchWithTimeout(new Request(url, {method: "HEAD", headers: requestHeaders}), 8_000)
    if (!response || !inRange(response.status, 200, 299)) {
        return null
    }
    return response.headers
}

async function fetchPlaylistText(url: string, requestHeaders: HeadersRecord, kind: "hls" | "dash") {
    if (!/^https?:/i.test(url)) {
        return null // e.g. blob: playlists only arrive with their content
    }
    const response = await fetchWithTimeout(new Request(url, {headers: requestHeaders}), 15_000)
    if (!response) {
        return null
    }
    if (!inRange(response.status, 200, 299)) {
        return null;
    }
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? null
    const length = getContentLength(response.headers)
    if (length !== null && length > HLSUtils.MAX_HLS_PLAYLIST_SIZE) {
        return null
    }
    const text = await run(async () => {
        try {
            return await response.text()
        } catch (e) {
            return null
        }
    })
    if (text === null || text.length > HLSUtils.MAX_HLS_PLAYLIST_SIZE) {
        return null
    }
    // the body decides: some servers send text/plain or octet-stream for playlists
    if (kind === "hls") {
        return text.trimStart().startsWith("#EXTM3U") ? text : null
    }
    return /<MPD[\s>]/.test(text) || (contentType?.includes("dash") ?? false) ? text : null
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
