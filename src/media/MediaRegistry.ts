import browser from "webextension-polyfill";
import {InterceptedMediaResult} from "~/linkgrabber/LinkGrabberResponse";
import {OnMediaInterceptedFromRequestListener} from "~/media/OnMediaInterceptedFromRequestListener";
import {DownloadableMedia, MediaOnTab} from "~/media/MediaOnTab";
import {sendMessage} from "webext-bridge/background";
import * as HLSUtils from "~/media/HLSUtils"
import {DefinedCommands} from "~/message/Commands";
import {TabMediaStore} from "~/media/TabMediaStore";

export class MediaRegistry implements OnMediaInterceptedFromRequestListener {
    // a promise so concurrent detections for one tab share a single restore from storage
    private readonly tabs = new Map<number, Promise<MediaOnTab>>()
    private readonly store = new TabMediaStore()

    constructor() {
        HLSUtils.parseHLSSilently()
    }

    private getMediaOnTab(tabId: number): Promise<MediaOnTab> {
        let result = this.tabs.get(tabId)
        if (!result) {
            result = (async () => {
                const mediaOnTab = new MediaOnTab(tabId, {
                    onListUpdated(list: DownloadableMedia[]) {
                        onDownloadableMediaProcessed(tabId, list)
                    }
                }, this.store)
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
            }
        )
        browser.tabs.onUpdated.addListener(
            (tabId, changeInfo, _) => {
                if (changeInfo.status === "loading" || changeInfo.url) {
                    // new page: forget media of the previous one (in memory and in storage)
                    this.tabs.get(tabId)?.then(p => p.reset())
                    this.store.clear(tabId)
                }
            }
        )
    }

    async onMediaDetected(tabId: number, mediaResult: InterceptedMediaResult) {
        if (tabId < 0) {
            return
        }
        const mediaOnTab = await this.getMediaOnTab(tabId)
        await mediaOnTab.process(mediaResult)
    }

    /** Re-send the tab's current list (e.g. when a content script (re)starts). */
    async publish(tabId: number) {
        if (tabId < 0) {
            return
        }
        const mediaOnTab = await this.getMediaOnTab(tabId)
        await mediaOnTab.publish()
    }
}

async function onDownloadableMediaProcessed(
    tabId: number,
    downloadableMedia: DownloadableMedia[],
) {
    try {
        await sendMessage(
            DefinedCommands.DOWNLOADABLE_MEDIA_DETECTED,
            downloadableMedia,
            {
                tabId: tabId,
                context: "content-script"
            }
        )
    } catch (e) {
        console.debug("[webdm] media list not delivered to tab", tabId, e)
    }
}
