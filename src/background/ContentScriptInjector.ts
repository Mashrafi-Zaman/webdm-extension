import browser from "webextension-polyfill";
import {IS_MV3} from "~/utils/ManifestUtil";

/**
 * Declared content scripts only run in pages loaded after the extension starts. Tabs that were already
 * open when the extension was installed, updated or reloaded would get no content script (no media
 * button, no selection popup) until the user reloaded them, so we inject it into those tabs ourselves
 * (all frames, since players are often in iframes). The content script ignores a second injection into a
 * page where it's still alive.
 *
 * Also registers the MAIN-world page hook (public/webdm-page-hook.js), which spots playlists that players
 * fetch from URLs not ending in .m3u8 (or from blob: URLs). Chrome only: Firefox MV2 has no MAIN world.
 */
export function registerContentScriptInjection() {
    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === "install" || details.reason === "update") {
            setUpAndInject()
        }
    })
    browser.runtime.onStartup.addListener(() => {
        setUpAndInject()
    })
}

const PAGE_HOOK_ID = "webdm-page-hook"
const PAGE_HOOK_FILE = "webdm-page-hook.js"

async function setUpAndInject() {
    await registerPageHook()
    await injectIntoOpenTabs()
}

async function registerPageHook() {
    if (!IS_MV3 || !chrome.scripting?.registerContentScripts) {
        return
    }
    const script: chrome.scripting.RegisteredContentScript = {
        id: PAGE_HOOK_ID,
        js: [PAGE_HOOK_FILE],
        matches: ["*://*/*"],
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
    }
    try {
        const existing = await chrome.scripting.getRegisteredContentScripts({ids: [PAGE_HOOK_ID]})
        if (existing.length) {
            await chrome.scripting.updateContentScripts([script])
        } else {
            await chrome.scripting.registerContentScripts([script])
        }
    } catch (e) {
        console.warn("can't register the page hook", e)
    }
}

function getContentScriptFiles(): string[] {
    const contentScripts = browser.runtime.getManifest().content_scripts ?? []
    return contentScripts.flatMap(cs => cs.js ?? [])
}

async function injectIntoOpenTabs() {
    const files = getContentScriptFiles()
    if (files.length === 0) {
        return
    }
    let tabs: browser.Tabs.Tab[]
    try {
        tabs = await browser.tabs.query({url: ["http://*/*", "https://*/*"]})
    } catch (e) {
        return
    }
    await Promise.all(tabs.map(async (tab) => {
        if (tab.id === undefined || tab.discarded) {
            return
        }
        try {
            if (IS_MV3) {
                const target = {tabId: tab.id, allFrames: true}
                // the hook first, so the page's later playlist requests are seen
                await chrome.scripting.executeScript({target, files: [PAGE_HOOK_FILE], world: "MAIN"})
                    .catch(() => {})
                await chrome.scripting.executeScript({target, files: files})
            } else {
                for (const file of files) {
                    await browser.tabs.executeScript(tab.id, {file: "/" + file, allFrames: true})
                }
            }
        } catch (e) {
            // pages we may not script (web store, error pages, ...)
        }
    }))
}
