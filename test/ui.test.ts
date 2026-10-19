import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJson, saveJson } from '../src/ui.ts';
import type { TestContext } from 'node:test';

function replaceGlobal(t: TestContext, key: string, value: object): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
    });
}

test('duration preferences survive saving and restoring local storage', t => {
    const data = new Map<string, string>();
    replaceGlobal(t, 'localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); },
        removeItem: (key: string) => { data.delete(key); }
    });
    for (const minutes of [15, 30, 45, 60]) {
        saveJson('chess-xdc:prefs', { tournamentMinutes: minutes });
        assert.deepEqual(loadJson('chess-xdc:prefs', {}), { tournamentMinutes: minutes });
    }
    saveJson('chess-xdc:prefs', null);
    assert.deepEqual(loadJson('chess-xdc:prefs', { tournamentMinutes: 60 }), { tournamentMinutes: 60 });
});

test('storage failures log errors and show one warning per operation rather than failing silently', t => {
    const notifications: string[] = [];
    const root = {
        children: [],
        appendChild(node: { textContent: string }) { notifications.push(node.textContent); }
    };
    replaceGlobal(t, 'document', {
        getElementById: () => root,
        createElement: () => ({ className: '', textContent: '' })
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warnings = t.mock.method(console, 'warn', () => {});
    replaceGlobal(t, 'localStorage', {
        getItem() { throw new Error('Storage access denied'); },
        setItem() { throw new Error('Storage quota exceeded'); },
        removeItem() { throw new Error('Storage access denied'); }
    });
    assert.equal(loadJson('chess-xdc:prefs', 60), 60);
    assert.equal(loadJson('chess-xdc:prefs', 60), 60);
    saveJson('chess-xdc:prefs', { tournamentMinutes: 15 });
    saveJson('chess-xdc:prefs', { tournamentMinutes: 30 });
    saveJson('chess-xdc:prefs', null);
    assert.equal(warnings.mock.callCount(), 5);
    assert.equal(notifications.length, 2);
    assert.match(notifications[0], /Could not restore/);
    assert.match(notifications[1], /Could not save/);
});
