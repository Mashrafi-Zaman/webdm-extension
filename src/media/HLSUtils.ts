import {MasterPlaylist, MediaPlaylist} from "hls-parser/types";
import HLS from "hls-parser";

export function parseHLSSilently() {
    HLS.setOptions({
        silent: true,
    })
}

/**
 * none: not encrypted
 * aes-128: whole-segment AES-128 with a key from the playlist's URI (downloadable)
 * sample-aes: SAMPLE-AES with a plain key (needs ffmpeg in the app)
 * drm: Widevine / PlayReady / FairPlay key formats (never downloadable; no workarounds)
 */
export type HLSEncryption = "none" | "aes-128" | "sample-aes" | "drm"

type KeyLike = { method?: string, format?: string }

// KEYFORMAT values of DRM systems (lowercased)
const DRM_KEY_FORMATS = [
    "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
    "com.widevine",
    "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
    "com.microsoft.playready",
    "com.apple.streamingkeydelivery", // FairPlay
    "urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2", // FairPlay
]

function classifyKey(key: KeyLike | null | undefined): HLSEncryption {
    const method = key?.method?.toUpperCase()
    if (!method || method === "NONE") {
        return "none"
    }
    const format = key?.format?.toLowerCase()
    if (format && DRM_KEY_FORMATS.some(drm => format.startsWith(drm))) {
        return "drm"
    }
    if (method === "AES-128") {
        return "aes-128"
    }
    if (method === "SAMPLE-AES" && (!format || format === "identity")) {
        return "sample-aes"
    }
    // SAMPLE-AES-CTR (CENC) and other key formats are DRM in practice
    return "drm"
}

function strongest(values: HLSEncryption[]): HLSEncryption {
    const order: HLSEncryption[] = ["drm", "sample-aes", "aes-128", "none"]
    return order.find(o => values.includes(o)) ?? "none"
}

export function getMasterPlaylistEncryption(playlist: MasterPlaylist): HLSEncryption {
    return strongest(playlist.sessionKeyList.map(classifyKey))
}

export function getMediaPlaylistEncryption(playlist: MediaPlaylist): HLSEncryption {
    return strongest(playlist.segments.map(segment => classifyKey(segment.key)))
}

// lowercase; compared against the lowercased Content-Type
export const HLS_CONTENT_TYPES = [
    "application/x-mpegurl",
    "application/vnd.apple.mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
]

export function isHLSContentType(contentType: string | null | undefined) {
    if (!contentType) {
        return false
    }
    const type = contentType.toLowerCase()
    return HLS_CONTENT_TYPES.some(item => type.startsWith(item))
}

/** HLS playlist by URL (.m3u8 path) or by response Content-Type. */
export function isHLSPlaylist(url: string, contentType: string | null | undefined) {
    if (isHLSContentType(contentType)) {
        return true
    }
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".m3u8")
    } catch (e) {
        return false
    }
}
export const MAX_HLS_PLAYLIST_SIZE = 2 * 1024 * 1024 // 2MiB

export const DASH_CONTENT_TYPES = ["application/dash+xml"]

/** DASH manifest by URL (.mpd path) or by response Content-Type. */
export function isDASHManifest(url: string, contentType: string | null | undefined) {
    const type = contentType?.toLowerCase()
    if (type && DASH_CONTENT_TYPES.some(item => type.startsWith(item))) {
        return true
    }
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".mpd")
    } catch (e) {
        return false
    }
}

/** Segment file types of HLS playlists we can list; fMP4 playlists are saved as .mp4 */
export const HLS_TS_SEGMENT_EXTENSIONS = ["ts", "aac", "mp3", "ac3", "ec3"]
export const HLS_FMP4_SEGMENT_EXTENSIONS = ["m4s", "mp4", "m4a", "m4v", "cmfv", "cmfa", "fmp4"]