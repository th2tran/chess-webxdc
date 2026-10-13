/* Minimal type declarations for the webxdc API provided by the messenger (webxdc.js). */

export interface WebxdcUpdate<T> {
    payload: T;
    serial?: number;
    max_serial?: number;
    info?: string;
    summary?: string;
    document?: string;
    notify?: Record<string, string>;
}

export interface RealtimeChannel {
    setListener(listener: (data: Uint8Array) => void): void;
    send(data: Uint8Array): void;
    leave(): void;
}

export interface Webxdc<T> {
    selfAddr: string;
    selfName: string;
    sendUpdateInterval?: number;
    sendUpdateMaxSize?: number;
    sendUpdate(update: Omit<WebxdcUpdate<T>, 'serial' | 'max_serial'>, description: string): void | Promise<void>;
    setUpdateListener(listener: (update: WebxdcUpdate<T>) => void, serial?: number): Promise<void>;
    joinRealtimeChannel?(): RealtimeChannel;
}

declare global {
    interface Window { webxdc?: Webxdc<unknown>; APP_VERSION?: string; }
}
