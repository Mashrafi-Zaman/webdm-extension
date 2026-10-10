import browser from "webextension-polyfill";
import type {TabMediaState} from "~/media/MediaOnTab";

/**
 * Keeps each tab's detected media in storage.session so it survives MV3 service-worker restarts.
 * Falls back to memory where storage.session is unavailable.
 * storage.session is cleared when the extension is reloaded/updated and when the browser restarts.
 */
export class TabMediaStore {
    private readonly memory = new Map<number, TabMediaState>()

    private get session(): browser.Storage.StorageArea | null {
        return (browser.storage as unknown as { session?: browser.Storage.StorageArea }).session ?? null
    }

    private key(tabId: number) {
        return `tabMedia:${tabId}`
    }

    async load(tabId: number): Promise<TabMediaState | null> {
        const session = this.session
        if (!session) {
            return this.memory.get(tabId) ?? null
        }
        try {
            const key = this.key(tabId)
            const result = await session.get(key)
            return (result[key] as TabMediaState | undefined) ?? null
        } catch (e) {
            return null
        }
    }

    async save(tabId: number, state: TabMediaState) {
        const session = this.session
        if (!session) {
            this.memory.set(tabId, state)
            return
        }
        try {
            await session.set({[this.key(tabId)]: state})
        } catch (e) {
            console.warn("can't persist detected media", e)
        }
    }

    async clear(tabId: number) {
        this.memory.delete(tabId)
        try {
            await this.session?.remove(this.key(tabId))
        } catch (e) {
            // ignored
        }
    }
}
