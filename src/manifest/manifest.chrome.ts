import {
    getBackgroundScript,
    getBaseManifest,
    getBrowserActionInfo,
    getCommonPermissions,
    getHostPermissions
} from "./shared";
import ManifestV3 = chrome.runtime.ManifestV3;
// import ManifestV2 = chrome.runtime.ManifestV2;

// Public key that pins the unpacked extension ID to aciclgnjjaijdpnkkgileppmbpldobjj
// (trusted by the WebDM app for native messaging). The private key is NOT in this repo.
const chromeExtensionPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApp5+ge+c4DW6T0sPtDENLZXcQRy/qG8O8vxDFT/dPwg8iFMriORxh8d1g14ZsWl4/dK6fvnI2tABD6j7c4tU9r8bRqyfqTcGv6cvkw4oihXV2KLhyqkFsMdg+o9WO8+ZWdmi8JBmChyYFjeYZKJGjExzrYEAMlIcgjMgaJWFMTz7HYSpAoOqAo31A68WJr31UNhaaiWZ+RItjkkiqRBdWzPwYyUDvNpJdEPPYISo35xIRroOfMzWxKfDklPpH4l5xP4q0YLOj6w2FnsKM2y8ERtXqyqoh2Q+DWmdP3LuHWM4Uivkse2aw7xWosVB1+/cQQ5CpcISLknh05eH3GS+bQIDAQAB"

export function getManifestForChrome(): ManifestV3 {
    const base = getBaseManifest()
    return {
        // as far as I know manifest version 3 does not allow request blocking
        manifest_version: 3,
        key: chromeExtensionPublicKey,
        ...base,
        // also run in iframes whose URL has no origin of its own (about:blank, blob:, data:), using the
        // creator's origin for matching (Chrome only)
        content_scripts: base.content_scripts.map(cs => ({...cs, match_origin_as_fallback: true})),
        background: {
            service_worker: getBackgroundScript(),
        },
        action: getBrowserActionInfo(),
        host_permissions: getHostPermissions(),
        // "scripting": inject the content script into tabs that were open before install/update, and register
        // the MAIN-world page hook (webdm-page-hook.js)
        permissions: [...getCommonPermissions(), "scripting"],
    }
    /*return {
        manifest_version: 2,
        ...getBaseManifest(),
        background: {
            scripts: [getBackgroundScript()],
        },
        browser_action: getBrowserActionInfo(),
        permissions: [
            ...getHostPermissions(),
            ...getCommonPermissions(),
        ],
    }*/
}