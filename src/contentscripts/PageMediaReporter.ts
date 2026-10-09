import {sendMessage} from "webext-bridge/content-script";
import {DefinedCommands} from "~/message/Commands";
import {debounce} from "~/utils/Debaunce";
import type {ReportedMedia} from "~/linkgrabber/DownloadLinkInterceptor";

/**
 * Tells the background about media this frame knows of but the background may not have seen as a request:
 * - playlists found by the MAIN-world page hook (fetch/XHR bodies starting with #EXTM3U, incl. blob: URLs)
 * - playlists / media files in Resource Timing (loaded before this script ran, e.g. after an extension
 *   reload, or from cache)
 * - <video>/<audio> sources (also ones added later, via the loadedmetadata event)
 * Each report also carries this frame's URL, so the background can route the media list to this frame.
 */

const HOOK_EVENT = "webdm:page-media"
const CONTENT_READY_EVENT = "webdm:content-ready"
const HOOK_READY_EVENT = "webdm:hook-ready"
const MEDIA_FILE_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "m4a", "mp3", "aac", "ogg", "oga", "opus", "wav", "flac"]

const reported = new Set<string>()
let pending: ReportedMedia[] = []
const flushSoon = debounce(300)

function classifyUrl(rawUrl: string): ReportedMedia["kind"] | null {
    try {
        const url = new URL(rawUrl, location.href)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null
        }
        const path = url.pathname.toLowerCase()
        if (path.endsWith(".m3u8")) return "hls"
        if (path.endsWith(".mpd")) return "dash"
        const extension = path.split("/").pop()?.split(".").pop()
        if (extension && MEDIA_FILE_EXTENSIONS.includes(extension)) return "http"
        return null
    } catch (e) {
        return null
    }
}

function queue(item: ReportedMedia) {
    const key = `${item.kind}:${item.url}`
    if (reported.has(key)) {
        return
    }
    reported.add(key)
    pending.push(item)
    flushSoon(flush)
}

async function flush() {
    const items = pending
    pending = []
    await send(items)
}

async function send(items: ReportedMedia[]) {
    try {
        await sendMessage(DefinedCommands.REPORT_FRAME_MEDIA, {frameUrl: location.href, items}, "background")
    } catch (e) {
        // background not reachable (e.g. extension reloaded)
    }
}

function scanResources() {
    for (const entry of performance.getEntriesByType("resource")) {
        const kind = classifyUrl(entry.name)
        if (kind) {
            queue({url: new URL(entry.name, location.href).href, kind})
        }
    }
}

function reportMediaElement(element: HTMLMediaElement) {
    const src = element.currentSrc || element.src
    if (!src) {
        return
    }
    // blob:/MediaSource players are found through their playlist (page hook / requests)
    if (!/^https?:/i.test(src)) {
        return
    }
    queue({url: new URL(src, location.href).href, kind: classifyUrl(src) ?? "http"})
}

function scanMediaElements() {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach(reportMediaElement)
}

export function startPageMediaReporter() {
    // from the MAIN-world page hook. It buffers what it found before we started and replays it when we announce
    // ourselves (CONTENT_READY); if the hook is injected after us, it asks us to announce again (HOOK_READY)
    const announce = () => document.dispatchEvent(new CustomEvent(CONTENT_READY_EVENT))
    document.addEventListener(HOOK_READY_EVENT, announce)
    document.addEventListener(HOOK_EVENT, (event) => {
        try {
            const data = JSON.parse((event as CustomEvent<string>).detail) as ReportedMedia
            if (data && typeof data.url === "string" && (data.kind === "hls" || data.kind === "dash")) {
                queue({url: data.url, kind: data.kind, content: typeof data.content === "string" ? data.content : null})
            }
        } catch (e) {
            // not ours / malformed
        }
    })
    // players created after load (media events don't bubble: listen in the capture phase)
    document.addEventListener("loadedmetadata", (event) => {
        if (event.target instanceof HTMLMediaElement) {
            reportMediaElement(event.target)
        }
    }, true)

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
