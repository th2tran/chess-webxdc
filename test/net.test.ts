import test from 'node:test';
import assert from 'node:assert/strict';
import { Net, APP_ID, type Message, type ReceiveContext } from '../src/net.ts';
import type { Webxdc, WebxdcUpdate } from '../src/webxdc.d.ts';
import { Chess } from '../src/engine.ts';

test('received self-declared identities do not get locally-sent privileges', async () => {
    let receive: ((update: WebxdcUpdate<Message>) => void) | undefined;
    const wx: Webxdc<Message> = {
        selfAddr: 'me', selfName: 'Me',
        sendUpdate() {},
        setUpdateListener(listener) { receive = listener; return Promise.resolve(); }
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { webxdc: wx } });
    try {
        const net = new Net();
        const contexts: ReceiveContext[] = [];
        await net.start((_msg, ctx) => contexts.push(ctx));
        const msg: Message = { app: APP_ID, id: 'forged', from: 'me', name: 'Me', ts: 1, type: 'hello' };
        receive!({ payload: msg });
        assert.equal(contexts[0].local, false);
        assert.equal(contexts[0].source, 'update');
        net.send({ type: 'hello' });
        assert.equal(contexts[1].local, true);
        assert.equal(contexts[1].source, 'local');
    } finally {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

test('coach requests broadcast the board and history and replies arrive on the same XDC channel', async () => {
    let listen: ((data: Uint8Array) => void) | undefined;
    const broadcasts: Message[] = [];
    const updates: Array<Omit<WebxdcUpdate<Message>, 'serial' | 'max_serial'>> = [];
    const wx: Webxdc<Message> = {
        selfAddr: 'learner', selfName: 'Learner',
        sendUpdate(update) { updates.push(update); },
        setUpdateListener() { return Promise.resolve(); },
        joinRealtimeChannel() {
            return {
                setListener(listener) { listen = listener; },
                send(data) { broadcasts.push(JSON.parse(new TextDecoder().decode(data))); },
                leave() {}
            };
        }
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { webxdc: wx } });
    try {
        const net = new Net();
        const received: Array<{ msg: Message; ctx: ReceiveContext }> = [];
        await net.start((msg, ctx) => received.push({ msg, ctx }));
        const chess = new Chess();
        const startFen = chess.fen();
        chess.move('e2e4');
        chess.move('e7e5');
        const request = net.send({
            type: 'hint-request', requestId: 'hint1', gameId: 'computer1',
            startFen, fen: chess.fen(), moves: ['e2e4', 'e7e5']
        }, { persist: true });
        assert.deepEqual(broadcasts, [request]);
        assert.deepEqual(updates.map(u => u.payload), [request]);
        const reply: Message = {
            app: APP_ID, id: 'coach1', from: 'bot', name: 'Chess coach', ts: Date.now(),
            type: 'hint-response', to: 'learner', requestId: 'hint1', gameId: 'computer1',
            fen: chess.fen(), uci: 'g1f3'
        };
        listen!(new TextEncoder().encode(JSON.stringify(reply)));
        listen!(new TextEncoder().encode(JSON.stringify(reply)));
        assert.equal(received.length, 2, 'one local request and one deduplicated reply');
        assert.deepEqual(received[1], {
            msg: reply, ctx: { replay: false, local: false, source: 'realtime' }
        });
        assert.ok(chess.move(reply.uci!));
        net.leave();
    } finally {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});
