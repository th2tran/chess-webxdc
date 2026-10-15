import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRecord, type GameKind } from '../src/game.ts';
import { canRequestHint, describeHint, matchesCoachAvailability, matchesHintResponse, waitForCoachHint } from '../src/learner.ts';
import { APP_ID, type MessageOf } from '../src/net.ts';
import { bestMove } from '../src/ai.ts';
import { Chess } from '../src/engine.ts';

function game(learnerMode = true, kind: GameKind = 'computer'): GameRecord {
    return new GameRecord({
        id: 'g', kind, white: { addr: 'me', name: 'Me' }, black: { addr: 'ai', name: 'Computer' },
        startTs: 0, tc: 0, learnerMode
    });
}

test('coach startup availability must be fresh and match the requesting player and probe', () => {
    const pending = { requestId: 'probe1', sentAt: 20_000 };
    const reply: MessageOf<'coach-available'> = {
        app: APP_ID, id: 'available1', from: 'coach', name: 'Coach', ts: 20_100,
        type: 'coach-available', requestId: 'probe1', to: 'me'
    };
    assert.equal(matchesCoachAvailability(reply, pending, 'me', 20_200), true);
    assert.equal(matchesCoachAvailability(reply, pending, 'me', 30_001), false);
    assert.equal(matchesCoachAvailability({ ...reply, to: 'other' }, pending, 'me', 20_200), false);
    assert.equal(matchesCoachAvailability({ ...reply, requestId: 'old' }, pending, 'me', 20_200), false);
    assert.equal(matchesCoachAvailability({ ...reply, ts: 1 }, pending, 'me', 20_200), false);
    assert.equal(matchesCoachAvailability({ ...reply, ts: 90_000 }, pending, 'me', 20_200), false);
});

test('coach timeout falls back once at 30 seconds and stops retry broadcasts', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let retries = 0;
    let fallbacks = 0;
    waitForCoachHint(() => { retries++; }, () => { fallbacks++; });
    for (let i = 0; i < 14; i++) t.mock.timers.tick(2000);
    assert.equal(retries, 14);
    t.mock.timers.tick(1999);
    assert.equal(fallbacks, 0, 'do not fall back before the full response window');
    t.mock.timers.tick(1);
    assert.equal(fallbacks, 1);
    const sent = retries;
    t.mock.timers.tick(60_000);
    assert.equal(retries, sent, 'no more broadcasts during local analysis');
    assert.equal(fallbacks, 1);
});

test('coach reply or position cancellation prevents timeout fallback and retries', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let retries = 0;
    let fallbacks = 0;
    const cancel = waitForCoachHint(() => { retries++; }, () => { fallbacks++; });
    t.mock.timers.tick(2000);
    assert.equal(retries, 1);
    cancel();
    cancel();
    t.mock.timers.tick(60_000);
    assert.equal(retries, 1);
    assert.equal(fallbacks, 0);
});

test('learner mode is opt-in and limited to computer games', () => {
    const old = new GameRecord({
        id: 'old', kind: 'computer', white: { addr: 'w', name: 'White' }, black: { addr: 'b', name: 'Black' },
        startTs: 0, tc: 0
    });
    assert.equal(old.learnerMode, false, 'old saves remain compatible');
    assert.equal(game().learnerMode, true);
    assert.equal(game(false).learnerMode, false);
    for (const kind of ['network', 'tournament', 'imported'] as const) {
        assert.equal(game(true, kind).learnerMode, false);
    }
});

test('hints are available only on the learner’s live turn', () => {
    const g = game();
    assert.equal(canRequestHint(g, 'w', false, false), true);
    assert.equal(canRequestHint(g, 'b', false, false), false);
    assert.equal(canRequestHint(g, null, false, false), false);
    assert.equal(canRequestHint(g, 'w', true, false), false);
    assert.equal(canRequestHint(g, 'w', false, true), false);
    assert.equal(canRequestHint(game(false), 'w', false, false), false);
    g.applyMove('e2e4', null, 0);
    assert.equal(canRequestHint(g, 'w', false, false), false);
    g.applyMove('e7e5', null, 0);
    assert.equal(canRequestHint(g, 'w', false, false), true);
    g.end('1-0', 'resignation', 0);
    assert.equal(canRequestHint(g, 'w', false, false), false);
});

test('hints show SAN and squares without playing the suggested move', () => {
    const g = game();
    const fen = g.chess.fen();
    assert.equal(describeHint(fen, 'e2e4'), 'e4 (e2 to e4)');
    assert.equal(describeHint(fen, 'e2e5'), null);
    assert.equal(g.chess.fen(), fen);
    assert.equal(g.plies.length, 0);
});

test('coach replies must match the recipient, request, game and exact position', () => {
    const g = game();
    const pending = { requestId: 'hint1', gameId: g.id, fen: g.chess.fen() };
    const reply: MessageOf<'hint-response'> = {
        app: APP_ID, id: 'response1', from: 'coach', name: 'Coach', ts: Date.now(),
        type: 'hint-response', to: 'me', ...pending, uci: 'e2e4'
    };
    assert.equal(matchesHintResponse(reply, pending, 'me'), true);
    for (const patch of [
        { to: 'another-player' }, { requestId: 'old-request' }, { gameId: 'other-game' },
        { fen: 'a different position' }
    ]) assert.equal(matchesHintResponse({ ...reply, ...patch }, pending, 'me'), false);
    assert.equal(g.chess.fen(), pending.fen, 'receiving a hint never plays it');
});

test('expert hint search finds mate and explains promotion and castling', () => {
    const chess = new Chess('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    const before = chess.fen();
    const hint = bestMove(chess, 5);
    assert.equal(hint?.uci, 'd1d8');
    assert.equal(describeHint(before, hint!.uci), 'Rd8# (d1 to d8)');
    assert.equal(chess.fen(), before);
    assert.equal(describeHint('7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7a8q'), 'a8=Q+ (a7 to a8, promote to Q)');
    assert.equal(describeHint('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'), 'O-O (e1 to g1)');
});
