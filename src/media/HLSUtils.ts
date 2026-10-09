import {MasterPlaylist, MediaPlaylist} from "hls-parser/types";
import HLS from "hls-parser";

export function parseHLSSilently() {
    HLS.setOptions({
        silent: true,
    })
}

export function isPlayListEncrypted(playlist: MasterPlaylist) {
    return playlist
        .sessionKeyList
        .some(key => key.method && key.method !== "NONE");
}

export function isMediaPlayListEncrypted(playlist: MediaPlaylist) {
    return playlist.segments.some(
        segment =>
            segment.key &&
            segment.key.method &&
            segment.key.method !== "NONE"
    );
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