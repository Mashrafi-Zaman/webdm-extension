import {InterceptedMediaResult} from "~/linkgrabber/LinkGrabberResponse";

export interface OnMediaInterceptedFromRequestListener {
    onMediaDetected(
        tabId: number,
        mediaResult: InterceptedMediaResult,
        // origin that started the request; used when tabId is -1 (e.g. a page's service worker)
        initiator?: string,
    ): void
}
