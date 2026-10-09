// WebDM Integration - page hook (runs in the page's MAIN world, at document_start, in all frames).
//
// Spots HLS playlists (and DASH manifests) that players fetch with fetch()/XMLHttpRequest from URLs that
// don't end in .m3u8/.mpd, including blob: URLs, by looking at the first bytes of the response body.
// Found playlists are handed to WebDM's content script (isolated world) through a DOM event; the
// content script forwards them to the extension. The page's own requests and responses are not changed.
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
    var CONTENT_READY_EVENT = "webdm:content-ready"; // content script -> hook: "I'm listening"
    var HOOK_READY_EVENT = "webdm:hook-ready"; // hook -> content script: "announce yourself again"
    var MAX_REPLAY = 50;

    // This hook runs at document_start, the content script later (document_idle), so players that fetch
    // playlists early would be missed. Keep recent findings and replay them whenever a content script
    // announces itself (also after an extension reload, when a new content script starts).
    var recent = [];
    var contentScriptListening = false;

    function dispatch(detail) {
        try {
            document.dispatchEvent(new CustomEvent(EVENT_NAME, {detail: detail}));
        } catch (e) {
            // ignore
        }
    }

    function report(url, kind, content) {
        var detail;
        try {
            var absolute = new URL(String(url), location.href).href;
            // a string: objects don't cross from the page's world to the content script's world
            detail = JSON.stringify({url: absolute, kind: kind, content: content});
        } catch (e) {
            return;
        }
        recent.push(detail);
        if (recent.length > MAX_REPLAY) {
            recent.shift();
        }
        if (contentScriptListening) {
            dispatch(detail);
        }
    }

    document.addEventListener(CONTENT_READY_EVENT, function () {
        contentScriptListening = true;
        for (var i = 0; i < recent.length; i++) {
            dispatch(recent[i]);
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

    function looksBinary(contentType) {
        var type = (contentType || "").toLowerCase();
        if (type.indexOf("mpegurl") >= 0 || type.indexOf("dash") >= 0) {
            return false;
        }
        return /^(video|audio|image|font)\//.test(type);
    }

    // ---------- fetch ----------
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        var inspectResponse = function (response) {
            if (!response || !response.body || response.type === "opaque" || response.bodyUsed) {
                return;
            }
            var length = Number(response.headers.get("content-length"));
            if (length && length > MAX_SIZE) {
                return;
            }
            if (looksBinary(response.headers.get("content-type"))) {
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
                            report(response.url, kind, text + decoder.decode());
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
            if (type === "" || type === "text") {
                var body = xhr.responseText;
                if (body && body.length <= MAX_SIZE) {
                    var kind = sniff(body.slice(0, 512));
                    if (kind) {
                        report(url, kind, body);
                    }
                }
            } else if (type === "arraybuffer" && xhr.response && xhr.response.byteLength <= MAX_SIZE) {
                var buffer = xhr.response;
                var head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
                var bufferKind = sniff(head);
                if (bufferKind) {
                    report(url, bufferKind, new TextDecoder().decode(new Uint8Array(buffer)));
                }
            } else if (type === "blob" && xhr.response && xhr.response.size <= MAX_SIZE && !looksBinary(xhr.response.type)) {
                xhr.response.text().then(function (blobText) {
                    var blobKind = sniff(blobText.slice(0, 512));
                    if (blobKind) {
                        report(url, blobKind, blobText);
                    }
                }, function () {
                });
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
                xhr.addEventListener("load", function () {
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
})();
