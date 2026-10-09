import {sendMessage} from "webext-bridge/content-script";
import {DefinedCommands} from "~/message/Commands";
import {debounce} from "~/utils/Debaunce";
import type {ReportedMedia} from "~/linkgrabber/DownloadLinkInterceptor";
import type {DetectionLogEntry} from "~/media/DetectionDebugLog";
import {isSegmentRequest} from "~/media/SegmentUtils";
import * as Configs from "~/configs/Config";

/**
 * Tells the background about media this frame knows of but the background may not have seen as a request:
 * - playlists found by the MAIN-world page hook (fetch/XHR bodies starting with #EXTM3U, incl. blob: URLs)
 * - segment URLs the page appended to a MediaSource (from the page hook), with the SourceBuffer mime type
 * - playlists / media files / segments in Resource Timing (loaded before this script ran, e.g. after an
 *   extension reload, or from cache)
 * - <video>/<audio> sources (also ones added later, via the loadedmetadata event) and the main video's duration
 * Each report also carries this frame's URL, so the background can route the media list to this frame.
 * In debug mode it also forwards what it saw, for the detection log.
 */

export type PageDebugEvent = Omit<DetectionLogEntry, "time" | "frameId" | "frameUrl">

const HOOK_EVENT = "webdm:page-media"
const CONTENT_READY_EVENT = "webdm:content-ready"
const HOOK_READY_EVENT = "webdm:hook-ready"
const MEDIA_FILE_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "m4a", "mp3", "aac", "ogg", "oga", "opus", "wav", "flac"]

const reported = new Set<string>()
let pending: ReportedMedia[] = []
let pendingDebug: PageDebugEvent[] = []
let lastDuration: number | null = null
let durationChanged = false
const flushSoon = debounce(300)

function isDebug() {
    try {
        return Configs.getLatestConfig().debug
    } catch (e) {
        return false
    }
}

function classifyUrl(rawUrl: string): ReportedMedia["kind"] | null {
    try {
        const url = new URL(rawUrl, location.href)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null
        }
        const path = url.pathname.toLowerCase()
        if (path.endsWith(".m3u8")) return "hls"
        if (path.endsWith(".mpd")) return "dash"
        // segments (seg-12.m4s, init-x.mp4, chunk-3, ...) are never offered as files of their own
        if (isSegmentRequest(url.href)) return "segment"
        const extension = path.split("/").pop()?.split(".").pop()
        if (extension && MEDIA_FILE_EXTENSIONS.includes(extension)) return "http"
        return null
    } catch (e) {
        return null
    }
}

function queue(item: ReportedMedia) {
    // MSE reports of the same URL may add the mime type later
    const key = `${item.kind}:${item.url}:${item.mime ?? ""}`
    if (reported.has(key)) {
        return
    }
    reported.add(key)
    pending.push(item)
    flushSoon(flush)
}

function debugEvent(event: PageDebugEvent) {
    if (!isDebug()) {
        return
    }
    pendingDebug.push(event)
    flushSoon(flush)
}

async function flush() {
    const items = pending
    const debugEvents = pendingDebug
    pending = []
    pendingDebug = []
    const duration = durationChanged ? lastDuration : null
    durationChanged = false
    await send(items, duration, debugEvents)
}

async function send(items: ReportedMedia[], videoDuration: number | null = lastDuration, debugEvents: PageDebugEvent[] = []) {
    try {
        await sendMessage(DefinedCommands.REPORT_FRAME_MEDIA, {
            frameUrl: location.href,
            items,
            videoDuration,
            debugEvents: debugEvents.length ? debugEvents : undefined,
        }, "background")
    } catch (e) {
        // background not reachable (e.g. extension reloaded)
    }
}

function scanResources() {
    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
        const kind = classifyUrl(entry.name)
        if (kind) {
            const url = new URL(entry.name, location.href).href
            queue({url, kind})
            debugEvent({
                source: "performance", url, requestType: entry.initiatorType,
                size: entry.encodedBodySize || entry.transferSize || null, classification: kind,
            })
        }
    }
}

function biggestVideo(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null
    let bestArea = -1
    document.querySelectorAll("video").forEach(video => {
        const area = video.clientWidth * video.clientHeight
        if (area > bestArea) {
            best = video
            bestArea = area
        }
    })
    return best
}

function updateDuration() {
    const duration = biggestVideo()?.duration
    if (duration && Number.isFinite(duration) && duration > 0 && duration !== lastDuration) {
        lastDuration = duration
        durationChanged = true
        flushSoon(flush)
    }
}

function reportMediaElement(element: HTMLMediaElement) {
    const src = element.currentSrc || element.src
    if (src) {
        debugEvent({source: "media-element", url: src, requestType: element.tagName.toLowerCase(), classification: classifyUrl(src) ?? "ignored"})
    }
    // blob:/MediaSource players are found through their playlist / segments (page hook / requests)
    if (src && /^https?:/i.test(src)) {
        const kind = classifyUrl(src) ?? "http"
        queue({url: new URL(src, location.href).href, kind})
    }
    updateDuration()
}

function scanMediaElements() {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach(reportMediaElement)
}

type HookMessage = {
    url?: string, kind?: string, content?: string | null, mime?: string | null,
    requestType?: string, contentType?: string | null, size?: number | null, classification?: string | null,
}

export function startPageMediaReporter() {
    // from the MAIN-world page hook. It buffers what it found before we started and replays it when we announce
    // ourselves (CONTENT_READY); if the hook is injected after us, it asks us to announce again (HOOK_READY)
    const announce = () => document.dispatchEvent(new CustomEvent(CONTENT_READY_EVENT, {
        detail: JSON.stringify({debug: isDebug()}),
    }))
    document.addEventListener(HOOK_READY_EVENT, announce)
    Configs.onChanged.addEventListener(() => announce())
    document.addEventListener(HOOK_EVENT, (event) => {
        let data: HookMessage
        try {
            data = JSON.parse((event as CustomEvent<string>).detail)
        } catch (e) {
            return // not ours / malformed
        }
        if (!data || typeof data.url !== "string") {
            return
        }
        if (data.kind === "hls" || data.kind === "dash") {
            queue({url: data.url, kind: data.kind, content: typeof data.content === "string" ? data.content : null})
        } else if (data.kind === "segment") {
            queue({url: data.url, kind: "segment", mime: typeof data.mime === "string" ? data.mime : null})
            debugEvent({source: "mse", url: data.url, mime: data.mime ?? undefined, classification: "appended to SourceBuffer"})
        } else if (data.kind === "debug") {
            debugEvent({
                source: data.requestType === "mse" ? "mse" : "hook",
                url: data.url,
                requestType: data.requestType,
                contentType: data.contentType,
                size: data.size,
                mime: data.mime ?? undefined,
                classification: data.classification ?? undefined,
            })
        }
    })
    // players created after load (media events don't bubble: listen in the capture phase)
    document.addEventListener("loadedmetadata", (event) => {
        if (event.target instanceof HTMLMediaElement) {
            reportMediaElement(event.target)
        }
    }, true)
    document.addEventListener("durationchange", updateDuration, true)

    announce()
    // announce this frame (and let the background re-send what it knows), then report what's already loaded
    send([])
    const scan = () => {
        scanResources()
        scanMediaElements()
    }
    scan()
    if (document.readyState !== "complete") {
        window.addEventListener("load", scan, {once: true})
    }
}
