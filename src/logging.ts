import { loadJson, saveJson } from './ui.ts';

const LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;
const FILTERS = ['error', 'warn', 'info', 'debug'] as const;
type LogFilter = typeof FILTERS[number];
interface LogEntry { filter: LogFilter; text: string; }
const MAX_ENTRIES = 300;
const MAX_ENTRY_LENGTH = 2000;
type Dock = 'float' | 'left' | 'right' | 'bottom';
interface PanelState {
    dock: Dock;
    position?: { left: number; top: number };
    sizes: Partial<Record<Dock, { width: number; height: number }>>;
}

const PANEL_STORAGE_KEY = 'chess-xdc:logging-panel';

function readPanelState(value: unknown): PanelState | null {
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<PanelState>;
    if (state.dock !== 'float' && state.dock !== 'left' && state.dock !== 'right' && state.dock !== 'bottom') return null;
    const numberPair = (pair: unknown): pair is { width: number; height: number } =>
        !!pair && typeof pair === 'object'
        && Number.isFinite((pair as { width?: unknown }).width)
        && Number.isFinite((pair as { height?: unknown }).height);
    const sizes: PanelState['sizes'] = {};
    if (state.sizes && typeof state.sizes === 'object') {
        for (const dock of ['float', 'left', 'right', 'bottom'] as const) {
            const size = state.sizes[dock];
            if (numberPair(size)) sizes[dock] = { width: size.width, height: size.height };
        }
    }
    const position = state.position;
    return {
        dock: state.dock,
        ...(position && Number.isFinite(position.left) && Number.isFinite(position.top)
            ? { position: { left: position.left, top: position.top } } : {}),
        sizes
    };
}

function formatValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    const seen = new WeakSet<object>();
    try {
        return JSON.stringify(value, (_key, item: unknown) => {
            if (item instanceof Error) return item.stack || `${item.name}: ${item.message}`;
            if (typeof item === 'bigint') return `${item}n`;
            if (typeof item === 'object' && item !== null) {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            return item;
        }) ?? String(value);
    } catch {
        return '[Unserializable log value]';
    }
}

export function installLogging(brand: HTMLElement): void {
    const entries: LogEntry[] = [];
    const enabled = new Set<LogFilter>(FILTERS);
    const savedState = readPanelState(loadJson<unknown>(PANEL_STORAGE_KEY, null));
    let panel: HTMLElement | null = null;
    let output: HTMLElement | null = null;
    let taps = 0;
    let dock: Dock = savedState?.dock ?? 'float';
    let position = savedState?.position;
    let drag: { id: number; x: number; y: number } | null = null;
    let resizing: { id: number; x: number; y: number; width: number; height: number } | null = null;
    const sizes: PanelState['sizes'] = savedState?.sizes ?? {};

    function saveWindowState(): void {
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        sizes[dock] = { width: bounds.width, height: bounds.height };
        if (dock === 'float') position = { left: bounds.left, top: bounds.top };
        saveJson(PANEL_STORAGE_KEY, { dock, position, sizes } satisfies PanelState);
    }

    function resize(width: number, height: number): void {
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        const maxWidth = dock === 'float' ? window.innerWidth - bounds.left - 8 : window.innerWidth - 16;
        const maxHeight = dock === 'float' ? window.innerHeight - bounds.top - 8 : window.innerHeight - 16;
        width = Math.min(maxWidth, Math.max(280, width));
        height = Math.min(maxHeight, Math.max(220, height));
        sizes[dock] = { width, height };
        panel.style.width = dock === 'bottom' ? '' : `${width}px`;
        panel.style.height = dock === 'left' || dock === 'right' ? '' : `${height}px`;
    }

    function move(left: number, top: number): void {
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
    }

    function setDock(value: typeof dock): void {
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        if (value !== dock) sizes[dock] = { width: bounds.width, height: bounds.height };
        dock = value;
        panel.dataset.dock = value;
        panel.style.left = '';
        panel.style.top = '';
        const size = sizes[value];
        panel.style.width = size && value !== 'bottom' ? `${size.width}px` : '';
        panel.style.height = size && value !== 'left' && value !== 'right' ? `${size.height}px` : '';
        if (value === 'float') move(bounds.left, bounds.top);
        if (size) resize(size.width, size.height);
        for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-dock-to]')) {
            button.setAttribute('aria-pressed', String(button.dataset.dockTo === value));
        }
    }

    function close(): void {
        if (!panel) return;
        saveWindowState();
        panel.hidden = true;
        output = null;
        brand.focus();
    }

    function open(): void {
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'logging-panel';
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-labelledby', 'logging-title');
            panel.innerHTML = `<header class="logging-header">
                <h2 id="logging-title" title="Drag to move; drop at a side or bottom edge to dock">Logging</h2>
                <button class="btn small" data-action="close" aria-label="Close Logging">Close</button>
            </header>
            <div class="logging-toolbar" aria-label="Logging controls">
                <button class="btn small" data-dock-to="left" aria-pressed="false">Dock left</button>
                <button class="btn small" data-dock-to="float" aria-pressed="true">Float</button>
                <button class="btn small" data-dock-to="right" aria-pressed="false">Dock right</button>
                <button class="btn small" data-dock-to="bottom" aria-pressed="false">Dock bottom</button>
                <button class="btn small" data-action="clear">Clear</button>
            </div>
            <fieldset class="logging-filters" aria-label="Filter logs by severity">
                <legend>Show</legend>
                ${FILTERS.map(filter => `<label><input type="checkbox" data-log-filter="${filter}" checked> ${filter[0].toUpperCase()}${filter.slice(1)}</label>`).join('')}
            </fieldset>
            <p class="small dim">Latest 300 session entries. Logs stay on this device and reset on reload.</p>
            <pre class="logging-output" tabindex="0" aria-label="Session logs"></pre>
            <button class="logging-resize" aria-label="Resize Logging" title="Drag to resize, or focus and use arrow keys"></button>`;
            document.body.appendChild(panel);
            panel.querySelector('[data-action="close"]')!.addEventListener('click', close);
            panel.querySelector('[data-action="clear"]')!.addEventListener('click', () => {
                entries.length = 0;
                render();
            });
            for (const checkbox of panel.querySelectorAll<HTMLInputElement>('[data-log-filter]')) {
                checkbox.addEventListener('change', () => {
                    const filter = checkbox.dataset.logFilter;
                    if (!FILTERS.includes(filter as LogFilter)) return;
                    if (checkbox.checked) enabled.add(filter as LogFilter);
                    else enabled.delete(filter as LogFilter);
                    render();
                });
            }
            for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-dock-to]')) {
                button.addEventListener('click', () => {
                    if (button.dataset.dockTo === 'left' || button.dataset.dockTo === 'right'
                        || button.dataset.dockTo === 'bottom' || button.dataset.dockTo === 'float') {
                        setDock(button.dataset.dockTo);
                        saveWindowState();
                    }
                });
            }
            panel.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    close();
                }
            });
            const handle = panel.querySelector<HTMLElement>('#logging-title')!;
            handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                const bounds = panel!.getBoundingClientRect();
                setDock('float');
                const floating = panel!.getBoundingClientRect();
                drag = {
                    id: event.pointerId,
                    x: Math.min(event.clientX - bounds.left, floating.width - 16),
                    y: event.clientY - bounds.top
                };
                move(event.clientX - drag.x, event.clientY - drag.y);
                handle.setPointerCapture(event.pointerId);
            });
            handle.addEventListener('pointermove', (event) => {
                if (drag?.id === event.pointerId) move(event.clientX - drag.x, event.clientY - drag.y);
            });
            handle.addEventListener('pointerup', (event) => {
                if (drag?.id !== event.pointerId) return;
                move(event.clientX - drag.x, event.clientY - drag.y);
                drag = null;
                handle.releasePointerCapture(event.pointerId);
                if (event.clientY >= window.innerHeight - 24) setDock('bottom');
                else if (event.clientX <= 24) setDock('left');
                else if (event.clientX >= window.innerWidth - 24) setDock('right');
                saveWindowState();
            });
            for (const type of ['pointercancel', 'lostpointercapture']) {
                handle.addEventListener(type, () => { drag = null; });
            }
            const grip = panel.querySelector<HTMLElement>('.logging-resize')!;
            grip.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                const bounds = panel!.getBoundingClientRect();
                resizing = { id: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
                grip.setPointerCapture(event.pointerId);
            });
            function resizeFromPointer(event: PointerEvent): void {
                if (resizing?.id !== event.pointerId) return;
                resize(
                    resizing.width + (event.clientX - resizing.x) * (dock === 'right' ? -1 : 1),
                    resizing.height + (event.clientY - resizing.y) * (dock === 'bottom' ? -1 : 1)
                );
            }
            grip.addEventListener('pointermove', resizeFromPointer);
            grip.addEventListener('pointerup', (event) => {
                if (resizing?.id !== event.pointerId) return;
                resizeFromPointer(event);
                resizing = null;
                grip.releasePointerCapture(event.pointerId);
                saveWindowState();
            });
            for (const type of ['pointercancel', 'lostpointercapture']) {
                grip.addEventListener(type, () => { resizing = null; });
            }
            grip.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const bounds = panel!.getBoundingClientRect();
                const dx = event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0;
                const dy = event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0;
                resize(bounds.width + dx * (dock === 'right' ? -1 : 1),
                    bounds.height + dy * (dock === 'bottom' ? -1 : 1));
                saveWindowState();
            });
        }
        panel.hidden = false;
        setDock(dock);
        if (dock === 'float' && position) move(position.left, position.top);
        output = panel.querySelector<HTMLElement>('.logging-output');
        render();
        if (output) output.scrollTop = output.scrollHeight;
        panel.querySelector<HTMLButtonElement>('[data-action="close"]')!.focus();
    }

    window.addEventListener('resize', () => {
        if (!panel || panel.hidden || dock !== 'float') return;
        const bounds = panel.getBoundingClientRect();
        move(bounds.left, bounds.top);
        saveWindowState();
    });
    window.addEventListener('pagehide', saveWindowState);

    function render(): void {
        if (!output) return;
        const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
        const visible = entries.filter(entry => enabled.has(entry.filter));
        output.textContent = visible.length ? visible.map(entry => entry.text).join('\n')
            : entries.length ? 'No matching logs.' : 'No logs captured.';
        if (atBottom) output.scrollTop = output.scrollHeight;
    }

    function record(level: string, args: unknown[]): void {
        const message = args.map(formatValue).join(' ');
        const text = message.length > MAX_ENTRY_LENGTH
            ? `${message.slice(0, MAX_ENTRY_LENGTH)} [truncated]` : message;
        const filter: LogFilter = level === 'debug' || level === 'warn' || level === 'error'
            ? level : 'info';
        entries.push({ filter, text: `${new Date().toISOString()} ${level.toUpperCase()} ${text}` });
        if (entries.length > MAX_ENTRIES) entries.shift();
        render();
    }

    for (const level of LEVELS) {
        const original = console[level];
        console[level] = (...args: unknown[]): void => {
            original.apply(console, args);
            record(level, args);
        };
    }
    window.addEventListener('error', (event) => {
        record('error', [event.error ?? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`]);
    });
    window.addEventListener('unhandledrejection', (event) => {
        record('error', ['Unhandled promise rejection:', event.reason]);
    });

    brand.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!event.repeat) brand.click();
        }
    });
    brand.addEventListener('click', () => {
        if (++taps < 7) return;
        taps = 0;
        open();
    });
}
