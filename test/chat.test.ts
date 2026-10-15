import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatHistory, MAX_CHAT_MESSAGES, STORAGE_CHAT, type ChatLine } from '../src/chat.ts';

function message(index: number): ChatLine {
    return { id: String(index), from: 'peer', name: 'Peer', text: `Message ${index}`, ts: 1700000000000 + index };
}

function withStorage(run: (data: Map<string, string>) => void): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => { data.set(key, value); }
        }
    });
    try {
        run(data);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else Reflect.deleteProperty(globalThis, 'localStorage');
    }
}

test('chat restores messages and their original timestamps between runs', () => withStorage((data) => {
    const history = new ChatHistory();
    assert.deepEqual(history.lines, []);
    history.add(message(1));
    history.add(message(2));
    assert.deepEqual(new ChatHistory().lines, [message(1), message(2)]);
    assert.deepEqual(JSON.parse(data.get(STORAGE_CHAT)!), [message(1), message(2)]);
}));

test('chat retains exactly the newest 100 messages in memory and storage', () => withStorage((data) => {
    const history = new ChatHistory();
    for (let i = 0; i < 125; i++) history.add(message(i));
    const expected = Array.from({ length: MAX_CHAT_MESSAGES }, (_, i) => message(i + 25));
    assert.deepEqual(history.lines, expected);
    assert.deepEqual(JSON.parse(data.get(STORAGE_CHAT)!), expected);
    assert.deepEqual(new ChatHistory().lines, expected);
}));

test('replayed history does not duplicate or displace cached newer messages', () => withStorage(() => {
    const history = new ChatHistory();
    for (let i = 25; i < 125; i++) history.add(message(i));
    const restored = new ChatHistory();
    const expected = [...restored.lines];
    for (let i = 0; i < 125; i++) assert.equal(restored.add(message(i)), false);
    assert.deepEqual(restored.lines, expected);
    assert.equal(restored.add(message(125)), true);
    assert.equal(restored.lines.length, MAX_CHAT_MESSAGES);
    assert.deepEqual(restored.lines.at(-1), message(125));
}));

test('out-of-order deliveries are retained in timestamp order', () => withStorage(() => {
    const history = new ChatHistory();
    history.add(message(3));
    history.add(message(1));
    history.add(message(2));
    assert.deepEqual(history.lines, [message(1), message(2), message(3)]);
}));

test('oversized saved histories are trimmed and deduplicated on restore', () => withStorage((data) => {
    data.set(STORAGE_CHAT, JSON.stringify([...Array.from({ length: 125 }, (_, i) => message(i)), message(124)]));
    const expected = Array.from({ length: MAX_CHAT_MESSAGES }, (_, i) => message(i + 25));
    assert.deepEqual(new ChatHistory().lines, expected);
    assert.deepEqual(JSON.parse(data.get(STORAGE_CHAT)!), expected);
}));

test('invalid timestamps are not added to chat history', (t) => withStorage(() => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const history = new ChatHistory();
    for (const ts of [NaN, Infinity, 1e20]) {
        assert.equal(history.add({ ...message(1), ts }), false);
    }
    assert.deepEqual(history.lines, []);
    assert.equal(warnings.mock.callCount(), 3);
}));

test('corrupt saved history is reported and new messages can still be saved', (t) => withStorage((data) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    for (const raw of ['{', '{}', JSON.stringify([{ ...message(1), ts: 'invalid' }])]) {
        data.set(STORAGE_CHAT, raw);
        const history = new ChatHistory();
        assert.deepEqual(history.lines, []);
        assert.equal(history.add(message(2)), true);
        assert.deepEqual(new ChatHistory().lines, [message(2)]);
    }
    assert.equal(warnings.mock.callCount(), 3);
}));

test('unavailable storage is reported without preventing in-memory chat', (t) => withStorage(() => {
    const warnings = t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis.localStorage, 'getItem', () => { throw new Error('Storage unavailable'); });
    t.mock.method(globalThis.localStorage, 'setItem', () => { throw new Error('Storage unavailable'); });
    const history = new ChatHistory();
    assert.equal(history.add(message(1)), true);
    assert.deepEqual(history.lines, [message(1)]);
    assert.equal(warnings.mock.callCount(), 2);
}));
