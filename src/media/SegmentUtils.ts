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
