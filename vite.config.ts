import {defineConfig, PluginOption} from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";
import path from "path";
import { getManifest } from "./src/manifest/manifest";
import {getExtensionBrowserTarget, isFirefox} from "./src/utils/ExtensionInfo";
import EnvironmentPlugin from "vite-plugin-environment";
// https://vitejs.dev/config/
export default defineConfig(() => {
  return {
    build:{
      outDir:`dist/${getExtensionBrowserTarget()}`
    },
    // Emit ASCII-only JS (non-ASCII chars become \u escapes). Content-script chunks are
    // loaded via dynamic import and can be decoded with the wrong charset, which turned
    // "·" into "Â·" in the media popup.
    esbuild: {
      charset: "ascii",
    },
    resolve: {
      alias: {
        "~": path.resolve(__dirname, "./src"),
      },
    },
    plugins: [
      react(),
      EnvironmentPlugin(['EXTENSION_TARGET']),
      webExtension({
        manifest: getManifest(),
      }) as PluginOption,
    ],
  };
});
