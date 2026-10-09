/**
 * MV3 service workers only deliver events to listeners registered synchronously at startup, so all
 * background listeners are registered before any `await`. Handlers that need configs (or other async
 * boot state) await [whenBackgroundReady] first.
 */
let markReady: () => void = () => {}
const ready = new Promise<void>((resolve) => {
    markReady = resolve
})

export function whenBackgroundReady(): Promise<void> {
    return ready
}

export function setBackgroundReady() {
    markReady()
}
