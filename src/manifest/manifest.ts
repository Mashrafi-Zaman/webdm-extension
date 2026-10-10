import ManifestV3 = chrome.runtime.ManifestV3;
import {getManifestForChrome} from "./manifest.chrome";

// one Chromium MV3 build (Chrome, Edge, Brave, Opera)
export function getManifest(): ManifestV3 {
    return getManifestForChrome()
}
