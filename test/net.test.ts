import test from 'node:test';
import assert from 'node:assert/strict';
import { Net, APP_ID, type Message, type ReceiveContext } from '../src/net.ts';
import type { Webxdc, WebxdcUpdate } from '../src/webxdc.d.ts';

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
