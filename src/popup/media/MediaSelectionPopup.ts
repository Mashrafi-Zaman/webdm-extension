import {DownloadableMedia} from "~/media/MediaOnTab"
import browser from "webextension-polyfill"

let popupEl: HTMLDivElement | null = null
let dismissed = false
let listVisible = false // start collapsed
let onItemClick: ((item: DownloadableMedia) => void) | undefined
const chosenQualityUris = new Set<string>()

/**
 * Create the main popup element
 */
function createPopup() {
    if (popupEl) return popupEl
    // a popup left behind by an instance of this script from before an extension reload/update
    // (its extension context is dead, so it can't update or download anymore)
    document.querySelectorAll(".abdm-extension").forEach(el => el.remove())
    const downloadMediaTitle = browser.i18n.getMessage("download_media_title")
    const wrapper = document.createElement("div")
    wrapper.className = "abdm-extension"
    wrapper.style.position = "fixed"
    wrapper.style.top = "8px"
    wrapper.style.left = "8px"
    wrapper.style.zIndex = "999999"
    wrapper.style.display = "flex"
    wrapper.style.flexDirection = "column"
    wrapper.style.alignItems = "start"
    wrapper.style.gap = "2px"
    wrapper.style.direction = "ltr"

    // Create style element using textContent to avoid CSP violation
    const styleEl = document.createElement("style")
    styleEl.textContent = `
      .abdm-extension * {
        font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        box-sizing: border-box;
      }
      .abdm-media-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border-radius: 16px;
        padding: 6px 12px;
        background: linear-gradient(to bottom right, #2E3038, #171820);
        border: rgba(255,255,255,0.25) solid 1px;
        box-shadow: rgba(0,0,0,0.07) 0px 1px 2px, rgba(0,0,0,0.07) 0px 2px 4px, rgba(0,0,0,0.07) 0px 4px 8px;
        cursor: pointer;
        color: #aaaaaa;
        font-size: 12px;
      }
      .abdm-media-header .appIcon,
      .abdm-media-header .title-wrapper,
      .abdm-media-header .abdm-media-close-btn {
        display: flex;
        align-items: center;
      }
      .abdm-media-header .appIcon {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
      }
      .abdm-media-header .title-wrapper {
        gap: 4px;
        user-select: none; /* header text not selectable */
      }
      .abdm-media-header .abdm-media-close-btn {
        cursor: pointer;
        width: 12px;
        height: 12px;
        flex-shrink: 0;
        color: #aaa;
      }
      .abdm-media-header .abdm-media-close-btn:hover {
        color: #fff;
      }
      .abdm-media-list {
        background: linear-gradient(to bottom right, #2E3038, #171820);
        border: rgba(255,255,255,0.25) solid 1px;
        border-radius: 16px;
        overflow: auto;
        color: #ccc;
        font-size: 12px;
        box-shadow: rgba(0,0,0,0.15) 0px 4px 10px;
        margin-top: 4px;
        display: none; /* start hidden */
        max-height: 50vh; /* scroll if too long */
      }
      .abdm-media-item {
        padding: 8px 12px;
        border-bottom: rgba(255,255,255,0.1) solid 1px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: start;
        min-width: 160px;
      }
      .abdm-media-item:last-child {
        border-bottom: none;
      }
      .abdm-media-item:hover {
        background: rgba(255,255,255,0.08);
      }
      .abdm-item-title {
        font-weight: 500;
        color: #fff;
      }
      .abdm-item-details {
        font-size: 10px;
        opacity: 0.7;
      }
      .abdm-media-item-info-only {
        cursor: default;
        opacity: 0.6;
      }
      .abdm-quality-select {
        margin-top: 4px;
        font-size: 11px;
        color: #fff;
        background: #2E3038;
        border: rgba(255,255,255,0.25) solid 1px;
        border-radius: 6px;
        padding: 1px 4px;
        cursor: pointer;
      }
    `
    wrapper.appendChild(styleEl)

    // Create HTML content without inline style
    const contentHTML = `
    <div class="abdm-media-header">
      <div class="appIcon">
        <svg width="100%" height="100%" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
            <rect width="256" height="256" rx="48" fill="#172A46"/>
            <circle cx="128" cy="116" r="80" fill="none" stroke="#FFF3E6" stroke-width="28"/>
            <path d="M104 36H152V136H196L128 222L60 136H104Z" fill="none" stroke="#172A46" stroke-width="22" stroke-linejoin="round"/>
            <path d="M104 36H152V136H196L128 222L60 136H104Z" fill="#FF6A3D" stroke="#FF6A3D" stroke-width="4" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="title-wrapper">
        <span>${downloadMediaTitle}</span>
        (<span class="count-text">0</span>)
      </div>
      <div class="abdm-media-close-btn">
        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M5.29289 5.29289C5.68342 4.90237 6.31658 4.90237 6.70711 5.29289L12 10.5858L17.2929 5.29289C17.6834 4.90237 18.3166 4.90237 18.7071 5.29289C19.0976 5.68342 19.0976 6.31658 18.7071 6.70711L13.4142 12L18.7071 17.2929C19.0976 17.6834 19.0976 18.3166 18.7071 18.7071C18.3166 19.0976 17.6834 19.0976 17.2929 18.7071L12 13.4142L6.70711 18.7071C6.31658 19.0976 5.68342 19.0976 5.29289 18.7071C4.90237 18.3166 4.90237 17.6834 5.29289 17.2929L10.5858 12L5.29289 6.70711C4.90237 6.31658 4.90237 5.68342 5.29289 5.29289Z" fill="currentColor"/>
        </svg>
      </div>
    </div>
    <div class="abdm-media-list"></div>
    `
    
    const contentContainer = document.createElement("div")
    contentContainer.innerHTML = contentHTML
    while (contentContainer.firstChild) {
        wrapper.appendChild(contentContainer.firstChild)
    }

    const header = wrapper.querySelector<HTMLDivElement>(".abdm-media-header")!
    const listContainer = wrapper.querySelector<HTMLDivElement>(".abdm-media-list")!

    header.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("abdm-media-close-btn")) return
        listVisible = !listVisible
        listContainer.style.display = listVisible ? "block" : "none"
    })

    wrapper.querySelector<HTMLSpanElement>(".abdm-media-close-btn")!.onclick = () => {
        dismissed = true
        wrapper.remove()
        popupEl = null
    }

    document.body.appendChild(wrapper)
    popupEl = wrapper
    return wrapper
}

function getBiggestMediaPlayer() {
    return Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"))
        .filter(el => el instanceof HTMLVideoElement || el instanceof HTMLAudioElement)
        .sort((a, b) => {
            const areaA = a.clientWidth * a.clientHeight
            const areaB = b.clientWidth * b.clientHeight
            return areaB - areaA
        })[0] || null
}

function detailsText(item: {
    duration?: string, size?: string, resolution?: string, bandwidth?: string, extension?: string, note?: string,
}) {
    return [
        item.duration,
        item.size,
        item.resolution,
        item.bandwidth,
        item.extension,
        item.note,
    ].filter(Boolean).join(" · ")
}

/**
 * One row per video. HLS masters get a quality dropdown; clicking the row downloads the selected quality.
 */
function createMediaItemElement(item: DownloadableMedia) {
    const el = document.createElement("div")
    el.className = "abdm-media-item"

    const titleEl = document.createElement("div")
    titleEl.className = "abdm-item-title"
    const detailsEl = document.createElement("div")
    detailsEl.className = "abdm-item-details"
    el.append(titleEl, detailsEl)

    const qualities = item.qualities ?? []
    let selected: DownloadableMedia = item
    const select = (index: number) => {
        const q = qualities[index]
        selected = q ? {
            ...item,
            uri: q.uri,
            requestHeaders: q.requestHeaders,
            displayName: q.displayName,
            suggestedFullName: q.suggestedFullName,
            duration: q.duration,
            bandwidth: q.bandwidth,
            resolution: q.resolution,
            extension: q.extension,
            note: q.note,
        } : item
        // textContent: the page title comes from the page and must not be parsed as HTML
        titleEl.textContent = selected.displayName ?? "Unnamed media"
        detailsEl.textContent = detailsText(selected)
    }

    // the list is rebuilt whenever more media is detected; keep the user's quality choice
    const initialIndex = Math.max(0, qualities.findIndex(q => chosenQualityUris.has(q.uri)))
    if (qualities.length > 1) {
        const dropdown = document.createElement("select")
        dropdown.className = "abdm-quality-select"
        qualities.forEach((q, index) => {
            const option = document.createElement("option")
            option.value = String(index)
            option.textContent = q.label
            dropdown.appendChild(option)
        })
        dropdown.value = String(initialIndex)
        // choosing a quality must not trigger the row's download click
        dropdown.addEventListener("click", e => e.stopPropagation())
        dropdown.addEventListener("mousedown", e => e.stopPropagation())
        dropdown.addEventListener("change", () => {
            const index = Number(dropdown.value)
            qualities.forEach(q => chosenQualityUris.delete(q.uri))
            chosenQualityUris.add(qualities[index].uri)
            select(index)
        })
        el.appendChild(dropdown)
    }
    select(initialIndex)

    if (item.downloadable === false) {
        el.classList.add("abdm-media-item-info-only")
    }
    el.onclick = () => {
        onItemClick?.(selected)
    }
    return el
}

/**
 * Set the click listener for media items
 */
export function setItemClickListener(callback: (item: DownloadableMedia) => void) {
    onItemClick = callback
}

/**
 * Update the popup with a list of media items
 */
export function updatePopup(items: DownloadableMedia[]) {
    if (dismissed) return

    if (!items || items.length === 0) {
        popupEl?.remove()
        popupEl = null
        return
    }

    const popup = createPopup()

    const countEl = popup.querySelector<HTMLSpanElement>(".count-text")!
    countEl.textContent = String(items.length)

    const listContainer = popup.querySelector<HTMLDivElement>(".abdm-media-list")!
    listContainer.innerHTML = ""

    for (const item of items) {
        listContainer.appendChild(createMediaItemElement(item))
    }

    // Position near video/audio or fallback top-left
    const media = getBiggestMediaPlayer()
    if (media) {
        const rect = media.getBoundingClientRect()
        popup.style.position = "absolute" // near media
        popup.style.top = `${Math.max(rect.top - popup.offsetHeight - 2 + window.scrollY, 2)}px`
        popup.style.left = `${rect.left + window.scrollX}px`
    } else {
        popup.style.position = "fixed"
        popup.style.top = "8px"
        popup.style.left = "8px"
    }
}

/**
 * Toggle the visibility of the list manually
 */
export function toggleList(
    visible?: boolean,
) {
    if (!popupEl) return
    const listContainer = popupEl.querySelector<HTMLDivElement>(".abdm-media-list");
    if (!listContainer) return
    switch (visible) {
        case undefined:
            listVisible = !listVisible
            break
        default:
            listVisible = visible
    }
    listContainer.style.display = listVisible ? "block" : "none"
}
