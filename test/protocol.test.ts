import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRecord, NETWORK_TC_MS, FLAG_GRACE_MS } from '../src/game.ts';
import { canMove, canEndGame, canDeclineDraw, validClock, validSync, syncClock, pruneCompletedGames, COMPLETED_GAME_LIMIT } from '../src/protocol.ts';
import { APP_ID, type MessageOf } from '../src/net.ts';

function game(id = 'g'): GameRecord {
    return new GameRecord({
        id, kind: 'network', white: { addr: 'white', name: 'White' }, black: { addr: 'black', name: 'Black' },
        tc: NETWORK_TC_MS, startTs: 0
    });
}

function sync(from: string, moves: string[]): MessageOf<'gsync'> {
    return {
        app: APP_ID, id: 'sync', from, name: from, ts: 1000, type: 'gsync', gameId: 'g',
        moves: moves.map((uci) => ({ uci, clock: { w: NETWORK_TC_MS, b: NETWORK_TC_MS } })),
        result: null, reason: null
    };
}

test('moves require the player for that ply, including buffered moves', () => {
    const g = game();
    assert.equal(canMove(g, 'spectator', 0), false);
    assert.equal(canMove(g, 'black', 0), false);
    assert.equal(canMove(g, 'white', 0), true);
    assert.equal(canMove(g, 'white', 2), true);
    assert.equal(canMove(g, 'black', 2), false);
    for (const ply of [-1, 0.5, Infinity, NaN]) assert.equal(canMove(g, 'white', ply), false);
});

test('live move clocks are locally derived and never overwrite the other side', () => {
    const g = game();
    assert.ok(g.applyMove('e2e4', { w: NETWORK_TC_MS, b: 0 }, 1000));
    assert.deepEqual(g.clock, { w: NETWORK_TC_MS - 1000, b: NETWORK_TC_MS });
    assert.ok(g.applyMove('e7e5', { w: 0, b: Number.MAX_VALUE }, 3000));
    assert.deepEqual(g.clock, { w: NETWORK_TC_MS - 1000, b: NETWORK_TC_MS - 2000 });
    const fen = g.chess.fen();
    assert.equal(g.applyMove('g1f3', { w: NaN, b: 0 }, 4000), null);
    assert.equal(g.chess.fen(), fen, 'malformed clocks must not mutate the board');
    assert.equal(validClock({ w: Infinity, b: 1 }), false);
    assert.equal(validClock({ w: -1, b: 1 }), false);
});

test('historical snapshots only restore the mover and cannot increase a clock', () => {
    const g = game();
    g.applyMove('e2e4', { w: 200000, b: 0 }, 1000, true);
    assert.deepEqual(g.clock, { w: 200000, b: NETWORK_TC_MS });
    g.applyMove('e7e5', { w: 0, b: 250000 }, 2000, true);
    g.applyMove('g1f3', { w: NETWORK_TC_MS, b: 0 }, 3000, true);
    assert.deepEqual(g.clock, { w: 200000, b: 250000 });
    const future = Date.now() + 3600000;
    g.applyMove('b8c6', { w: 200000, b: 250000 }, future, true);
    assert.ok(g.turnStart < future, 'a historical timestamp cannot freeze the live clock in the future');
});

test('game results require membership and a result consistent with the action', () => {
    const g = game();
    assert.equal(canEndGame(g, 'spectator', '0-1', 'resignation', 1), false);
    assert.equal(canEndGame(g, 'white', '1-0', 'resignation', 1), false);
    assert.equal(canEndGame(g, 'white', '0-1', 'resignation', 1), true);
    assert.equal(canEndGame(g, 'black', '1-0', 'resignation', 1), true);
    assert.equal(canEndGame(g, 'white', '1-0', 'checkmate', 1), false);
    assert.equal(canEndGame(g, 'white', '1-0', 'arbitrary', 1), false);
    assert.equal(canEndGame(g, 'white', '1/2-1/2', 'agreement', 1), false);
    g.drawOffer = 'white';
    assert.equal(canEndGame(g, 'white', '1/2-1/2', 'agreement', 1), false);
    assert.equal(canEndGame(g, 'black', '1/2-1/2', 'agreement', 1), true);
    assert.equal(canDeclineDraw(g, 'spectator'), false);
    assert.equal(canDeclineDraw(g, 'white'), false);
    assert.equal(canDeclineDraw(g, 'black'), true);
    assert.equal(canEndGame(g, 'white', '1/2-1/2', 'aborted', 1), true);
    g.applyMove('e2e4', null, 1);
    assert.equal(canEndGame(g, 'white', '1/2-1/2', 'aborted', 1), false);
});

test('timeouts require a locally expired clock and the correct winner', () => {
    const g = game();
    assert.equal(canEndGame(g, 'black', '0-1', 'time out', 1), false);
    assert.equal(canEndGame(g, 'white', '0-1', 'time out', NETWORK_TC_MS), true);
    assert.equal(canEndGame(g, 'black', '0-1', 'time out', NETWORK_TC_MS), false, 'opponent needs grace');
    assert.equal(canEndGame(g, 'black', '0-1', 'time out', NETWORK_TC_MS + FLAG_GRACE_MS), true);
    assert.equal(canEndGame(g, 'black', '1-0', 'time out', NETWORK_TC_MS + FLAG_GRACE_MS), false);
});

test('claimed board results must match the actual position', () => {
    const g = game();
    for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) g.applyMove(uci, null, 0);
    assert.equal(canEndGame(g, 'black', '0-1', 'checkmate', 0), true);
    assert.equal(canEndGame(g, 'black', '1-0', 'checkmate', 0), false);
    assert.equal(canEndGame(g, 'spectator', '0-1', 'checkmate', 0), false);
});

test('sync rejects spectators, conflicting prefixes, illegal suffixes and invented local moves', () => {
    const g = game();
    assert.equal(validSync(g, sync('spectator', ['e2e4']), 'black'), false);
    assert.equal(validSync(g, sync('white', ['e2e4']), 'black'), true);
    assert.equal(validSync(g, sync('white', ['e2e4', 'e7e5']), 'black'), false);
    assert.equal(validSync(g, sync('black', ['e2e4']), 'white'), false);
    assert.equal(validSync(g, sync('white', ['e2e4', 'e7e4']), 'spectator'), false);
    g.applyMove('d2d4', null, 1000);
    assert.equal(validSync(g, sync('black', ['e2e4', 'e7e5']), 'white'), false);
    assert.equal(validSync(g, sync('black', []), 'white'), false);
    assert.equal(validSync(g, sync('black', ['d2d4', 'd7d5']), 'white'), true);
    assert.equal(g.plies.length, 1, 'validation has no side effects');
});

test('sync can bridge a gap without discarding authorized buffered local moves', () => {
    const g = game();
    g.pending.set(1, { from: 'black', uci: 'e7e5', clock: { w: NETWORK_TC_MS, b: NETWORK_TC_MS }, at: 1000 });
    assert.equal(validSync(g, sync('white', ['e2e4', 'e7e5', 'g1f3']), 'black'), true);
    assert.equal(validSync(g, sync('white', ['e2e4', 'd7d5']), 'black'), false);
    const forgedClock = sync('white', ['e2e4', 'e7e5']);
    forgedClock.moves[1].clock.b = 0;
    assert.equal(syncClock(g, 1, forgedClock.moves[1].clock, 'black').b, NETWORK_TC_MS,
        'remote sync cannot change a buffered local clock');
});

test('sync refuses histories continuing after checkmate', () => {
    const g = game();
    assert.equal(validSync(g, sync('white', ['f2f3', 'e7e5', 'g2g4', 'd8h4']), 'spectator'), true);
    assert.equal(validSync(g, sync('white', ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'b1c3']), 'spectator'), false);
});

test('retention keeps the newest 100 completed games, the displayed game, and unfinished games', () => {
    const games = new Map<string, GameRecord>();
    const displayed = game('displayed');
    displayed.end('1/2-1/2', 'aborted', 0);
    games.set(displayed.id, displayed);
    for (let i = 1; i <= COMPLETED_GAME_LIMIT + 10; i++) {
        const g = game(String(i));
        g.end('1/2-1/2', 'aborted', i);
        games.set(g.id, g);
    }
    const active = game('active');
    games.set(active.id, active);
    pruneCompletedGames(games, displayed);
    assert.equal(games.size, COMPLETED_GAME_LIMIT + 2);
    assert.equal(games.get('displayed'), displayed);
    assert.equal(games.get('active'), active);
    assert.equal(games.has('10'), false);
    assert.equal(games.has('11'), true);
    pruneCompletedGames(games, active);
    assert.equal(games.has('displayed'), false);
    assert.equal(games.size, COMPLETED_GAME_LIMIT + 1);
});
