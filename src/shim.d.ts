// shim.d.ts

import { ProtocolWithReturn } from "webext-bridge";
import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import {DownloadableMedia} from "~/media/MediaOnTab";
import type {Runtime} from "webextension-polyfill";
import type {ReportedMedia} from "~/linkgrabber/DownloadLinkInterceptor";
import type {PageDebugEvent} from "~/contentscripts/PageMediaReporter";
import type {ResourceProbeResult, SegmentProbeRequest, SegmentProbeResult} from "~/media/SegmentUtils";

declare module "webext-bridge" {
    export interface ProtocolMap {
        add_download: ProtocolWithReturn<DownloadRequestItem[],boolean>;
        downloadable_media_detected: DownloadableMedia[],
        show_alert: string;
        show_log:string[];
        check_selected_text_for_links:null;
        test_http_port: ProtocolWithReturn<number, boolean>;
        test_native_messaging: ProtocolWithReturn<undefined, boolean>;
        is_app_reachable: ProtocolWithReturn<undefined, boolean>;
        get_headers:ProtocolWithReturn<string[],(DownloadRequestHeaders | null)[]>;
        set_holding_key: string;
        get_platform: ProtocolWithReturn<undefined, Runtime.PlatformInfo>,
        // content script (any frame) -> background: this frame's URL and media it found itself
        // (page hook, Resource Timing, media elements); an empty list just announces the frame
        report_frame_media: ProtocolWithReturn<{
            frameUrl: string,
            items: ReportedMedia[],
            // duration (s) of the frame's main <video>, if known
            videoDuration?: number | null,
            // debug mode: what the page hook / resource scan saw, for the detection log
            debugEvents?: PageDebugEvent[],
        }, void>,
        // toolbar popup -> background: save the detection log of a tab (debug mode); true if a download started
        export_detection_log: ProtocolWithReturn<{ tabId: number }, boolean>,
        // can the app take /add items of this type (checked with GET /capabilities)?
        is_job_type_supported: ProtocolWithReturn<string, boolean>,
        // background -> content script: find the first/last segment number from the page (page Referer/origin)
        probe_segment_range: ProtocolWithReturn<SegmentProbeRequest, SegmentProbeResult>,
        // background -> content script: full size / Range support of a file, requested from the page
        probe_resource: ProtocolWithReturn<string, ResourceProbeResult | null>,
    }
}
