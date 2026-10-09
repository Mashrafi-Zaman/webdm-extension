import browser from "webextension-polyfill";
import {IS_MV3} from "~/utils/ManifestUtil";

/**
 * Declared content scripts only run in pages loaded after the extension starts. Tabs that were already
 * open when the extension was installed, updated or reloaded would get no content script (no media
 * button, no selection popup) until the user reloaded them, so we inject it into those tabs ourselves.
 * The content script ignores a second injection into a page where it's still alive.
 */
export function registerContentScriptInjection() {
    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === "install" || details.reason === "update") {
            injectIntoOpenTabs()
        }
    })
    browser.runtime.onStartup.addListener(() => {
        injectIntoOpenTabs()
    })
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
                await chrome.scripting.executeScript({
                    target: {tabId: tab.id},
                    files: files,
                })
            } else {
                for (const file of files) {
                    await browser.tabs.executeScript(tab.id, {file: "/" + file})
                }
            }
        } catch (e) {
            // pages we may not script (web store, error pages, ...)
        }
    }))
}
