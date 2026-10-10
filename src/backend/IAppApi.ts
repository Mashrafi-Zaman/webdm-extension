import {AddDownloadRequest} from "~/interfaces/AddDownloadRequest";

export interface IAppApi {
    addDownload(request: AddDownloadRequest): Promise<boolean>

    ping(): Promise<boolean>

    /** what the app can download; null = the app is too old to say (no /capabilities) */
    getCapabilities(): Promise<AppCapabilities | null>
}

export interface AppCapabilities {
    app: string,
    version: string,
    jobTypes: string[],
    features: Record<string, boolean>,
}
