import ContentScriptEntryBuilder from "~/contentscripts/ContentScript";

// The background also injects this script into tabs that were open before install/update/startup, so it
// can run twice in one page. Skip if a live instance is already running; after an extension reload the
// old instance's runtime is invalidated (chrome.runtime.id is gone), so a fresh instance starts.
type ContentScriptMarker = { isAlive: () => boolean }
const globalScope = window as unknown as { __webdmContentScript?: ContentScriptMarker }

if (!globalScope.__webdmContentScript?.isAlive()) {
    globalScope.__webdmContentScript = {
        isAlive: () => {
            try {
                return !!chrome.runtime?.id
            } catch (e) {
                return false
            }
        },
    }
    ContentScriptEntryBuilder.create().start()
}
