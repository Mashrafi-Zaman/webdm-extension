/**
 * Requests the background makes itself (fetching a playlist, a HEAD request, size probes) can't set Referer /
 * Origin: those are forbidden headers for fetch(). Many servers only answer requests "from" the page, so while
 * such a request runs, a declarativeNetRequest session rule sets the page's Referer, Origin and User-Agent on this
 * extension's own requests (tabId -1) to that host. Nothing else is changed; the rule is removed right after.
 */

const FIRST_RULE_ID = 90_000
let nextRuleId = FIRST_RULE_ID
let cleaned = false

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined
    const key = Object.keys(headers).find(k => k.toLowerCase() === name)
    return key ? headers[key] : undefined
}

async function removeLeftoverRules() {
    // rules of an earlier service-worker instance that stopped before removing them
    if (cleaned) return
    cleaned = true
    try {
        const rules = await chrome.declarativeNetRequest.getSessionRules()
        const ids = rules.map(r => r.id).filter(id => id >= FIRST_RULE_ID)
        if (ids.length) {
            await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: ids})
        }
        nextRuleId = Math.max(FIRST_RULE_ID, ...rules.map(r => r.id + 1))
    } catch (e) {
        // ignore
    }
}

export async function withPageHeaders<T>(url: string, headers: Record<string, string> | undefined, run: () => Promise<T>): Promise<T> {
    const referer = headerValue(headers, "referer")
    const userAgent = headerValue(headers, "user-agent")
    let host: string
    try {
        host = new URL(url).hostname
    } catch (e) {
        return run()
    }
    if ((!referer && !userAgent) || typeof chrome === "undefined" || !chrome.declarativeNetRequest) {
        return run()
    }
    await removeLeftoverRules()
    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = []
    const set = (header: string, value: string) => requestHeaders.push({
        header, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value,
    })
    if (referer) {
        set("referer", referer)
        try {
            set("origin", new URL(referer).origin)
        } catch (e) {
            // a referer that isn't a URL: no origin
        }
    }
    if (userAgent) set("user-agent", userAgent)
    const id = nextRuleId++
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [{
                id,
                priority: 1,
                action: {type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders},
                condition: {
                    requestDomains: [host],
                    tabIds: [chrome.tabs.TAB_ID_NONE],
                    resourceTypes: [
                        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                        chrome.declarativeNetRequest.ResourceType.OTHER,
                    ],
                },
            }],
        })
    } catch (e) {
        return run()
    }
    try {
        return await run()
    } finally {
        chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [id]}).catch(() => undefined)
    }
}
