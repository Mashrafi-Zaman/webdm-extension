/**
 * Recognising stream segments (fMP4 / TS / CMAF pieces of a video) so they are never listed as downloads on
 * their own, and grouping them so a stream can be linked to its manifest or rebuilt from its numbering.
 * Dependency-free: used by the background and the content script.
 */

export type SegmentTrack = "video" | "audio" | "muxed" | "unknown"

export type ParsedSegment = {
    isInit: boolean,
    // sequence number of a media segment (absent for init segments / unnumbered segments)
    number?: number,
    // the number as written, to keep zero padding ("00042" -> pad 5)
    pad?: number,
    // the URL with the sequence number replaced by "{N}" (query kept); only for numbered segments
    template?: string,
    // segments of one stream/quality share this key: origin + directory + "|" + quality token
    groupKey: string,
    qualityToken: string,
    height?: number,
    trackHint: SegmentTrack,
}

const SEGMENT_EXTENSIONS = ["m4s", "ts", "cmfv", "cmfa", "m4f", "m4v-seg"]
const SEGMENT_CONTENT_TYPES = ["video/iso.segment", "audio/iso.segment"]
// seg-12, segment_12, chunk-12, chunk12, frag-12, fragment-12 (the number is the sequence number)
const NUMBERED_SEGMENT = /(^|[-_.])(seg(?:ment)?|chunk|frag(?:ment)?)[-_]?(\d+)/i
// tested against the file name without extension: "init", "init0", "init-s1080p-v1", "video_init", "1080p-init-x"
const INIT_NAME = /^init(?:[-_.]|\d*$)|[-_]init(?:[-_.]|$)/i
const SEGMENT_WORDS = /\b(?:seg(?:ment)?|chunk|frag(?:ment)?|init)\b/gi

function splitUrl(rawUrl: string): { url: URL, dir: string, filename: string, name: string, extension: string } | null {
    try {
        const url = new URL(rawUrl)
        const slash = url.pathname.lastIndexOf("/")
        const dir = url.pathname.slice(0, slash + 1)
        const filename = decodeURIComponent(url.pathname.slice(slash + 1))
        const dot = filename.lastIndexOf(".")
        const name = dot > 0 ? filename.slice(0, dot) : filename
        const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ""
        return {url, dir, filename, name, extension}
    } catch (e) {
        return null
    }
}

/** A bounded byte range ("bytes=100-199"): a piece of a file, not the whole file. "bytes=0-" is a whole-file read. */
export function isBoundedRange(rangeHeader: string | null | undefined): boolean {
    if (!rangeHeader) {
        return false
    }
    return /bytes\s*=\s*\d+\s*-\s*\d+/i.test(rangeHeader)
}

/** Is this request a stream segment (or init segment) rather than a whole media file? */
export function isSegmentRequest(url: string, contentType?: string | null, rangeHeader?: string | null): boolean {
    const type = contentType?.toLowerCase() ?? ""
    if (SEGMENT_CONTENT_TYPES.some(t => type.startsWith(t))) {
        return true
    }
    if (type.startsWith("video/mp2t")) {
        return true
    }
    if (isBoundedRange(rangeHeader)) {
        return true
    }
    const parts = splitUrl(url)
    if (!parts) {
        return false
    }
    if (SEGMENT_EXTENSIONS.includes(parts.extension)) {
        return true
    }
    if (/\/segments?\//i.test(parts.dir)) {
        return true
    }
    if (INIT_NAME.test(parts.name) && ["mp4", "m4v", "m4a", "m4s", "cmfv", "cmfa", "mp4a", ""].includes(parts.extension)) {
        return true
    }
    return NUMBERED_SEGMENT.test(parts.name)
}

function detectHeight(text: string): number | undefined {
    const p = /(\d{3,4})p(?![a-z])/i.exec(text)
    if (p) return parseInt(p[1])
    const plain = /(?:^|[^\d])(2160|1440|1080|720|540|480|360|240|144)(?:[^\d]|$)/.exec(text)
    return plain ? parseInt(plain[1]) : undefined
}

function detectTrack(text: string): SegmentTrack {
    const lower = text.toLowerCase()
    const hasVideo = /(^|[-_/.])(v\d+|video|vid)([-_/.]|$)/.test(lower)
    const hasAudio = /(^|[-_/.])(a\d+|audio|aud|aac|mp4a)([-_/.]|$)/.test(lower)
    if (hasVideo && !hasAudio) return "video"
    if (hasAudio && !hasVideo) return "audio"
    return "unknown"
}

/** video / audio from URL naming (".../audio/...", "a1", "v1"), and a picture height ("720p") if the URL has one */
export function urlHints(rawUrl: string): { track: SegmentTrack, height?: number } {
    const parts = splitUrl(rawUrl)
    if (!parts) return {track: "unknown"}
    const text = parts.dir + parts.name
    return {track: detectTrack(text), height: detectHeight(parts.name)}
}

/**
 * Parse a segment URL into its group. Returns null if it doesn't look like a segment.
 *   init-s1080p-v1-a1.mp4      -> init,           token "s1080p-v1-a1"
 *   seg-501-s1080p-v1-a1.m4s   -> number 501,     token "s1080p-v1-a1", template ".../seg-{N}-s1080p-v1-a1.m4s"
 *   chunk-stream0-00012.m4s    -> number 12/pad 5, token "stream0"     (ffmpeg DASH naming)
 */
export function parseSegment(rawUrl: string, contentType?: string | null, rangeHeader?: string | null): ParsedSegment | null {
    if (!isSegmentRequest(rawUrl, contentType, rangeHeader)) {
        return null
    }
    const parts = splitUrl(rawUrl)
    if (!parts) {
        return null
    }
    const {url, dir, name} = parts
    const isInit = INIT_NAME.test(name)

    let number: number | undefined
    let numberText: string | undefined
    let tokenSource = name
    let templateName: string | undefined
    if (!isInit) {
        const numbered = NUMBERED_SEGMENT.exec(name)
        if (numbered) {
            numberText = numbered[3]
            const start = numbered.index + numbered[0].length - numberText.length
            templateName = name.slice(0, start) + "{N}" + name.slice(start + numberText.length)
        } else {
            // e.g. "chunk-stream0-00012", "/segment/123.m4s", "1080_00042": the last number is the sequence
            const all = Array.from(name.matchAll(/\d+/g))
            const last = all[all.length - 1]
            if (last && last.index !== undefined) {
                numberText = last[0]
                templateName = name.slice(0, last.index) + "{N}" + name.slice(last.index + numberText.length)
            }
        }
        if (numberText !== undefined) {
            number = parseInt(numberText, 10)
            tokenSource = templateName!.replace("{N}", "")
        }
    }
    const qualityToken = tokenSource
        .replace(SEGMENT_WORDS, "")
        .replace(/[-_.]{2,}/g, "-")
        .replace(/^[-_.]+|[-_.]+$/g, "")
        .toLowerCase()
    let template: string | undefined
    if (templateName !== undefined) {
        const extension = parts.filename.slice(name.length)
        template = `${url.origin}${dir}${encodeURIComponent(templateName).replace("%7BN%7D", "{N}")}${extension}${url.search}`
    }
    return {
        isInit,
        number,
        pad: numberText && numberText.length > 1 && numberText.startsWith("0") ? numberText.length : undefined,
        template,
        groupKey: `${url.origin}${dir}|${qualityToken}`,
        qualityToken,
        height: detectHeight(qualityToken) ?? detectHeight(dir),
        trackHint: detectTrack(qualityToken + "/" + dir),
    }
}

export function segmentUrl(template: string, n: number, pad?: number): string {
    const text = pad ? String(n).padStart(pad, "0") : String(n)
    return template.replace("{N}", text)
}

export type SegmentProbeRequest = { template: string, pad?: number, min: number, max: number, headers?: Record<string, string> }
export type SegmentProbeResult = { first?: number, last?: number, sizes: number[] }

/**
 * First and last segment number of a numbered stream: exponential then binary search with [exists]
 * (at most 64 checks). Shared by the content script (probes from the page, so the page's Referer/cookies apply)
 * and the background (fallback).
 */
export async function findSegmentRange(
    min: number,
    max: number,
    exists: (n: number) => Promise<boolean>,
): Promise<{ first?: number, last?: number }> {
    let checks = 0
    const check = async (n: number) => {
        if (n < 0 || checks >= 64) return false
        checks++
        return exists(n)
    }
    if (!(await check(max))) {
        // the URL pattern doesn't work outside the player (e.g. per-segment signed URLs)
        return {}
    }
    let lo = max
    let hi: number | undefined
    for (let step = 1; hi === undefined && checks < 40; step *= 2) {
        if (await check(lo + step)) lo = lo + step
        else hi = lo + step
    }
    hi ??= lo + 1
    while (hi - lo > 1 && checks < 64) {
        const mid = Math.floor((lo + hi) / 2)
        if (await check(mid)) lo = mid
        else hi = mid
    }
    // first: usually 0 or 1, otherwise the smallest number that exists below what the player fetched
    let first = min
    if (min > 0) {
        if (await check(0)) {
            first = 0
        } else if (min > 1 && await check(1)) {
            first = 1
        } else if (min > 1) {
            let a = 1, b = min
            while (b - a > 1 && checks < 64) {
                const mid = Math.floor((a + b) / 2)
                if (await check(mid)) b = mid
                else a = mid
            }
            first = b
        }
    }
    return {first, last: lo}
}

/** Probe with fetch + "Range: bytes=0-0" (1 byte per check); collects segment sizes from Content-Range. */
export async function probeSegmentsWithFetch(request: SegmentProbeRequest, init: RequestInit = {}): Promise<SegmentProbeResult> {
    const sizes: number[] = []
    const range = await findSegmentRange(request.min, request.max, async (n) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
            const headers: Record<string, string> = {}
            Object.entries(request.headers ?? {}).forEach(([k, v]) => {
                if (k.toLowerCase() !== "range") headers[k] = v
            })
            headers["Range"] = "bytes=0-0"
            const response = await fetch(segmentUrl(request.template, n, request.pad), {...init, headers, signal: controller.signal})
            if (!(response.status === 200 || response.status === 206)) return false
            const total = /\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "")?.[1]
            const size = total ? parseInt(total) : (response.status === 200 ? Number(response.headers.get("Content-Length")) || 0 : 0)
            if (size) sizes.push(size)
            try {
                await response.body?.cancel()
            } catch (e) {
                // ignore
            }
            return true
        } catch (e) {
            return false
        } finally {
            clearTimeout(timer)
        }
    })
    return {...range, sizes}
}

// ---------- byte-range pieces of one whole file (e.g. DASH-style players without a visible manifest) ----------

// query parameters that only select a byte range of the same file
const BYTE_RANGE_PARAMS = ["bytestart", "byteend", "byte_start", "byte_end"]
const WHOLE_MEDIA_EXTENSIONS = ["mp4", "m4v", "m4a", "mp4a", "webm", "weba", "mov", "mkv", "mp3", "aac", "ogg", "opus", "flac", "wav", ""]

export type RangedRequest = {
    // the file's URL without byte-range parameters: every piece of one file has the same one
    url: string,
    start?: number,
    end?: number, // inclusive
}

/** Is the URL a stream segment by its name (seg-12.m4s, init-x.mp4, /segments/...)? */
export function looksLikeSegmentName(rawUrl: string): boolean {
    const parts = splitUrl(rawUrl)
    if (!parts) return false
    return SEGMENT_EXTENSIONS.includes(parts.extension)
        || /\/segments?\//i.test(parts.dir)
        || INIT_NAME.test(parts.name)
        || NUMBERED_SEGMENT.test(parts.name)
}

function parseRangeValue(value: string | null): { start: number, end?: number } | null {
    const m = value ? /^(?:bytes=)?(\d+)-(\d*)$/.exec(value.trim()) : null
    return m ? {start: parseInt(m[1]), end: m[2] ? parseInt(m[2]) : undefined} : null
}

/**
 * A request for a byte range of one whole media file, or null:
 * - byte-range query parameters (bytestart/byteend, range=100-199, or start/end when [contentLength] shows that
 *   they are byte offsets); the returned URL has them stripped
 * - a bounded Range header on a whole-file URL (not a stream segment)
 */
export function parseRangedRequest(rawUrl: string, rangeHeader?: string | null, contentLength?: number | null): RangedRequest | null {
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch (e) {
        return null
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    const params = url.searchParams
    const lower = new Map<string, string>()
    params.forEach((value, key) => lower.set(key.toLowerCase(), key))
    const strip = (...names: string[]) => names.forEach(n => {
        const key = lower.get(n)
        if (key !== undefined) params.delete(key)
    })
    const numberParam = (name: string) => {
        const key = lower.get(name)
        const value = key !== undefined ? params.get(key) : null
        return value !== null && /^\d+$/.test(value) ? parseInt(value) : undefined
    }
    let start: number | undefined
    let end: number | undefined
    let found = false
    if (BYTE_RANGE_PARAMS.some(p => lower.has(p))) {
        start = numberParam("bytestart") ?? numberParam("byte_start")
        end = numberParam("byteend") ?? numberParam("byte_end")
        strip(...BYTE_RANGE_PARAMS)
        found = true
    } else if (lower.has("range") && parseRangeValue(params.get(lower.get("range")!))) {
        const r = parseRangeValue(params.get(lower.get("range")!))!
        start = r.start
        end = r.end
        strip("range")
        found = true
    } else if (lower.has("start") && lower.has("end")) {
        // could be seconds: only byte offsets when the response is exactly that long
        const s = numberParam("start"), e = numberParam("end")
        if (s !== undefined && e !== undefined && e >= s && contentLength && contentLength === e - s + 1) {
            start = s
            end = e
            strip("start", "end")
            found = true
        }
    }
    if (found) {
        return {url: url.toString(), start, end}
    }
    if (isBoundedRange(rangeHeader) && !looksLikeSegmentName(rawUrl)) {
        const parts = splitUrl(rawUrl)
        if (parts && WHOLE_MEDIA_EXTENSIONS.includes(parts.extension)) {
            const r = parseRangeValue(rangeHeader!.replace(/\s+/g, ""))
            return {url: rawUrl, start: r?.start, end: r?.end}
        }
    }
    return null
}

/** Total size from "Content-Range: bytes 0-99/12345" */
export function totalFromContentRange(contentRange: string | null | undefined): number | undefined {
    const total = /\/(\d+)\s*$/.exec(contentRange ?? "")?.[1]
    return total ? parseInt(total) : undefined
}

export type ResourceProbeResult = {
    size?: number,
    rangeSupported: boolean,
    contentType?: string,
    // from the file's MP4 header (first bytes): what kind of track it holds and the picture height
    track?: SegmentTrack,
    height?: number,
}

const HEADER_BYTES = 8 * 1024

/**
 * Track type and picture height from the start of an MP4 file: "hdlr" boxes name the handler ("vide" / "soun"),
 * "tkhd" boxes end with width and height (16.16 fixed point). Servers often label audio files "video/mp4", so this
 * is the reliable way to tell a DASH-style audio file from a video file.
 */
export function sniffMp4Header(bytes: Uint8Array): { track?: SegmentTrack, height?: number } {
    let video = false, audio = false, height = 0
    const is = (i: number, tag: string) => bytes[i] === tag.charCodeAt(0) && bytes[i + 1] === tag.charCodeAt(1)
        && bytes[i + 2] === tag.charCodeAt(2) && bytes[i + 3] === tag.charCodeAt(3)
    for (let i = 4; i + 16 <= bytes.length; i++) {
        if (is(i, "hdlr")) {
            // size(4) "hdlr"(4) version+flags(4) pre_defined(4) handler_type(4)
            if (is(i + 12, "vide")) video = true
            if (is(i + 12, "soun")) audio = true
        } else if (is(i, "tkhd")) {
            const start = i - 4
            const size = ((bytes[start] << 24) >>> 0) + (bytes[start + 1] << 16) + (bytes[start + 2] << 8) + bytes[start + 3]
            if (size >= 84 && start + size <= bytes.length) {
                const h = start + size - 4
                const value = (bytes[h] << 8) | bytes[h + 1]
                if (value <= 8640) height = Math.max(height, value)
            }
        }
    }
    const track: SegmentTrack | undefined = video && audio ? "muxed" : video ? "video" : audio ? "audio" : undefined
    return {track, height: video && height ? height : undefined}
}

async function readHead(response: Response, max: number): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (total < max) {
            const {done, value} = await reader.read()
            if (done || !value) break
            chunks.push(value)
            total += value.length
        }
    } finally {
        reader.cancel().catch(() => undefined)
    }
    const head = new Uint8Array(Math.min(total, max))
    let offset = 0
    for (const chunk of chunks) {
        const part = chunk.subarray(0, Math.min(chunk.length, head.length - offset))
        head.set(part, offset)
        offset += part.length
        if (offset >= head.length) break
    }
    return head
}

/**
 * Full size of a file, whether its server answers Range requests, and its track type / picture height from its
 * MP4 header: one "Range: bytes=0-8191" request (only the first 8 KB are read even if the range is ignored).
 */
export async function probeResourceWithFetch(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<ResourceProbeResult | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
        const requestHeaders: Record<string, string> = {}
        Object.entries(headers).forEach(([k, v]) => {
            if (k.toLowerCase() !== "range") requestHeaders[k] = v
        })
        requestHeaders["Range"] = `bytes=0-${HEADER_BYTES - 1}`
        const response = await fetch(url, {...init, headers: requestHeaders, signal: controller.signal})
        const contentType = response.headers.get("Content-Type") ?? undefined
        let result: ResourceProbeResult | null = null
        if (response.status === 206) {
            result = {size: totalFromContentRange(response.headers.get("Content-Range")), rangeSupported: true, contentType}
        } else if (response.status === 200) {
            result = {size: Number(response.headers.get("Content-Length")) || undefined, rangeSupported: false, contentType}
        }
        if (result) {
            try {
                Object.assign(result, sniffMp4Header(await readHead(response, HEADER_BYTES)))
            } catch (e) {
                // no header info
            }
        } else {
            response.body?.cancel().catch(() => undefined)
        }
        return result
    } catch (e) {
        return null
    } finally {
        clearTimeout(timer)
    }
}
