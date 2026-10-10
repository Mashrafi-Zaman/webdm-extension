import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import * as backend from "~/backend/Backend";
import {AppApiError, NetworkError} from "~/backend/BackendError";
import * as DialogUtils from "~/utils/DialogUtil";
import browser from "webextension-polyfill";
import {defaultDownloadRequestOptions, DownloadRequestOptions} from "~/interfaces/DownloadRequestOptions";
import {getLatestConfig} from "~/configs/Config";
import {run} from "~/utils/ScopeFunctions";

/**
 * Video pages that need a login: attach that site's cookies to {type:"page"} jobs, only when the user allowed it in
 * the app (capability "page.cookies", Settings > Tools > "Use browser cookies"). The app uses them only to read the
 * page and never saves them; they are never logged here.
 */
async function withPageCookies(data: DownloadRequestItem[]): Promise<DownloadRequestItem[]> {
    if (!data.some(item => item.type === "page")) return data
    const capabilities = await backend.getAppCapabilities()
    if (!capabilities?.features?.["page.cookies"] || !browser.cookies) return data
    return Promise.all(data.map(async item => {
        if (item.type !== "page") return item
        try {
            const cookies = await browser.cookies.getAll({url: item.link})
            return {
                ...item,
                cookies: cookies.map(c => ({
                    name: c.name, value: c.value, domain: c.domain, path: c.path,
                    secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate ?? null,
                })),
            }
        } catch (e) {
            return item
        }
    }))
}

export async function addDownload(
    data: DownloadRequestItem[],
) {
    // never send a job type the app doesn't understand (e.g. a rebuilt stream to an older WebDM): it would
    // fail, or worse, end up as a plain download of the first URL (just the init segment)
    for (const type of new Set(data.map(item => item.type))) {
        if (!await backend.isJobTypeSupported(type)) {
            return false
        }
    }
    data = await withPageCookies(data)
    const config = getLatestConfig()
    const options: DownloadRequestOptions = {...defaultDownloadRequestOptions}
    if (config.silentAddDownload) {
        options.silentAdd = true
        options.silentStart = config.silentStartDownload
    }
    const response = !!await usingBackend(async () => {
        return await backend.addDownload(data, options)
    });
    if (response && config.silentAddDownload && data.length == 1) {
        run(() => {
            try {
                browser.notifications?.create({
                    type: "basic",
                    iconUrl: browser.runtime.getURL("icons/icon-128.png"),
                    title: browser.i18n.getMessage("abdm_notification_title"),
                    message: browser.i18n.getMessage("abdm_notification_download_captured_silently")
                })
            } catch (e) {
                console.log("can't send notifications")
            }
        })
    }
    return response
}

export async function getHeadersForUrls(urls: string[]) {
    return Promise.all(urls.map(async url => {
        return await getHeadersForUrl(url)
    }));
}

export async function getHeadersForUrl(
    url: string,
): Promise<DownloadRequestHeaders | null> {
    try {
        let headers: DownloadRequestHeaders = {}
        const cookie = (await browser.cookies.getAll({
            url: url,
        })).map((cookie) => {
            return `${cookie.name}=${cookie.value}`
        }).join("; ")
        headers["Cookie"] = cookie
        headers["Host"] = new URL(url).host
        headers["User-Agent"] = navigator.userAgent
        return headers
    } catch (e) {
        console.log(e)
        return null
    }
}

async function usingBackend<T>(block: () => T) {
    try {
        return await block()
    } catch (e) {
        if (e instanceof AppApiError) {
            const friendlyNote = browser.i18n.getMessage("connection_error_api_error")
            const loggableReason = e.toLoggableString()
            await DialogUtils.showAlertInCurrentTab(
                `${friendlyNote}\n${loggableReason}`
            )
        } else if (e instanceof NetworkError) {
            await DialogUtils.showAlertInCurrentTab(
                browser.i18n.getMessage("connection_error_network_error")
            )
        }
        console.log("Error when using backend api", e)
    }
}

