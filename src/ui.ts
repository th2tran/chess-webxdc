/* Small DOM helpers: escaping, modal dialogs, toasts, sounds and formatting. */

export function esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
    ));
}

export function $(selector: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Missing element ${selector}`);
    return node;
}

export function formatClock(ms: number): string {
    if (!isFinite(ms)) return '∞';
    const clamped = Math.max(0, ms);
    const totalSec = Math.floor(clamped / 1000);
    const m = Math.floor(totalSec / 60), s = totalSec % 60;
    const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return clamped < 10000 ? `${base}.${Math.floor((clamped % 1000) / 100)}` : base;
}

export function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
    const sec = Math.max(0, Math.round((now - ts) / 1000));
    if (sec < 45) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

export interface ModalButton {
    label: string;
    kind?: 'primary' | 'danger' | 'secondary';
    /** Return false to keep the dialog open. */
    action?: (dialog: HTMLElement) => void | boolean;
}

export interface ModalOptions {
    id: string;
    title: string;
    body: string;
    buttons: ModalButton[];
    /** Clicking the backdrop / pressing Escape closes the dialog. */
    dismissible?: boolean;
    onClose?: () => void;
    /** Called once the dialog is in the DOM. */
    onOpen?: (dialog: HTMLElement) => void;
    /** Auto-close after this many ms. */
    timeoutMs?: number;
}

/** One dialog visible at a time; further dialogs wait in a queue. */
export class Modals {
    private queue: ModalOptions[] = [];
    private current: { opts: ModalOptions; node: HTMLElement; timer: number | null } | null = null;

    private root: HTMLElement;

    constructor(root: HTMLElement) {
        this.root = root;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.current?.opts.dismissible !== false) this.close(this.current?.opts.id || '');
        });
    }

    isOpen(id: string): boolean { return this.current?.opts.id === id || this.queue.some((q) => q.id === id); }

    show(opts: ModalOptions): void {
        this.queue = this.queue.filter((q) => q.id !== opts.id);
        if (this.current?.opts.id === opts.id) {
            this.closeCurrent(false);
            this.queue.unshift(opts);
        } else {
            this.queue.push(opts);
        }
        if (!this.current) this.next();
    }

    /** Replaces the body of an open dialog (e.g. countdowns). */
    update(id: string, body: string): void {
        if (this.current?.opts.id !== id) return;
        const b = this.current.node.querySelector<HTMLElement>('.modal-body');
        if (b) b.innerHTML = body;
    }

    close(id: string): void {
        this.queue = this.queue.filter((q) => q.id !== id);
        if (this.current?.opts.id === id) {
            this.closeCurrent(true);
            this.next();
        }
    }

    closeMatching(prefix: string): void {
        this.queue = this.queue.filter((q) => !q.id.startsWith(prefix));
        if (this.current?.opts.id.startsWith(prefix)) {
            this.closeCurrent(true);
            this.next();
        }
    }

    private closeCurrent(callOnClose: boolean): void {
        const cur = this.current;
        if (!cur) return;
        if (cur.timer) clearTimeout(cur.timer);
        cur.node.remove();
        this.current = null;
        if (callOnClose) cur.opts.onClose?.();
    }

    private next(): void {
        const opts = this.queue.shift();
        if (!opts) return;
        const node = document.createElement('div');
        node.className = 'modal-backdrop';
        node.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
            <h2 class="modal-title">${esc(opts.title)}</h2>
            <div class="modal-body">${opts.body}</div>
            <div class="modal-buttons"></div>
        </div>`;
        const dialog = node.querySelector<HTMLElement>('.modal')!;
        const buttons = node.querySelector<HTMLElement>('.modal-buttons')!;
        for (const b of opts.buttons) {
            const btn = document.createElement('button');
            btn.className = `btn ${b.kind || 'secondary'}`;
            btn.textContent = b.label;
            btn.addEventListener('click', () => {
                const keep = b.action ? b.action(dialog) === false : false;
                if (!keep) this.close(opts.id);
            });
            buttons.appendChild(btn);
        }
        node.addEventListener('pointerdown', (e) => {
            if (e.target === node && opts.dismissible !== false) this.close(opts.id);
        });
        this.root.appendChild(node);
        const timer = opts.timeoutMs ? window.setTimeout(() => this.close(opts.id), opts.timeoutMs) : null;
        this.current = { opts, node, timer };
        opts.onOpen?.(dialog);
        buttons.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
    }
}

export function toast(text: string, kind: 'info' | 'success' | 'warn' = 'info', ms = 4000): void {
    const root = document.getElementById('toasts');
    if (!root) return;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = text;
    root.appendChild(node);
    while (root.children.length > 4) root.firstElementChild?.remove();
    setTimeout(() => {
        node.classList.add('leaving');
        setTimeout(() => node.remove(), 300);
    }, ms);
}

export type SoundName = 'move' | 'capture' | 'notify' | 'end' | 'low';

export class Sounds {
    muted = false;
    private ctx: AudioContext | null = null;

    play(name: SoundName): void {
        if (this.muted) return;
        try {
            const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return;
            this.ctx = this.ctx || new Ctor();
            const ctx = this.ctx;
            if (ctx.state === 'suspended') void ctx.resume();
            const tones: Record<SoundName, [number, number, number][]> = {
                move: [[520, 0, 0.09]],
                capture: [[330, 0, 0.1], [220, 0.05, 0.12]],
                notify: [[660, 0, 0.09], [880, 0.11, 0.12]],
                end: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.2]],
                low: [[880, 0, 0.05]]
            };
            const loud = name === 'move' || name === 'capture';
            const peak = loud ? 0.9 : 0.25;
            for (const [freq, start, dur] of tones[name]) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = loud ? 'triangle' : 'sine';
                osc.frequency.value = freq;
                const t0 = ctx.currentTime + start;
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + dur + 0.02);
            }
        } catch {
            // Audio is optional.
        }
    }
}

export function loadJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : fallback;
    } catch {
        return fallback;
    }
}

export function saveJson(key: string, value: unknown): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage may be unavailable.
    }
}
