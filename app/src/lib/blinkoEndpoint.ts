import { fileUrl, type FileUrlOptions } from './fileUrl';

export function getBlinkoFileUrl(path: string, options: FileUrlOptions = {}): string {
    return fileUrl(path, getBlinkoEndpoint('/'), options);
}

export function getBlinkoEndpoint(path: string = ''): string {
    try {
        const blinkoEndpoint = window.localStorage.getItem('blinkoEndpoint')
        const isTauri = !!(window as any).__TAURI__;
        if (isTauri && blinkoEndpoint) {
            try {
                const url = new URL(path, blinkoEndpoint.replace(/"/g, ''));
                return url.toString();
            } catch (error) {
                console.error(error);
                return new URL(path, window.location.origin).toString();
            }
        }

        return new URL(path, window.location.origin).toString();
    } catch (error) {
        console.error(error);
        return new URL(path, window.location.origin).toString();
    }
}

export function isTauriAndEndpointUndefined(): boolean {
    const isTauri = !!(window as any).__TAURI__;
    const blinkoEndpoint = window.localStorage.getItem('blinkoEndpoint')
    return isTauri && !blinkoEndpoint;
}

const ENDPOINT_CHANGED_EVENT = 'blinko:endpoint-changed';

/** Observe the same canonical setting used by API and file requests. */
export function subscribeBlinkoEndpointChange(listener: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    let previous = getSavedEndpoint();
    const onChange = () => {
        const current = getSavedEndpoint();
        if (current !== previous) { previous = current; listener(); }
    };
    const onStorage = (event: StorageEvent) => {
        // Peer-window token and endpoint events may arrive after both writes
        // have already completed. Rebind URLs before a token observer can use
        // the replacement login, even when its storage event arrives first.
        if (event.key === 'blinkoEndpoint' || event.key === 'blinkoToken' || event.key === null) onChange();
    };
    window.addEventListener(ENDPOINT_CHANGED_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(ENDPOINT_CHANGED_EVENT, onChange);
        window.removeEventListener('storage', onStorage);
    };
}

function configuredService(endpoint: string | null): string | null {
    try {
        const url = new URL((endpoint ?? '').replace(/"/g, '').trim());
        return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
}

export function saveBlinkoEndpoint(endpoint: string): void {
    if (typeof endpoint === 'string') {
        const previous = window.localStorage.getItem('blinkoEndpoint');
        // A persisted login belongs to its old server. Clear it before publishing
        // the new address, including to other windows and a later page reload.
        if ((window as any).__TAURI__ && configuredService(previous) !== configuredService(endpoint)) {
            window.localStorage.removeItem('blinkoToken');
        }
        window.localStorage.setItem('blinkoEndpoint', endpoint);
        if (previous !== endpoint) window.dispatchEvent(new Event(ENDPOINT_CHANGED_EVENT));
    }
}

export function getSavedEndpoint(): string {
    return window.localStorage.getItem('blinkoEndpoint') || '';
}
