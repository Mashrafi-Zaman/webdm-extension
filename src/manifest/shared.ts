import pkg from "../../package.json";
import ManifestPermissions = chrome.runtime.ManifestPermissions;

export function getBaseManifest() {
    const icon16="icons/icon-16.png"
    const icon32="icons/icon-32.png"
    const icon48="icons/icon-48.png"
    const icon96="icons/icon-96.png"
    const icon128="icons/icon-128.png"
    return {
        name: pkg.displayName,
        description: pkg.description,
        version: pkg.version,
        homepage_url:pkg.homepage,
        author: pkg.author,
        default_locale: "en",
        icons: {
            16: icon16,
            32: icon32,
            48: icon48,
            96: icon96,
            128: icon128,
        },
        content_scripts: [{
            matches: ["*://*/*"],
            js: ["src/entrypoint/ContentScript.ts"],
        }],
        options_ui: {
            page: "src/entrypoint/OptionUi/index.html",
            open_in_tab: true,
        },
        web_accessible_resources:[
        ]
    }
}


export function getBrowserActionInfo(){
    return  {
        default_title: "WebDM Integration",
        default_popup: "src/entrypoint/BrowserAction/index.html",
    }
}
export function getBackgroundScript(){
    return "src/entrypoint/Background.ts"
}
export function getHostPermissions(){
    return [
        "*://*/*",
    ]
}
export function getCommonPermissions():ManifestPermissions[]{
    return [
        "contextMenus",
        "webRequest",
        "cookies",
        "storage",
        "tabs",
        "downloads",
        "notifications",
        "nativeMessaging",
    ]
}
