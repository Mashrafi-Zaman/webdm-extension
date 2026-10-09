// "segment": a piece of a stream (fMP4/TS/CMAF segment or init segment). Never listed on its own; used to
// link a stream to its manifest or to rebuild it.
export type InterceptedMediaType = "hls" | "http" | "dash" | "segment";
export type InterceptedMediaResult = {
    type: "media",
    mediaType: InterceptedMediaType,
    url: string,
    requestHeaders: Headers,
    responseHeaders: Headers,
    // frame that made (or is responsible for) the request; -1 = unknown
    frameId?: number,
    // URL of that frame, if known (used as Referer and to group media per frame)
    frameUrl?: string,
    // playlist text already seen by the page (e.g. blob: playlists that can't be fetched again)
    content?: string,
    // MP4/audio fetched by a script (XHR/fetch) rather than a <video>/<audio> element
    viaScript?: boolean,
    // segments: Range header of the request, and the MSE SourceBuffer mime type the bytes went to (if known)
    rangeHeader?: string | null,
    mime?: string,
}
