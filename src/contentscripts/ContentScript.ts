import {getLinksFromSelection} from "~/utils/LinkExtractor";
import * as selectionPopup from "~/popup/selection/SelectionPopup";
import * as MediaPopup from "~/popup/media/MediaSelectionPopup";
import {debounce} from "~/utils/Debaunce";
import * as mousePosition from "~/utils/MouseUtil"
import * as HoldingKeyTracker from "~/utils/HoldingKeyTracker"
import * as Configs from "~/configs/Config"
import {run} from "~/utils/ScopeFunctions";
import {onMessage, sendMessage} from "webext-bridge/content-script"
import browser from "webextension-polyfill";
import {createAlertStringForMyExtension} from "~/utils/AlertMessageCreator";
import {addDownloads} from "~/contentscripts/AddDownloads";
import {DefinedCommands} from "~/message/Commands";
import {defineExtensionEntry} from "~/utils/DefineExtensionEntry";
import ContentScriptEntryType from "~/utils/EntryPointTypes/ContentScript/ContentScriptEntryType";
import {startPageMediaReporter} from "~/contentscripts/PageMediaReporter";
import type {SegmentsTrackJob} from "~/media/MediaOnTab";
import {probeResourceWithFetch, probeSegmentsWithFetch, segmentUrl} from "~/media/SegmentUtils";
import _ from "lodash";

const showPopupDelayed = debounce(500)

async function checkAndReportLinks() {
    const selection = window.getSelection();
    if (selection == null) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_nothing_selected")))
        return
    }
    let downloadItems = getLinksFromSelection(selection)
    if (downloadItems.length == 0) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_no_link_detected")))
        return
    }
    await addDownloads(downloadItems)
}

let lastSelectionConsumed = true

function shouldCreatePopup() {
    return lastSelectionConsumed && Configs.getLatestConfig().popupEnabled
}

export default defineExtensionEntry()
    .withType(ContentScriptEntryType)
    .withInit(async () => {
        try {
            mousePosition.boot()
            HoldingKeyTracker.boot()
            selectionPopup.setOnPopupClicked(async () => {
                checkAndReportLinks()
            })
            MediaPopup.setItemClickListener((media) => {
                const addDownloadType = media.type
                if (media.downloadable === false || addDownloadType === "dash") {
                    // e.g. DASH: listed so the user knows it's there, but the app can't download it yet
                    alert(createAlertStringForMyExtension(
                        `${media.displayName ?? "This video"}: ${media.note ?? "not supported yet"}`
                    ))
                    return
                }
                if (addDownloadType === "segments" && media.segmentsJob) {
                    // a stream rebuilt from its numbered segments: send the app one job with every segment URL,
                    // but only to an app that supports it (never fall back to sending a single segment)
                    const job = media.segmentsJob
                    run(async () => {
                        let supported = false
                        try {
                            supported = await sendMessage(DefinedCommands.IS_JOB_TYPE_SUPPORTED, "segments", "background")
                        } catch (e) {
                            supported = false
                        }
                        if (!supported) {
                            MediaPopup.showNotice(browser.i18n.getMessage("update_app_for_stream"))
                            return
                        }
                        const expand = (track: SegmentsTrackJob) => _.range(track.first, track.last + 1)
                            .map(n => segmentUrl(track.template, n, track.pad))
                        await addDownloads([
                            {
                                link: media.uri,
                                suggestedName: `${job.title}.${job.extension}`,
                                type: "segments",
                                downloadPage: location.href,
                                headers: job.headers,
                                description: null,
                                init: job.video.init ?? null,
                                segments: expand(job.video),
                                audioInit: job.audio?.init ?? null,
                                audioSegments: job.audio ? expand(job.audio) : undefined,
                                duration: job.duration ?? null,
                                estimatedSize: job.estimatedSize ?? null,
                                quality: job.quality,
                            }
                        ])
                        MediaPopup.toggleList(false)
                    })
                    return
                }
                if ((addDownloadType === "av" && media.avJob) || addDownloadType === "page") {
                    // separate video + audio files merged by the app, or a page for the app's site downloader:
                    // only for an app that supports the job type
                    const job = media.avJob
                    run(async () => {
                        let supported = false
                        try {
                            supported = await sendMessage(DefinedCommands.IS_JOB_TYPE_SUPPORTED, addDownloadType, "background")
                        } catch (e) {
                            supported = false
                        }
                        if (!supported) {
                            MediaPopup.showNotice(browser.i18n.getMessage("update_app_for_stream"))
                            return
                        }
                        await addDownloads([job ? {
                            link: job.video,
                            suggestedName: `${job.title}.mp4`,
                            type: "av",
                            downloadPage: location.href,
                            headers: job.headers,
                            description: null,
                            video: job.video,
                            audio: job.audio,
                            videoSize: job.videoSize ?? null,
                            audioSize: job.audioSize ?? null,
                            duration: job.duration ?? null,
                            quality: job.quality,
                        } : {
                            link: media.uri,
                            suggestedName: null,
                            type: "page",
                            downloadPage: location.href,
                            headers: null,
                            description: null,
                        }])
                        MediaPopup.toggleList(false)
                    })
                    return
                }
                if (addDownloadType !== "hls" && addDownloadType !== "http") {
                    return
                }
                addDownloads([
                    {
                        link: media.uri,
                        suggestedName: media.suggestedFullName ?? "",
                        type: addDownloadType,
                        downloadPage: location.href,
                        headers: media.requestHeaders ?? null,
                        description: null
                    }
                ])
                MediaPopup.toggleList(false)
            })

            document.addEventListener("selectionchange", () => {
                lastSelectionConsumed = true
                const selection = window.getSelection();
                if (!selection || selection.type !== "Range") {
                    selectionPopup.closeAddDownloadPopupUi();
                }
            })

            document.addEventListener("mousedown", () => {
                showPopupDelayed.cancel()
            })

            document.addEventListener("mouseup", (mouseEvent) => {
                showPopupDelayed(() => {
                    const mousePositionInPage = mousePosition.getMousePositionInPage();
                    if (!shouldCreatePopup() || mousePositionInPage === null) {
                        return;
                    }
                    const selection = window.getSelection();
                    if (selection == null) {
                        return;
                    }
                    if (selection.type !== "Range") {
                        return;
                    }
                    const linksFromSelection = getLinksFromSelection(selection);
                    if (linksFromSelection.length == 0) {
                        return
                    }
                    lastSelectionConsumed = false
                    selectionPopup.showAddDownloadPopupUi(mousePositionInPage)
                })
                run(async () => {
                    try {
                        await sendMessage(
                            DefinedCommands.SET_HOLDING_KEY,
                            HoldingKeyTracker.getHoldingShortcut(mouseEvent),
                            "background"
                        )
                    } catch (e) {
                        // ignored
                    } finally {
                        HoldingKeyTracker.clear()
                    }
                })
            })

            onMessage(DefinedCommands.SHOW_LOG, (msg) => {
                console.log(...msg.data)
            })
            onMessage(DefinedCommands.SHOW_ALERT, (msg) => {
                alert(createAlertStringForMyExtension(msg.data))
            })
            onMessage(DefinedCommands.CHECK_SELECTED_TEXT_FOR_LINKS, (msg) => {
                checkAndReportLinks()
            })
            onMessage(DefinedCommands.DOWNLOADABLE_MEDIA_DETECTED, (msg) => {
                MediaPopup.updatePopup(msg.data)
            })
            onMessage(DefinedCommands.PROBE_SEGMENT_RANGE, async (msg) => {
                // from the page: these requests carry the page's Referer / origin like the player's own
                return await probeSegmentsWithFetch(msg.data, {referrer: location.href})
            })
            onMessage(DefinedCommands.PROBE_RESOURCE, async (msg) => {
                return await probeResourceWithFetch(msg.data, {}, {referrer: location.href})
            })
            startPageMediaReporter()
        } catch (e) {
            console.log("failed to load WebDM Integration content script", e)
            throw e
        }
    })



