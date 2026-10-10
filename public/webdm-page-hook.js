// WebDM Integration - page hook (runs in the page's MAIN world, at document_start, in all frames).
//
// 1. Spots HLS playlists (and DASH manifests) that players fetch with fetch()/XMLHttpRequest from URLs that
//    don't end in .m3u8/.mpd, including blob: URLs, by looking at the first bytes of the response body.
// 2. Watches MediaSource/SourceBuffer: which mime types/codecs the player uses (separate audio and video?)
//    and which fetched URLs end up in which SourceBuffer (matched by byte length), so stream segments can be
//    grouped and their streams rebuilt.
// Findings go to WebDM's content script (isolated world) through DOM events; the content script forwards
// them to the extension. The page's own requests, responses and media data are not changed.
(function () {
    "use strict";
    var MARK = "__webdmPageHookInstalled";
    if (window[MARK]) {
        return;
    }
    try {
        Object.defineProperty(window, MARK, {value: true});
    } catch (e) {
        return;
    }

    var MAX_SIZE = 2 * 1024 * 1024;
    var EVENT_NAME = "webdm:page-media";
    var CONTENT_READY_EVENT = "webdm:content-ready"; // content script -> hook: "I'm listening" (+ settings)
    var HOOK_READY_EVENT = "webdm:hook-ready"; // hook -> content script: "announce yourself again"
    var MAX_REPLAY = 50;

    // This hook runs at document_start, the content script later (document_idle), so players that fetch
    // playlists early would be missed. Keep recent findings and replay them whenever a content script
    // announces itself (also after an extension reload, when a new content script starts).
    var recent = [];
    var recentSegments = [];
    var contentScriptListening = false;
    var debugMode = false;

    function dispatch(detail) {
        try {
            document.dispatchEvent(new CustomEvent(EVENT_NAME, {detail: detail}));
        } catch (e) {
            // ignore
        }
    }

    function absolute(url) {
        try {
            return new URL(String(url), location.href).href;
        } catch (e) {
            return null;
        }
    }

    // data: {url, kind: "hls" | "dash" | "segment" | "debug", ...}
    function report(data, replayable) {
        var detail;
        try {
            // a string: objects don't cross from the page's world to the content script's world
            detail = JSON.stringify(data);
        } catch (e) {
            return;
        }
        if (replayable) {
            // segments get their own (smaller) buffer so a busy player can't push playlists out
            var buffer = data.kind === "segment" ? recentSegments : recent;
            buffer.push(detail);
            if (buffer.length > (data.kind === "segment" ? 20 : MAX_REPLAY)) {
                buffer.shift();
            }
        }
        if (contentScriptListening) {
            dispatch(detail);
        }
    }

    function reportManifest(url, kind, content) {
        var abs = absolute(url);
        if (abs) {
            report({url: abs, kind: kind, content: content}, true);
        }
    }

    function reportDebug(url, requestType, contentType, size, classification) {
        if (!debugMode) {
            return;
        }
        var abs = absolute(url);
        if (abs) {
            report({
                kind: "debug", url: abs, requestType: requestType, contentType: contentType || null,
                size: typeof size === "number" ? size : null, classification: classification || null
            }, false);
        }
    }

    document.addEventListener(CONTENT_READY_EVENT, function (event) {
        contentScriptListening = true;
        try {
            debugMode = !!(event.detail && JSON.parse(event.detail).debug);
        } catch (e) {
            // ignore
        }
        var all = recent.concat(recentSegments);
        for (var i = 0; i < all.length; i++) {
            dispatch(all[i]);
        }
    });
    try {
        document.dispatchEvent(new CustomEvent(HOOK_READY_EVENT));
    } catch (e) {
        // ignore
    }

    // "hls" / "dash" / null, from the first characters of a body
    function sniff(head) {
        // \s also matches a leading byte-order mark (U+FEFF)
        var text = String(head).replace(/^\s+/, "");
        if (text.indexOf("#EXTM3U") === 0) {
            return "hls";
        }
        if (/^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<MPD[\s>]/.test(text) || text.indexOf("<MPD") === 0) {
            return "dash";
        }
        return null;
    }

    function isBinaryMedia(contentType) {
        var type = (contentType || "").toLowerCase();
        if (type.indexOf("mpegurl") >= 0 || type.indexOf("dash") >= 0) {
            return false;
        }
        return /^(video|audio)\//.test(type) || type.indexOf("octet-stream") >= 0 || type.indexOf("iso.segment") >= 0;
    }

    function looksBinary(contentType) {
        var type = (contentType || "").toLowerCase();
        if (type.indexOf("mpegurl") >= 0 || type.indexOf("dash") >= 0) {
            return false;
        }
        return /^(video|audio|image|font)\//.test(type);
    }

    // ---------- recent binary responses, to learn which URL each SourceBuffer.appendBuffer() came from ----------
    var binaryResponses = []; // {url, size, used}
    function rememberBinary(url, size) {
        if (!url || !size) {
            return;
        }
        binaryResponses.push({url: url, size: size, used: false});
        if (binaryResponses.length > 100) {
            binaryResponses.shift();
        }
    }

    // exact matches first: the appended buffer IS the body of a fetch Response / XHR we saw
    var bufferUrls = new WeakMap(); // ArrayBuffer -> url (from Response.arrayBuffer())
    var recentXhrs = []; // XMLHttpRequest objects (their .response is compared by identity)

    function urlForAppendedData(data) {
        var buffer = data && data.buffer instanceof ArrayBuffer ? data.buffer : data;
        if (buffer && bufferUrls.has(buffer)) {
            return bufferUrls.get(buffer);
        }
        for (var x = recentXhrs.length - 1; x >= 0; x--) {
            var xhr = recentXhrs[x] && recentXhrs[x].deref ? recentXhrs[x].deref() : recentXhrs[x];
            if (!xhr) {
                continue;
            }
            try {
                if (xhr.readyState === 4 && xhr.responseType === "arraybuffer" && xhr.response === buffer) {
                    return xhr.responseURL || null;
                }
            } catch (e) {
                // ignore
            }
        }
        // last resort: a recent binary response of the same size
        var size = data && typeof data.byteLength === "number" ? data.byteLength : 0;
        for (var i = binaryResponses.length - 1; i >= 0; i--) {
            var r = binaryResponses[i];
            if (!r.used && r.size === size) {
                r.used = true;
                return r.url;
            }
        }
        return null;
    }

    if (window.Response && Response.prototype.arrayBuffer) {
        var originalArrayBuffer = Response.prototype.arrayBuffer;
        Response.prototype.arrayBuffer = function () {
            var response = this;
            var promise = originalArrayBuffer.apply(this, arguments);
            try {
                promise.then(function (buffer) {
                    try {
                        if (response.url && buffer) {
                            bufferUrls.set(buffer, response.url);
                        }
                    } catch (e) {
                        // ignore
                    }
                }, function () {
                });
            } catch (e) {
                // ignore
            }
            return promise;
        };
    }

    // ---------- fetch ----------
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        var inspectResponse = function (response) {
            if (!response || response.type === "opaque") {
                return;
            }
            var contentType = response.headers.get("content-type");
            var length = Number(response.headers.get("content-length")) || null;
            if (isBinaryMedia(contentType)) {
                rememberBinary(response.url, length);
                reportDebug(response.url, "fetch", contentType, length, "binary");
                return;
            }
            if (!response.body || response.bodyUsed || (length && length > MAX_SIZE) || looksBinary(contentType)) {
                return;
            }
            var reader;
            try {
                // read a copy: the page's response is untouched
                reader = response.clone().body.getReader();
            } catch (e) {
                return;
            }
            var decoder = new TextDecoder();
            var text = "";
            var total = 0;
            var kind = null;
            var pump = function () {
                return reader.read().then(function (chunk) {
                    if (chunk.done) {
                        if (kind) {
                            reportManifest(response.url, kind, text + decoder.decode());
                            reportDebug(response.url, "fetch", contentType, total, kind);
                        }
                        return;
                    }
                    total += chunk.value.length;
                    if (total > MAX_SIZE) {
                        reader.cancel();
                        return;
                    }
                    text += decoder.decode(chunk.value, {stream: true});
                    if (kind === null) {
                        kind = sniff(text.slice(0, 512));
                        if (kind === null && text.length >= 64) {
                            reader.cancel(); // not a playlist: stop reading the copy
                            return;
                        }
                    }
                    return pump();
                });
            };
            pump().catch(function () {
            });
        };
        var wrappedFetch = function () {
            var promise = originalFetch.apply(this, arguments);
            try {
                promise.then(function (response) {
                    try {
                        inspectResponse(response);
                    } catch (e) {
                        // ignore
                    }
                }, function () {
                });
            } catch (e) {
                // ignore
            }
            return promise;
        };
        try {
            Object.defineProperty(wrappedFetch, "name", {value: "fetch"});
            wrappedFetch.toString = function () {
                return originalFetch.toString();
            };
        } catch (e) {
            // ignore
        }
        window.fetch = wrappedFetch;
    }

    // ---------- XMLHttpRequest ----------
    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto) {
        var originalOpen = proto.open;
        var originalSend = proto.send;
        var urls = new WeakMap();

        var inspectXhr = function (xhr) {
            var url = xhr.responseURL || urls.get(xhr);
            if (!url || xhr.status < 200 || xhr.status > 299) {
                return;
            }
            var type = xhr.responseType;
            var contentType = null;
            try {
                contentType = xhr.getResponseHeader("content-type");
            } catch (e) {
                // ignore
            }
            if (type === "" || type === "text") {
                var body = xhr.responseText;
                if (body && body.length <= MAX_SIZE) {
                    var kind = sniff(body.slice(0, 512));
                    if (kind) {
                        reportManifest(url, kind, body);
                        reportDebug(url, "xhr", contentType, body.length, kind);
                    }
                }
            } else if (type === "arraybuffer" && xhr.response) {
                var buffer = xhr.response;
                var bufferKind = null;
                if (buffer.byteLength <= MAX_SIZE && !isBinaryMedia(contentType)) {
                    var head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
                    bufferKind = sniff(head);
                }
                if (bufferKind) {
                    reportManifest(url, bufferKind, new TextDecoder().decode(new Uint8Array(buffer)));
                    reportDebug(url, "xhr", contentType, buffer.byteLength, bufferKind);
                } else {
                    rememberBinary(url, buffer.byteLength);
                    if (isBinaryMedia(contentType)) {
                        reportDebug(url, "xhr", contentType, buffer.byteLength, "binary");
                    }
                }
            } else if (type === "blob" && xhr.response) {
                var blob = xhr.response;
                if (isBinaryMedia(blob.type || contentType)) {
                    rememberBinary(url, blob.size);
                    reportDebug(url, "xhr", blob.type || contentType, blob.size, "binary");
                } else if (blob.size <= MAX_SIZE && !looksBinary(blob.type)) {
                    blob.text().then(function (blobText) {
                        var blobKind = sniff(blobText.slice(0, 512));
                        if (blobKind) {
                            reportManifest(url, blobKind, blobText);
                        }
                    }, function () {
                    });
                }
            }
        };

        proto.open = function (method, url) {
            try {
                urls.set(this, String(url));
            } catch (e) {
                // ignore
            }
            return originalOpen.apply(this, arguments);
        };
        proto.send = function () {
            try {
                var xhr = this;
                // weakly held: never keep the page's responses (segment bytes) alive
                recentXhrs.push(typeof WeakRef === "function" ? new WeakRef(xhr) : xhr);
                if (recentXhrs.length > (typeof WeakRef === "function" ? 50 : 8)) {
                    recentXhrs.shift();
                }
                // readystatechange (DONE) fires before "load": players usually append the bytes to a SourceBuffer
                // from their onload handler, so the response must be remembered before that
                xhr.addEventListener("readystatechange", function () {
                    if (xhr.readyState !== 4) {
                        return;
                    }
                    try {
                        inspectXhr(xhr);
                    } catch (e) {
                        // ignore
                    }
                });
            } catch (e) {
                // ignore
            }
            return originalSend.apply(this, arguments);
        };
    }

    // ---------- MediaSource / SourceBuffer ----------
    // each MediaSource gets a number, so the files one player plays (e.g. separate video and audio) are grouped
    var sourceBufferMime = new WeakMap();
    var sourceBufferMediaSource = new WeakMap();
    var mediaSourceIds = new WeakMap();
    var nextMediaSourceId = 1;

    function mediaSourceId(mediaSource) {
        var id = mediaSourceIds.get(mediaSource);
        if (!id) {
            id = nextMediaSourceId++;
            mediaSourceIds.set(mediaSource, id);
        }
        return id;
    }

    // picture height from an MP4 init segment ("tkhd" boxes end with width and height as 16.16 fixed point)
    function heightFromInit(data) {
        try {
            var bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            var limit = Math.min(bytes.length, 256 * 1024);
            var best = 0;
            for (var i = 4; i + 4 <= limit; i++) {
                // "tkhd"
                if (bytes[i] !== 0x74 || bytes[i + 1] !== 0x6b || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) {
                    continue;
                }
                var start = i - 4;
                var size = ((bytes[start] << 24) >>> 0) + (bytes[start + 1] << 16) + (bytes[start + 2] << 8) + bytes[start + 3];
                if (size < 84 || start + size > bytes.length) {
                    continue;
                }
                var h = start + size - 4;
                var height = ((bytes[h] << 8) | bytes[h + 1]);
                if (height > best && height <= 8640) {
                    best = height;
                }
            }
            return best || null;
        } catch (e) {
            return null;
        }
    }
    var MS = window.MediaSource || window.ManagedMediaSource;
    if (MS && MS.prototype && MS.prototype.addSourceBuffer) {
        var originalAddSourceBuffer = MS.prototype.addSourceBuffer;
        MS.prototype.addSourceBuffer = function (mime) {
            var sourceBuffer = originalAddSourceBuffer.apply(this, arguments);
            try {
                sourceBufferMime.set(sourceBuffer, String(mime));
                sourceBufferMediaSource.set(sourceBuffer, this);
                if (debugMode) {
                    report({kind: "debug", url: location.href, requestType: "mse", mime: String(mime), classification: "addSourceBuffer"}, false);
                }
            } catch (e) {
                // ignore
            }
            return sourceBuffer;
        };
    }
    var SB = window.SourceBuffer || window.ManagedSourceBuffer;
    if (SB && SB.prototype && SB.prototype.appendBuffer) {
        var originalAppendBuffer = SB.prototype.appendBuffer;
        SB.prototype.appendBuffer = function (data) {
            try {
                var url = urlForAppendedData(data);
                if (url) {
                    var mediaSource = sourceBufferMediaSource.get(this);
                    var duration = mediaSource && isFinite(mediaSource.duration) && mediaSource.duration > 0 ? mediaSource.duration : null;
                    var mimeType = sourceBufferMime.get(this) || null;
                    report({
                        kind: "segment", url: url, mime: mimeType,
                        ms: mediaSource ? mediaSourceId(mediaSource) : null,
                        height: mimeType && /^video\//i.test(mimeType) ? heightFromInit(data) : null,
                        duration: duration
                    }, true);
                }
            } catch (e) {
                // ignore
            }
            return originalAppendBuffer.apply(this, arguments);
        };
    }
})();
