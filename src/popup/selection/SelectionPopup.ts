import { PositionInPage } from "~/utils/MouseUtil";
import browser from "webextension-polyfill";

const AB_DM_POPUP_CLASSNAME = "ab_dm_popup_class";
let showingPopup = false;

let onClickListener = () => {};

export function setOnPopupClicked(listener: () => void) {
    onClickListener = listener;
}
export function showAddDownloadPopupUi(position: PositionInPage) {
    if (showingPopup) {
        closeAddDownloadPopupUi();
    }
    const el = createUi(
        position,
        () => {
            try {
                onClickListener();
            } finally {
                closeAddDownloadPopupUi();
            }
        },
        closeAddDownloadPopupUi
    );
    showingPopup = true;
}

export function closeAddDownloadPopupUi() {
    document.removeEventListener("mousedown", closeAddDownloadPopupUi);
    document.body.querySelectorAll(`.${AB_DM_POPUP_CLASSNAME}`).forEach((el) => {
        el.remove();
    });
    showingPopup = false;
}

function createUi(position: PositionInPage, onAction: () => void, onCancel: () => void) {
    const el = document.createElement("div");

    // Create shadow root
    const shadowRoot = el.attachShadow({ mode: "open" });
    const downloadSelectedText = browser.i18n.getMessage("selection_popup_download_selected");
    
    // Create style element using textContent to avoid CSP violation
    const styleEl = document.createElement("style");
    styleEl.textContent = `
    .abdm {
        font-size: 12px;
        color: #aaaaaa;
        background: linear-gradient(to bottom right, #2E3038, #171820);
        display: flex;
        align-items: stretch;
        flex-direction: row;
        cursor: pointer;
        border-radius: 999px;
        border: rgba(255,255,255,25%) solid 1px;
        overflow: hidden;
        user-select: none;
        box-shadow: rgba(0, 0, 0, 0.07) 0px 1px 2px, rgba(0, 0, 0, 0.07) 0px 2px 4px, rgba(0, 0, 0, 0.07) 0px 4px 8px, rgba(0, 0, 0, 0.07) 0px 8px 16px, rgba(0, 0, 0, 0.07) 0px 16px 32px, rgba(0, 0, 0, 0.07) 0px 32px 64px;
    }
    .abdm * {
        transition: background-color ease 300ms;
    }
    .abdm .download-btn .appIcon {
        width: 12px;
        height: 12px;
    }
    .abdm .download-btn > * {
        padding-left: 4px;
        padding-right: 4px;
    }
    .abdm .download-btn {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        padding-left: 4px;
        padding-right: 8px;
        padding-top: 4px;
        padding-bottom: 4px;
    }
    .abdm .download-btn:hover {
        background: rgba(255, 255, 255, 25%);
    }
    .abdm .close-btn {
        background: rgba(255, 255, 255, 5%);
        padding-top: 4px;
        padding-bottom: 4px;
        padding-left: 4px;
        padding-right: 8px;
        display: flex;
        align-items: center;
        height: auto;
    }
    .abdm .close-btn:hover {
        background: rgba(255, 255, 255, 25%);
    }
    `;
    shadowRoot.appendChild(styleEl);

    // Create HTML content without inline style
    const popupString = `
<div dir="ltr" class="abdm">
    <div class="download-btn">
        <div class="appIcon">
            <svg width="100%" height="100%" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
                <rect width="256" height="256" rx="48" fill="#172A46"/>
                <circle cx="128" cy="116" r="80" fill="none" stroke="#FFF3E6" stroke-width="28"/>
                <path d="M104 36H152V136H196L128 222L60 136H104Z" fill="none" stroke="#172A46" stroke-width="22" stroke-linejoin="round"/>
                <path d="M104 36H152V136H196L128 222L60 136H104Z" fill="#FF6A3D" stroke="#FF6A3D" stroke-width="4" stroke-linejoin="round"/>
            </svg>
        </div>
        <span>${downloadSelectedText}</span>
    </div>
    <div class="close-btn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M5.29289 5.29289C5.68342 4.90237 6.31658 4.90237 6.70711 5.29289L12 10.5858L17.2929 5.29289C17.6834 4.90237 18.3166 4.90237 18.7071 5.29289C19.0976 5.68342 19.0976 6.31658 18.7071 6.70711L13.4142 12L18.7071 17.2929C19.0976 17.6834 19.0976 18.3166 18.7071 18.7071C18.3166 19.0976 17.6834 19.0976 17.2929 18.7071L12 13.4142L6.70711 18.7071C6.31658 19.0976 5.68342 19.0976 5.29289 18.7071C4.90237 18.3166 4.90237 17.6834 5.29289 17.2929L10.5858 12L5.29289 6.70711C4.90237 6.31658 4.90237 5.68342 5.29289 5.29289Z" fill="currentColor"/>
        </svg>
    </div>
</div>
    `;

    // Append the popup content to the shadow root
    const container = document.createElement("div");
    container.innerHTML = popupString;
    shadowRoot.appendChild(container.firstElementChild!);

    el.classList.add(AB_DM_POPUP_CLASSNAME);

    el.style.position = "absolute";
    document.body.append(el);

    const elWidth = el.getBoundingClientRect().width;
    const offsetX =
        position.x + elWidth >= window.innerWidth ? window.innerWidth - (elWidth + getScrollbarWidth()) : position.x;
    const offsetY = position.y;

    shadowRoot.querySelector(".download-btn")?.addEventListener("mousedown", (event) => {
        event.stopPropagation();
        onAction();
    });

    shadowRoot.querySelector(".close-btn")?.addEventListener("mousedown", (event) => {
        event.stopPropagation();
        onCancel();
    });

    el.style.zIndex = "9999";
    el.style.top = offsetY + "px";
    el.style.left = offsetX + "px";

    return el;
}

function getScrollbarWidth() {
    return window.innerWidth - document.body.clientWidth;
}
