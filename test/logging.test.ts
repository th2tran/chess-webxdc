import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installLogging } from '../src/logging.ts';

class ElementStub extends EventTarget {
    hidden = false;
    textContent = '';
    innerHTML = '';
    className = '';
    style = { left: '', top: '', width: '', height: '' };
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    focused = false;
    captured: number | null = null;
    nodes = new Map<string, ElementStub>();
    buttons: ElementStub[] = [];
    checkboxes: ElementStub[] = [];
    checked = true;

    click(): void { this.dispatchEvent(new Event('click')); }
    focus(): void { this.focused = true; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    querySelector(selector: string): ElementStub | null { return this.nodes.get(selector) ?? null; }
    querySelectorAll(selector: string): ElementStub[] {
        return selector === '[data-log-filter]' ? this.checkboxes : this.buttons;
    }
    setPointerCapture(id: number): void { this.captured = id; }
    releasePointerCapture(): void { this.captured = null; }
    getBoundingClientRect() {
        const dock = this.dataset.dock;
        return {
            left: this.style.left ? parseFloat(this.style.left) : dock === 'right' ? 612 : 8,
            top: this.style.top ? parseFloat(this.style.top) : dock === 'bottom' ? 472 : dock === 'left' || dock === 'right' ? 8 : 60,
            width: this.style.width ? parseFloat(this.style.width) : dock === 'bottom' ? 984 : dock === 'left' || dock === 'right' ? 380 : 560,
            height: this.style.height ? parseFloat(this.style.height) : dock === 'bottom' ? 320 : dock === 'left' || dock === 'right' ? 784 : 480
        };
    }
}

function setup(t: TestContext, storage = new Map<string, string>()) {
    const levels = ['debug', 'log', 'info', 'warn', 'error'] as const;
    const forwarded = Object.fromEntries(levels.map(level => [level, t.mock.fn()]));
    const previousConsole = globalThis.console;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const events = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => { storage.set(key, value); },
            removeItem: (key: string) => { storage.delete(key); }
        }
    });
    globalThis.console = { ...console, ...forwarded };
    t.after(() => {
        globalThis.console = previousConsole;
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
        else Reflect.deleteProperty(globalThis, 'localStorage');
    });
    const brand = new ElementStub();
    const output = new ElementStub();
    const panel = new ElementStub();
    const handle = new ElementStub();
    const clear = new ElementStub();
    const close = new ElementStub();
    const grip = new ElementStub();
    const checkboxes = ['error', 'warn', 'info', 'debug'].map(logFilter => {
        const checkbox = new ElementStub();
        checkbox.dataset.logFilter = logFilter;
        return checkbox;
    });
    panel.nodes.set('.logging-resize', grip);
    panel.nodes.set('.logging-output', output);
    panel.nodes.set('#logging-title', handle);
    panel.nodes.set('[data-action="clear"]', clear);
    panel.nodes.set('[data-action="close"]', close);
    panel.buttons = ['left', 'float', 'right', 'bottom'].map(dockTo => {
        const button = new ElementStub();
        button.dataset.dockTo = dockTo;
        return button;
    });
    panel.checkboxes = checkboxes;
    const shown: ElementStub[] = [];
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => panel, body: { appendChild: (node: ElementStub) => shown.push(node) } }
    });
    installLogging(brand as unknown as HTMLElement);
    return {
        brand, output, events, shown, forwarded, panel, handle, clear, grip, checkboxes, storage,
        tap: (count: number) => { for (let i = 0; i < count; i++) brand.click(); },
        close: () => close.click(),
        dock: (value: string) => panel.buttons.find(button => button.dataset.dockTo === value)!.click()
    };
}

test('Logging stays hidden until exactly seven clicks and requires seven to reopen', t => {
    const ui = setup(t);
    assert.equal(ui.shown.length, 0);
    ui.tap(6);
    assert.equal(ui.shown.length, 0);
    ui.tap(1);
    assert.equal(ui.shown.length, 1);
    assert.equal(ui.panel.attributes.get('aria-labelledby'), 'logging-title');
    assert.equal(ui.panel.attributes.get('role'), 'region');
    assert.equal(ui.panel.attributes.has('aria-modal'), false);
    assert.match(ui.output.textContent!, /No logs captured/);
    assert.equal(ui.panel.className, 'logging-panel');
    ui.tap(7);
    assert.equal(ui.shown.length, 1, 'does not queue duplicate dialogs');
    ui.close();
    assert.equal(ui.panel.hidden, true);
    ui.tap(6);
    assert.equal(ui.shown.length, 1);
    ui.tap(1);
    assert.equal(ui.shown.length, 1, 'reuses the existing panel');
    assert.equal(ui.panel.hidden, false);
});

test('panel dock, floating position and per-dock size survive closing and app reloads', t => {
    const baseConsole = globalThis.console;
    const storage = new Map<string, string>();
    let ui = setup(t, storage);
    ui.tap(7);
    pointer(ui.handle, 'pointerdown', 108, 70);
    pointer(ui.handle, 'pointerup', 250, 220);
    pointer(ui.grip, 'pointerdown', 568, 540);
    pointer(ui.grip, 'pointerup', 668, 590);
    ui.close();

    const floatingState = JSON.parse(storage.get('chess-xdc:logging-panel')!);
    assert.equal(floatingState.dock, 'float');
    assert.deepEqual(floatingState.position, { left: 150, top: 210 });
    assert.deepEqual(floatingState.sizes.float, { width: 660, height: 530 });

    globalThis.console = baseConsole;
    ui = setup(t, storage);
    ui.tap(7);
    assert.equal(ui.panel.dataset.dock, 'float');
    assert.equal(ui.panel.style.left, '150px');
    assert.equal(ui.panel.style.top, '210px');
    assert.equal(ui.panel.style.width, '660px');
    assert.equal(ui.panel.style.height, '530px');

    ui.dock('bottom');
    pointer(ui.grip, 'pointerdown', 10, 472);
    pointer(ui.grip, 'pointerup', 10, 372);
    ui.events.dispatchEvent(new Event('pagehide'));
    assert.equal(JSON.parse(storage.get('chess-xdc:logging-panel')!).dock, 'bottom');
    globalThis.console = baseConsole;
    ui = setup(t, storage);
    ui.tap(7);
    assert.equal(ui.panel.dataset.dock, 'bottom');
    assert.equal(ui.panel.style.height, '420px');
    ui.close();
    assert.equal(JSON.parse(storage.get('chess-xdc:logging-panel')!).dock, 'bottom');
});

test('Enter and Space activate the easter egg without counting held keys', t => {
    const ui = setup(t);
    for (const key of ['Enter', ' ', 'Enter', ' ', 'Enter', ' ']) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key, repeat: false });
        ui.brand.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
    }
    ui.brand.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', repeat: true }));
    ui.brand.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', repeat: false }));
    assert.equal(ui.shown.length, 0);
    ui.brand.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', repeat: false }));
    assert.equal(ui.shown.length, 1);
});

test('captures historical and live logs while forwarding original console arguments', t => {
    const ui = setup(t);
    const details = { status: 'failed' };
    console.warn('before opening', details);
    ui.tap(7);
    assert.match(ui.output.textContent!, /\d{4}-\d\d-\d\dT.* WARN before opening {"status":"failed"}/);
    assert.deepEqual(ui.forwarded.warn.mock.calls[0].arguments, ['before opening', details]);
    for (const level of ['debug', 'log', 'info', 'error'] as const) {
        console[level](`live ${level}`);
        assert.match(ui.output.textContent!, new RegExp(`${level.toUpperCase()} live ${level}`));
        assert.equal(ui.forwarded[level].mock.callCount(), 1);
    }
    console.log('<img src=x onerror=alert(1)>');
    assert.ok(ui.output.textContent!.includes('<img src=x onerror=alert(1)>'));
    ui.close();
    const closedText = ui.output.textContent;
    console.info('while closed');
    assert.equal(ui.output.textContent, closedText);
    ui.tap(7);
    assert.match(ui.output.textContent!, /while closed/);
});

test('severity checkboxes filter existing and future logs; info includes console.log', t => {
    const ui = setup(t);
    console.error('error entry');
    console.warn('warning entry');
    console.info('info entry');
    console.log('plain log entry');
    console.debug('debug entry');
    ui.tap(7);
    assert.match(ui.panel.innerHTML, /data-log-filter="error"/);
    assert.match(ui.panel.innerHTML, /data-log-filter="warn"/);
    assert.match(ui.panel.innerHTML, /data-log-filter="info"/);
    assert.match(ui.panel.innerHTML, /data-log-filter="debug"/);
    assert.equal(ui.checkboxes.every(checkbox => checkbox.checked), true);

    const toggle = (filter: string, checked: boolean): void => {
        const checkbox = ui.checkboxes.find(item => item.dataset.logFilter === filter)!;
        checkbox.checked = checked;
        checkbox.dispatchEvent(new Event('change'));
    };
    toggle('error', false);
    assert.doesNotMatch(ui.output.textContent!, /ERROR error entry/);
    assert.match(ui.output.textContent!, /WARN warning entry/);

    toggle('warn', false);
    toggle('info', false);
    assert.match(ui.output.textContent!, /DEBUG debug entry/);
    assert.doesNotMatch(ui.output.textContent!, /warning entry|info entry|plain log entry/);

    console.info('filtered live info');
    assert.doesNotMatch(ui.output.textContent!, /filtered live info/);
    toggle('info', true);
    assert.match(ui.output.textContent!, /INFO info entry/);
    assert.match(ui.output.textContent!, /LOG plain log entry/);
    assert.match(ui.output.textContent!, /INFO filtered live info/);
    toggle('debug', false);
    toggle('info', false);
    assert.equal(ui.output.textContent, 'No matching logs.');
    toggle('error', true);
    console.error('new error');
    assert.match(ui.output.textContent!, /ERROR error entry/);
    assert.match(ui.output.textContent!, /ERROR new error/);
    ui.clear.click();
    assert.equal(ui.output.textContent, 'No logs captured.');
});

test('caps history and entry length, and Clear keeps the panel open', t => {
    const ui = setup(t);
    for (let i = 0; i < 305; i++) console.log(`entry-${i}`);
    ui.tap(7);
    const lines = ui.output.textContent!.split('\n');
    assert.equal(lines.length, 300);
    assert.match(lines[0], /LOG entry-5$/);
    assert.match(lines[299], /LOG entry-304$/);
    console.log('x'.repeat(2500));
    assert.match(ui.output.textContent!, new RegExp(`LOG ${'x'.repeat(2000)} \\[truncated\\]$`));
    ui.clear.click();
    assert.equal(ui.panel.hidden, false);
    assert.equal(ui.output.textContent, 'No logs captured.');
    console.log('after clear');
    assert.match(ui.output.textContent!, /after clear/);
    assert.equal(ui.output.textContent!.split('\n').length, 1);
});

test('handles errors, circular objects, bigint and unserializable values safely', t => {
    const ui = setup(t);
    const circular = { self: {} };
    circular.self = circular;
    const bad = { toJSON() { throw new Error('Cannot serialize'); } };
    assert.doesNotThrow(() => console.error(new Error('Failure'), circular, 42n, bad, undefined));
    ui.events.dispatchEvent(Object.assign(new Event('error'), {
        error: new Error('Uncaught failure')
    }));
    ui.events.dispatchEvent(Object.assign(new Event('error'), {
        error: null, message: 'Script failure', filename: 'app.js', lineno: 12, colno: 3
    }));
    ui.events.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
        reason: new Error('Promise failure')
    }));
    ui.tap(7);
    for (const expected of [
        'Error: Failure', '[Circular]', '42n', '[Unserializable log value]', 'undefined',
        'Uncaught failure', 'Script failure (app.js:12:3)', 'Unhandled promise rejection:',
        'Promise failure'
    ]) assert.ok(ui.output.textContent!.includes(expected), expected);
});

test('docks to either side, floats, and retains position when reopened', t => {
    const ui = setup(t);
    ui.tap(7);
    for (const side of ['left', 'right']) {
        ui.dock(side);
        assert.equal(ui.panel.dataset.dock, side);
        assert.equal(ui.panel.style.left, '');
        assert.equal(ui.panel.style.top, '');
        for (const button of ui.panel.buttons) {
            assert.equal(button.attributes.get('aria-pressed'), String(button.dataset.dockTo === side));
        }
    }
    ui.close();
    ui.tap(7);
    assert.equal(ui.panel.dataset.dock, 'right');
    ui.dock('float');
    assert.equal(ui.panel.dataset.dock, 'float');
    assert.equal(ui.panel.style.left, '432px', 'clamps undocking from right to the viewport');
    ui.close();
    ui.tap(7);
    assert.equal(ui.panel.style.left, '432px');
    ui.events.innerWidth = 700;
    ui.events.innerHeight = 600;
    ui.events.dispatchEvent(new Event('resize'));
    assert.equal(ui.panel.style.left, '132px');
    assert.equal(ui.panel.style.top, '8px');
});

function pointer(handle: ElementStub, type: string, x: number, y: number, id = 1): void {
    handle.dispatchEvent(Object.assign(new Event(type), {
        button: 0, isPrimary: true, clientX: x, clientY: y, pointerId: id
    }));
}

test('title dragging moves, clamps, snaps to both sides, and undocks', t => {
    const ui = setup(t);
    ui.tap(7);
    pointer(ui.handle, 'pointerdown', 108, 70);
    assert.equal(ui.handle.captured, 1);
    pointer(ui.handle, 'pointermove', 300, 210);
    assert.equal(ui.panel.style.left, '200px');
    assert.equal(ui.panel.style.top, '200px');
    pointer(ui.handle, 'pointerup', 300, 210);
    assert.equal(ui.panel.dataset.dock, 'float');
    assert.equal(ui.handle.captured, null);
    pointer(ui.handle, 'pointerdown', 300, 210);
    pointer(ui.handle, 'pointermove', -100, 1000);
    assert.equal(ui.panel.style.left, '8px');
    assert.equal(ui.panel.style.top, '312px');
    pointer(ui.handle, 'pointerup', 20, 200);
    assert.equal(ui.panel.dataset.dock, 'left');
    pointer(ui.handle, 'pointerdown', 100, 20);
    assert.equal(ui.panel.dataset.dock, 'float');
    pointer(ui.handle, 'pointerup', 980, 100);
    assert.equal(ui.panel.dataset.dock, 'right');
});

test('cancelled dragging and unrelated pointers do not move or dock the panel', t => {
    const ui = setup(t);
    ui.tap(7);
    pointer(ui.handle, 'pointerdown', 108, 70);
    const original = { ...ui.panel.style };
    pointer(ui.handle, 'pointermove', 900, 600, 2);
    assert.deepEqual(ui.panel.style, original);
    pointer(ui.handle, 'pointerup', 999, 300, 2);
    assert.equal(ui.panel.dataset.dock, 'float');
    pointer(ui.handle, 'pointercancel', 108, 70);
    pointer(ui.handle, 'pointermove', 900, 600);
    assert.deepEqual(ui.panel.style, original);
    pointer(ui.handle, 'pointerup', 999, 300);
    assert.equal(ui.panel.dataset.dock, 'float');
});

test('bottom docking supports controls, reopen, floating and drag snapping with corner priority', t => {
    const ui = setup(t);
    ui.tap(7);
    assert.match(ui.panel.innerHTML, /data-dock-to="bottom"/);
    ui.dock('bottom');
    assert.equal(ui.panel.dataset.dock, 'bottom');
    assert.equal(ui.panel.style.left, '');
    assert.equal(ui.panel.style.top, '');
    assert.equal(ui.panel.buttons.find(button => button.dataset.dockTo === 'bottom')!.attributes.get('aria-pressed'), 'true');
    ui.close();
    ui.tap(7);
    assert.equal(ui.panel.dataset.dock, 'bottom');
    ui.dock('float');
    assert.equal(ui.panel.style.top, '312px', 'clamps undocking from bottom to the viewport');
    pointer(ui.handle, 'pointerdown', 108, 322);
    pointer(ui.handle, 'pointerup', 500, 775);
    assert.equal(ui.panel.dataset.dock, 'float', 'does not snap outside the 24px threshold');
    pointer(ui.handle, 'pointerdown', 500, 322);
    pointer(ui.handle, 'pointerup', 500, 776);
    assert.equal(ui.panel.dataset.dock, 'bottom');
    pointer(ui.handle, 'pointerdown', 900, 482);
    pointer(ui.handle, 'pointermove', 300, 200);
    assert.equal(ui.panel.dataset.dock, 'float');
    assert.equal(ui.panel.style.left, '8px', 'undocking a wide panel clamps the drag offset');
    pointer(ui.handle, 'pointerup', 10, 790);
    assert.equal(ui.panel.dataset.dock, 'bottom', 'bottom wins over left at the corner');
    pointer(ui.handle, 'pointerdown', 100, 482);
    pointer(ui.handle, 'pointerup', 990, 790);
    assert.equal(ui.panel.dataset.dock, 'bottom', 'bottom wins over right at the corner');
});

test('panel keyboard events stay out of game shortcuts and Escape closes it', t => {
    const ui = setup(t);
    ui.tap(7);
    for (const key of ['ArrowLeft', 'ArrowRight', 'f', 'Escape']) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
        const stopped = t.mock.method(event, 'stopPropagation');
        ui.panel.dispatchEvent(event);
        assert.equal(stopped.mock.callCount(), 1);
    }
    assert.equal(ui.panel.hidden, true);
    assert.equal(ui.brand.focused, true);
});

test('floating resize respects minimums and viewport bounds and retains its size', t => {
    const ui = setup(t);
    ui.tap(7);
    pointer(ui.grip, 'pointerdown', 568, 540);
    pointer(ui.grip, 'pointermove', 668, 590);
    assert.equal(ui.panel.style.width, '660px');
    assert.equal(ui.panel.style.height, '530px');
    pointer(ui.grip, 'pointerup', 668, 590);
    ui.close();
    ui.tap(7);
    assert.equal(ui.panel.style.width, '660px');
    assert.equal(ui.panel.style.height, '530px');
    ui.dock('left');
    ui.dock('float');
    assert.equal(ui.panel.style.width, '660px');
    assert.equal(ui.panel.style.height, '530px');
    pointer(ui.grip, 'pointerdown', 668, 538);
    pointer(ui.grip, 'pointermove', -1000, -1000);
    assert.equal(ui.panel.style.width, '280px');
    assert.equal(ui.panel.style.height, '220px');
    pointer(ui.grip, 'pointerup', 3000, 3000);
    assert.equal(ui.panel.style.width, '984px');
    assert.equal(ui.panel.style.height, '784px');
});

test('docked resize changes only the free dimension with mode-specific sizes', t => {
    const ui = setup(t);
    ui.tap(7);
    for (const [mode, x, y, width, height] of [
        ['left', 100, 100, '480px', ''],
        ['right', -100, 100, '480px', ''],
        ['bottom', 100, -100, '', '420px']
    ] as const) {
        ui.dock(mode);
        pointer(ui.grip, 'pointerdown', 0, 0);
        pointer(ui.grip, 'pointerup', x, y);
        assert.equal(ui.panel.dataset.dock, mode);
        assert.equal(ui.panel.style.width, width);
        assert.equal(ui.panel.style.height, height);
    }
    ui.dock('left');
    assert.equal(ui.panel.style.width, '480px');
    ui.dock('bottom');
    assert.equal(ui.panel.style.height, '420px');
});

test('resize supports keyboard arrows and ignores cancelled and unrelated pointers', t => {
    const ui = setup(t);
    ui.tap(7);
    const right = Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' });
    ui.grip.dispatchEvent(right);
    assert.equal(right.defaultPrevented, true);
    assert.equal(ui.panel.style.width, '580px');
    ui.dock('bottom');
    ui.grip.dispatchEvent(Object.assign(new Event('keydown'), { key: 'ArrowUp' }));
    assert.equal(ui.panel.style.height, '340px');
    pointer(ui.grip, 'pointerdown', 0, 0);
    const original = { ...ui.panel.style };
    pointer(ui.grip, 'pointermove', 0, -100, 2);
    assert.deepEqual(ui.panel.style, original);
    pointer(ui.grip, 'pointercancel', 0, 0);
    pointer(ui.grip, 'pointermove', 0, -100);
    pointer(ui.grip, 'pointerup', 0, -100);
    assert.deepEqual(ui.panel.style, original);
});
