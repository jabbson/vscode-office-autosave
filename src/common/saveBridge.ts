import type { Handler } from '@/common/handler';

/**
 * Per-document bridge between the single-listener per-panel {@link Handler}
 * (wired in `commonHandler`) and the per-document `CustomEditorProvider`
 * callbacks (`onDidChangeCustomDocument` / `saveCustomDocument` / ...).
 *
 * A document is only registered here when it is *editable* (writable docx/dotx).
 * Non-editable routes (pdf/image/font/zip/parquet/html) never register, so all
 * bridge calls keyed by their uri are no-ops and they stay clean forever.
 *
 * Two host-driven round-trips flow through here, both keyed by `uri.toString()`:
 *  - save:  provider emits `requestSave` -> webview writes to disk via the
 *           existing `save` handler -> `completeSave` resolves the promise.
 *  - bytes: provider emits `requestBytes` -> webview returns the packed buffer
 *           via `provideBytes` (used for Save-As and hot-exit backup, which must
 *           NOT write to the real file).
 */

interface DocEntry {
    handler: Handler;
    onChange: () => void;
    pendingSave?: () => void;
    pendingBytes?: (bytes: Uint8Array | undefined) => void;
}

const docs = new Map<string, DocEntry>();

/** VS Code can hang a save/backup indefinitely if the webview never answers. */
const ROUND_TRIP_TIMEOUT_MS = 15000;

export function registerDoc(uriStr: string, entry: { handler: Handler; onChange: () => void }): void {
    docs.set(uriStr, { handler: entry.handler, onChange: entry.onChange });
}

export function unregisterDoc(uriStr: string): void {
    const entry = docs.get(uriStr);
    if (entry) {
        // Release any waiters so a save/backup in flight when the panel closes
        // resolves instead of hanging VS Code.
        entry.pendingSave?.();
        entry.pendingBytes?.(undefined);
    }
    docs.delete(uriStr);
}

export function isEditable(uriStr: string): boolean {
    return docs.has(uriStr);
}

export function getHandler(uriStr: string): Handler | undefined {
    return docs.get(uriStr)?.handler;
}

/** Called from `commonHandler`'s single `change` listener. */
export function notifyChange(uriStr: string): void {
    docs.get(uriStr)?.onChange();
}

/**
 * Start a host-initiated save. The caller emits `requestSave` to the webview;
 * the returned promise resolves once `commonHandler`'s `save` handler has
 * written the file and called {@link completeSave}.
 */
export function beginSave(uriStr: string): Promise<void> {
    const entry = docs.get(uriStr);
    if (!entry) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (entry.pendingSave) {
                entry.pendingSave = undefined;
                resolve();
            }
        }, ROUND_TRIP_TIMEOUT_MS);
        entry.pendingSave = () => {
            clearTimeout(timer);
            resolve();
        };
    });
}

export function completeSave(uriStr: string): void {
    const entry = docs.get(uriStr);
    const cb = entry?.pendingSave;
    if (entry && cb) {
        entry.pendingSave = undefined;
        cb();
    }
}

/**
 * Ask the webview to pack the current document and return the bytes WITHOUT
 * writing to the real file. Used by Save-As and backup.
 */
export function requestBytes(uriStr: string): Promise<Uint8Array | undefined> {
    const entry = docs.get(uriStr);
    if (!entry) {
        return Promise.resolve(undefined);
    }
    return new Promise<Uint8Array | undefined>((resolve) => {
        const timer = setTimeout(() => {
            if (entry.pendingBytes) {
                entry.pendingBytes = undefined;
                resolve(undefined);
            }
        }, ROUND_TRIP_TIMEOUT_MS);
        entry.pendingBytes = (bytes) => {
            clearTimeout(timer);
            resolve(bytes);
        };
        entry.handler.emit('requestBytes');
    });
}

export function provideBytes(uriStr: string, bytes: Uint8Array): void {
    const entry = docs.get(uriStr);
    const cb = entry?.pendingBytes;
    if (entry && cb) {
        entry.pendingBytes = undefined;
        cb(bytes);
    }
}
