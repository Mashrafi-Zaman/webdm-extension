import browser from "webextension-polyfill";
import {InterceptedMediaResult} from "~/linkgrabber/LinkGrabberResponse";
import {OnMediaInterceptedFromRequestListener} from "~/media/OnMediaInterceptedFromRequestListener";
import {DownloadableMedia, MediaOnTab} from "~/media/MediaOnTab";
import {sendMessage} from "webext-bridge/background";
import * as HLSUtils from "~/media/HLSUtils"
import {DefinedCommands} from "~/message/Commands";
import {TabMediaStore} from "~/media/TabMediaStore";
import type {ResourceProbeResult, SegmentProbeRequest, SegmentProbeResult} from "~/media/SegmentUtils";
import * as Backend from "~/backend/Backend";

type FrameRef = { tabId: number, frameId: number }

export class MediaRegistry implements OnMediaInterceptedFromRequestListener {
    // a promise so concurrent detections for one tab share a single restore from storage
    private readonly tabs = new Map<number, Promise<MediaOnTab>>()
    private readonly store = new TabMediaStore()
    // origin -> frames showing a document of that origin (from content-script reports); used to attribute
    // requests made by a page's service worker, which have no tab (tabId -1)
    private readonly framesByOrigin = new Map<string, FrameRef[]>()

    constructor() {
        HLSUtils.parseHLSSilently()
    }

    private getMediaOnTab(tabId: number): Promise<MediaOnTab> {
        let result = this.tabs.get(tabId)
        if (!result) {
            result = (async () => {
                const mediaOnTab = new MediaOnTab(tabId, {
                    onListUpdated(frameId: number, list: DownloadableMedia[]) {
                        onDownloadableMediaProcessed(tabId, frameId, list)
                    }
                }, this.store, (frameId, request) => probeFromPage(tabId, frameId, request),
                    (frameId, url) => probeResourceFromPage(tabId, frameId, url),
                    () => Backend.isJobTypeSupported("page"))
                await mediaOnTab.restore()
                return mediaOnTab
            })()
            this.tabs.set(tabId, result)
        }
        return result
    }

    /** Registers listeners synchronously; must be called at the top level of the background script. */
    boot() {
        browser.tabs.onRemoved.addListener(
            (tabId, _) => {
                const page = this.tabs.get(tabId)
                this.tabs.delete(tabId)
                page?.then(p => p.close())
                this.store.clear(tabId)
                this.forgetFrames(ref => ref.tabId === tabId)
            }
        )
        browser.tabs.onUpdated.addListener(
            (tabId, changeInfo, _) => {
                if (changeInfo.status === "loading" || changeInfo.url) {
                    // new page: forget media of the previous one (in memory and in storage)
                    // (single-page sites like YouTube change the URL without loading: list again for the new page)
                    this.tabs.get(tabId)?.then(p => {
                        p.reset()
                        if (changeInfo.url) p.publish()
                    })
                    this.store.clear(tabId)
                    this.forgetFrames(ref => ref.tabId === tabId)
                } else if (changeInfo.title) {
                    // entries are named after the page title: list again when it changes
                    this.tabs.get(tabId)?.then(p => p.publish())
                }
            }
        )
    }

    private forgetFrames(predicate: (ref: FrameRef) => boolean) {
        for (const [origin, refs] of this.framesByOrigin) {
            const kept = refs.filter(ref => !predicate(ref))
            if (kept.length) {
                this.framesByOrigin.set(origin, kept)
            } else {
                this.framesByOrigin.delete(origin)
            }
        }
    }

    /** A content script (in any frame) started or re-announced itself. */
    async onFrameReported(tabId: number, frameId: number, frameUrl: string) {
        if (tabId < 0) {
            return
        }
        const origin = originOf(frameUrl)
        if (origin) {
            this.forgetFrames(ref => ref.tabId === tabId && ref.frameId === frameId)
            this.framesByOrigin.set(origin, [...(this.framesByOrigin.get(origin) ?? []), {tabId, frameId}])
        }
        const mediaOnTab = await this.getMediaOnTab(tabId)
        await mediaOnTab.setFrameUrl(frameId, frameUrl)
    }

    async onMediaDetected(tabId: number, mediaResult: InterceptedMediaResult, initiator?: string) {
        if (tabId < 0) {
            const ref = await this.attributeToFrame(initiator)
            if (!ref) {
                return
            }
            tabId = ref.tabId
            mediaResult = {...mediaResult, frameId: ref.frameId}
        }
        const mediaOnTab = await this.getMediaOnTab(tabId)
        await mediaOnTab.process(mediaResult)
    }

    /**
     * Requests from a page's service worker have tabId -1. Attribute them by their initiator (the origin of the
     * page that registered the worker): a frame of that origin we know about, else a tab showing that origin.
     */
    private async attributeToFrame(initiator: string | undefined): Promise<FrameRef | null> {
        const origin = initiator ? originOf(initiator) : null
        if (!origin) {
            return null
        }
        const known = this.framesByOrigin.get(origin)
        if (known?.length) {
            return known[known.length - 1] // most recently reported
        }
        try {
            const tabs = (await browser.tabs.query({}))
                .filter(tab => tab.id !== undefined && tab.url && originOf(tab.url) === origin)
            const tab = tabs.find(t => t.active) ?? (tabs.length === 1 ? tabs[0] : undefined)
            return tab?.id !== undefined ? {tabId: tab.id, frameId: 0} : null
        } catch (e) {
            return null
        }
    }

    /** Re-send the tab's current lists (e.g. when a content script (re)starts). */
    async publish(tabId: number) {
        if (tabId < 0) {
            return
        }
        const mediaOnTab = await this.getMediaOnTab(tabId)
        await mediaOnTab.publish()
    }

    async onFrameVideoDuration(tabId: number, frameId: number, duration: number) {
        if (tabId < 0) {
            return
        }
        await (await this.getMediaOnTab(tabId)).setFrameDuration(frameId, duration)
    }

    /** What WebDM currently knows about a tab (for the debug export; header values redacted). */
    async snapshot(tabId: number) {
        return (await this.getMediaOnTab(tabId)).getStateSnapshot()
    }

    async getFrameUrl(tabId: number, frameId: number): Promise<string | undefined> {
        if (tabId < 0) {
            return undefined
        }
        return (await this.getMediaOnTab(tabId)).getFrameUrl(frameId)
    }
}

function originOf(url: string): string | null {
    try {
        const origin = new URL(url).origin
        return origin && origin !== "null" ? origin : null
    } catch (e) {
        return null
    }
}

/** Ask the frame's content script to probe segment numbers (its requests carry the page's Referer). */
async function probeResourceFromPage(tabId: number, frameId: number, url: string): Promise<ResourceProbeResult | null> {
    try {
        return await sendMessage(
            DefinedCommands.PROBE_RESOURCE,
            url,
            {tabId: tabId, frameId: frameId, context: "content-script"},
        )
    } catch (e) {
        return null
    }
}

async function probeFromPage(tabId: number, frameId: number, request: SegmentProbeRequest): Promise<SegmentProbeResult | null> {
    try {
        return await sendMessage(
            DefinedCommands.PROBE_SEGMENT_RANGE,
            request,
            {tabId: tabId, frameId: frameId, context: "content-script"},
        )
    } catch (e) {
        return null
    }
}

async function onDownloadableMediaProcessed(
    tabId: number,
    frameId: number,
    downloadableMedia: DownloadableMedia[],
) {
    try {
        await sendMessage(
            DefinedCommands.DOWNLOADABLE_MEDIA_DETECTED,
            downloadableMedia,
            {
                tabId: tabId,
                frameId: frameId,
                context: "content-script"
            }
        )
    } catch (e) {
        console.debug("[webdm] media list not delivered to frame", tabId, frameId, e)
    }
}
