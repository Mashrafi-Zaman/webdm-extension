import browser from "webextension-polyfill";
import {getLatestConfig} from "~/configs/Config";

/**
 * Optional log of media-related requests per tab, for debugging detection on real sites
 * ("debug" setting -> toolbar popup -> "Export detection log"). Only recorded while debug is on.
 */

export type DetectionLogSource = "webRequest" | "hook" | "performance" | "media-element" | "mse"

export type DetectionLogEntry = {
    time: string,
    source: DetectionLogSource,
    url: string,
    frameId?: number,
    frameUrl?: string,
    requestType?: string, // webRequest resource type (media, xmlhttprequest, ...) or fetch/xhr for the hook
    method?: string,
    statusCode?: number,
    contentType?: string | null,
    size?: number | null,
    range?: string | null,
    initiator?: string,
    requestHeaders?: Record<string, string>,
    // what WebDM decided: hls / dash / segment / init / media / ignored ...
    classification?: string,
    // MSE: SourceBuffer mime type / codecs the bytes were appended to
    mime?: string,
}

const MAX_ENTRIES_PER_TAB = 3000
const SENSITIVE_HEADERS = ["cookie", "authorization", "proxy-authorization", "x-api-key", "x-auth-token", "x-csrf-token"]

const logs = new Map<number, DetectionLogEntry[]>()
const dirtyTabs = new Set<number>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function session(): browser.Storage.StorageArea | null {
    return (browser.storage as unknown as { session?: browser.Storage.StorageArea }).session ?? null
}

const key = (tabId: number) => `detectionLog:${tabId}`

export function isDebugEnabled(): boolean {
    try {
        return getLatestConfig().debug
    } catch (e) {
        return false
    }
}

/** Header values that could identify the user are replaced; everything else is kept for debugging. */
export function redactHeaders(headers: Record<string, string> | Headers | undefined | null): Record<string, string> | undefined {
    if (!headers) {
        return undefined
    }
    const out: Record<string, string> = {}
    const add = (name: string, value: string) => {
        out[name] = SENSITIVE_HEADERS.includes(name.toLowerCase()) ? "[redacted]" : value
    }
    if (headers instanceof Headers) {
        headers.forEach((value, name) => add(name, value))
    } else {
        Object.entries(headers).forEach(([name, value]) => add(name, value))
    }
    return out
}

export function recordDetection(tabId: number, entry: Omit<DetectionLogEntry, "time">) {
    if (tabId < 0 || !isDebugEnabled()) {
        return
    }
    let list = logs.get(tabId)
    if (!list) {
        list = []
        logs.set(tabId, list)
    }
    list.push({time: new Date().toISOString(), ...entry, requestHeaders: redactHeaders(entry.requestHeaders)})
    if (list.length > MAX_ENTRIES_PER_TAB) {
        list.splice(0, list.length - MAX_ENTRIES_PER_TAB)
    }
    dirtyTabs.add(tabId)
    scheduleSave()
}

function scheduleSave() {
    if (saveTimer !== null) {
        return
    }
    // mirror to storage.session (survives service-worker restarts), at most every 2s
    saveTimer = setTimeout(async () => {
        saveTimer = null
        const area = session()
        if (!area) {
            dirtyTabs.clear()
            return
        }
        const items: Record<string, DetectionLogEntry[]> = {}
        dirtyTabs.forEach(tabId => items[key(tabId)] = logs.get(tabId) ?? [])
        dirtyTabs.clear()
        try {
            await area.set(items)
        } catch (e) {
            // quota: the in-memory log is still exported
        }
    }, 2000)
}

export async function getDetectionLog(tabId: number): Promise<DetectionLogEntry[]> {
    const inMemory = logs.get(tabId)
    if (inMemory?.length) {
        return inMemory
    }
    try {
        const stored = (await session()?.get(key(tabId)))?.[key(tabId)] as DetectionLogEntry[] | undefined
        return stored ?? []
    } catch (e) {
        return []
    }
}

export function clearDetectionLog(tabId: number) {
    logs.delete(tabId)
    session()?.remove(key(tabId)).catch(() => {})
}
