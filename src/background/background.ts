import browser from "webextension-polyfill";
import {initializeOptions, registerContextMenuClickHandler} from "~/contextmenus/ContextMenus";
import * as backend from "~/backend/Backend"
import * as Backend from "~/backend/Backend"
import {redirectDownloadLinksToMe} from "~/linkgrabber/LinkGrabber";
import {onMessage} from "webext-bridge/background";
import {addDownload, getHeadersForUrls} from "~/background/actions";
import {keepListeningToEvents} from "~/utils/extension-api";
import {IS_MV3} from "~/utils/ManifestUtil";
import {setHoldingKey} from "~/background/BackgroundSharedState";
import {DefinedCommands} from "~/message/Commands";
import {defineExtensionEntry} from "~/utils/DefineExtensionEntry";
import platformInfoProvider from "~/utils/platform/InitPlatformFromBackground";
import BackgroundEntryType from "~/utils/EntryPointTypes/background/BackgroundEntryType";
import {setBackgroundReady, whenBackgroundReady} from "~/background/BackgroundReady";
import {registerContentScriptInjection} from "~/background/ContentScriptInjector";
import {MediaRegistry} from "~/media/MediaRegistry";
import {DownloadLinkInterceptor} from "~/linkgrabber/DownloadLinkInterceptor";

function receiveMessageFromContentScripts(
    mediaRegistry: MediaRegistry,
    interceptor: DownloadLinkInterceptor,
) {
    onMessage(DefinedCommands.ADD_DOWNLOAD, async (msg) => {
        await whenBackgroundReady()
        return await addDownload(msg.data)
    })
    onMessage(DefinedCommands.TEST_HTTP_PORT, async (msg) => {
        await whenBackgroundReady()
        return await backend.httpPing(msg.data)
    })
    onMessage(DefinedCommands.TEST_NATIVE_MESSAGING, async (msg) => {
        await whenBackgroundReady()
        return await backend.nativeMessagingPing()
    })
    onMessage(DefinedCommands.IS_APP_REACHABLE, async (msg) => {
        await whenBackgroundReady()
        return await backend.isAppReachable()
    })
    onMessage(DefinedCommands.SHOW_LOG, (msg) => {
        console.log(...msg.data)
    })
    onMessage(DefinedCommands.GET_HEADERS, async (msg) => {
        await whenBackgroundReady()
        return await getHeadersForUrls(msg.data)
    })
    onMessage(DefinedCommands.SET_HOLDING_KEY, async (msg) => {
        setHoldingKey(msg.data)
    })
    onMessage(DefinedCommands.GET_PLATFORM, async () => {
        await whenBackgroundReady()
        return await platformInfoProvider.getPlatformInfo()
    })
    onMessage(DefinedCommands.REPORT_FRAME_MEDIA, async (msg) => {
        await whenBackgroundReady()
        const tabId = msg.sender.tabId
        // webext-bridge leaves out the frame id of the top frame
        const frameId = msg.sender.frameId ?? 0
        if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId)) {
            return
        }
        const {frameUrl, items} = msg.data
        let pageUrl: string | null = null
        try {
            pageUrl = (await browser.tabs.get(tabId)).url ?? null
        } catch (e) {
            // tab is gone
        }
        await mediaRegistry.onFrameReported(tabId, frameId, frameUrl)
        interceptor.onMediaReportedByFrame(tabId, frameId, frameUrl, pageUrl, items)
        // also re-send what we already know for this tab (restored from storage.session)
        await mediaRegistry.publish(tabId)
    })
}

/**
 * Everything that must be registered synchronously when the (MV3) service worker starts: events that
 * wake the worker are only delivered to listeners added before the first `await`.
 */
export function registerBackgroundListeners() {
    if (IS_MV3) {
        keepListeningToEvents()
    }
    registerContentScriptInjection()
    registerContextMenuClickHandler()
    const {mediaRegistry, interceptor} = redirectDownloadLinksToMe()
    receiveMessageFromContentScripts(mediaRegistry, interceptor)
}

export default defineExtensionEntry()
    .withType(BackgroundEntryType)
    .withInit(async () => {
        try {
            // platform info and configs are loaded at this point; let the waiting listeners run
            setBackgroundReady()
            // native messaging check runs in the background, it must not delay anything
            Backend.boot()
            await initializeOptions()
            console.log("WebDM Integration loaded successfully")
        } catch (e) {
            console.log("extension loading fail", e)
            throw e
        }
    })
