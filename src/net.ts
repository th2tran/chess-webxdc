/* Transport over webxdc: fast ephemeral realtime channel plus persistent (replayable) status updates. */
import type { Color, GameResult } from './engine.ts';
import type { TournamentState } from './tournament.ts';
import type { RealtimeChannel, Webxdc, WebxdcUpdate } from './webxdc.d.ts';

export const APP_ID = 'chess-xdc/1';

export type PeerStatus = 'idle' | 'computer' | 'playing' | 'tournament';
export interface PlayerRef { addr: string; name: string; }
export interface Clock { w: number; b: number; }

export type Payload =
    | { type: 'hello' }
    | { type: 'coach-probe'; requestId: string }
    | { type: 'coach-available'; requestId: string; to: string }
    | { type: 'puzzle-request'; requestId: string; gameId: string }
    | { type: 'puzzle-response'; requestId: string; gameId: string; to: string; pgn?: string; error?: string }
    | { type: 'hint-request'; requestId: string; gameId: string; fen: string; startFen: string; moves: string[] }
    | { type: 'hint-response'; requestId: string; gameId: string; fen: string; to: string; uci?: string; error?: string }
    | { type: 'presence'; status: PeerStatus; gameId: string | null; tourId: string | null; opp: string | null }
    | { type: 'bye'; gameId?: string | null }
    | { type: 'chat'; text: string }
    | { type: 'challenge'; cid: string; to: string; color: Color | 'random' }
    | { type: 'challenge-cancel'; cid: string }
    | { type: 'challenge-decline'; cid: string; reason: string }
    | { type: 'gstart'; gameId: string; cid: string | null; tourId: string | null; white: PlayerRef; black: PlayerRef; tc: number }
    | { type: 'move'; gameId: string; ply: number; uci: string; clock: Clock }
    | { type: 'gend'; gameId: string; result: GameResult; reason: string }
    | { type: 'draw-offer'; gameId: string }
    | { type: 'draw-decline'; gameId: string }
    | { type: 'gsync-req'; gameId: string; have: number }
    | { type: 'gsync'; gameId: string; moves: { uci: string; clock: Clock }[]; result: GameResult | null; reason: string | null }
    | { type: 'tstate'; tour: TournamentState }
    | { type: 'tjoin'; tourId: string }
    | { type: 'tleave'; tourId: string };

export interface Envelope { app: string; id: string; from: string; name: string; ts: number; }
export type Message = Envelope & Payload;
export type MessageOf<K extends Payload['type']> = Envelope & Extract<Payload, { type: K }>;

export interface ReceiveContext {
    /** True while historical updates are being replayed at startup. */
    replay: boolean;
    /** True for messages this peer sent itself (handled locally right after sending). */
    local: boolean;
    source: 'realtime' | 'update' | 'local';
}

export interface SendOptions {
    /** Also store via sendUpdate (reliable, replayed on restart). */
    persist?: boolean;
    /** Chat info message shown to everybody (persisted messages only). */
    info?: string;
    /** Notification texts per recipient address (persisted messages only). */
    notify?: Record<string, string>;
    summary?: string;
}

export type Handler = (msg: Message, ctx: ReceiveContext) => void;

export function randomId(prefix = ''): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isMessage(value: unknown): value is Message {
    if (!value || typeof value !== 'object') return false;
    const m = value as Partial<Message>;
    return m.app === APP_ID && typeof m.id === 'string' && typeof m.type === 'string'
        && typeof m.from === 'string' && typeof m.name === 'string' && Number.isFinite(m.ts);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Net {
    readonly me: PlayerRef;
    readonly available: boolean;
    replaying = true;
    private wx: Webxdc<Message> | null;
    private realtime: RealtimeChannel | null = null;
    private seen = new Set<string>();
    private seenOrder: string[] = [];
    private handler: Handler = () => undefined;

    constructor() {
        this.wx = (window.webxdc as Webxdc<Message> | undefined) || null;
        this.available = !!this.wx;
        this.me = {
            addr: this.wx?.selfAddr || 'me@local',
            name: this.wx?.selfName || 'You'
        };
    }

    get hasRealtime(): boolean { return !!this.realtime; }

    /** Starts listening; resolves once the persisted history has been replayed. */
    async start(handler: Handler): Promise<void> {
        this.handler = handler;
        const wx = this.wx;
        if (!wx) { this.replaying = false; return; }
        const replayDone = wx.setUpdateListener((update: WebxdcUpdate<Message>) => {
            this.receive(update.payload, 'update');
            if (update.serial !== undefined && update.serial === update.max_serial) this.replaying = false;
        }, 0);
        // Some hosts never resolve the promise when there is no history; don't wait forever.
        await Promise.race([replayDone, new Promise((r) => setTimeout(r, 4000))]);
        this.replaying = false;
        if (typeof wx.joinRealtimeChannel === 'function') {
            try {
                const channel = wx.joinRealtimeChannel();
                channel.setListener((data) => {
                    try { this.receive(JSON.parse(decoder.decode(data)), 'realtime'); } catch { /* malformed packet */ }
                });
                this.realtime = channel;
            } catch (err) {
                console.warn('chess: realtime channel unavailable', err);
            }
        }
    }

    private remember(id: string): boolean {
        if (this.seen.has(id)) return false;
        this.seen.add(id);
        this.seenOrder.push(id);
        if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
        return true;
    }

    private receive(raw: unknown, source: 'realtime' | 'update'): void {
        if (!isMessage(raw) || !this.remember(raw.id)) return;
        try {
            this.handler(raw, { replay: this.replaying, local: false, source });
        } catch (err) {
            console.error('chess: failed to handle message', raw, err);
        }
    }

    /** Sends a message to all peers and also delivers it to the local handler. */
    send(payload: Payload, opts: SendOptions = {}): Message {
        const msg = { app: APP_ID, id: randomId(), from: this.me.addr, name: this.me.name, ts: Date.now(), ...payload } as Message;
        this.remember(msg.id);
        const wx = this.wx;
        if (wx) {
            if (this.realtime) {
                try { this.realtime.send(encoder.encode(JSON.stringify(msg))); } catch (err) { console.warn('chess: realtime send failed', err); }
            }
            if (opts.persist || !this.realtime) {
                const update: Omit<WebxdcUpdate<Message>, 'serial' | 'max_serial'> = { payload: msg };
                if (opts.info) update.info = opts.info;
                if (opts.summary) update.summary = opts.summary;
                if (opts.notify && Object.keys(opts.notify).length) update.notify = opts.notify;
                try {
                    const res = wx.sendUpdate(update, '');
                    if (res && typeof res.catch === 'function') res.catch((err) => console.warn('chess: sendUpdate failed', err));
                } catch (err) {
                    console.warn('chess: sendUpdate failed', err);
                }
            }
        }
        try {
            this.handler(msg, { replay: false, local: true, source: 'local' });
        } catch (err) {
            console.error('chess: failed to handle local message', msg, err);
        }
        return msg;
    }

    leave(): void {
        try { this.realtime?.leave(); } catch { /* ignore */ }
        this.realtime = null;
    }
}
