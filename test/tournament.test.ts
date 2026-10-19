import test from 'node:test';
import assert from 'node:assert';
import * as T from '../src/tournament.ts';

function setup(n: number): T.TournamentState {
    const t = T.create({ id: 't1', host: 'a@x', hostName: 'A', now: 0 });
    for (let i = 1; i < n; i++) T.addPlayer(t, `${'abcdef'[i]}@x`, 'abcdef'[i].toUpperCase(), 0);
    return t;
}

test('create/join/withdraw bump revision and roster', () => {
    const t = setup(3);
    assert.deepStrictEqual(Object.keys(t.players).sort(), ['a@x', 'b@x', 'c@x']);
    const rev = t.rev;
    assert.strictEqual(T.addPlayer(t, 'b@x', 'B', 1), false, 'duplicate join is a no-op');
    assert.strictEqual(t.rev, rev);
    assert.ok(T.withdraw(t, 'c@x'));
    assert.ok(t.rev > rev);
    assert.ok(T.addPlayer(t, 'c@x', 'C', 2), 'rejoin after withdraw');
    assert.strictEqual(t.players['c@x'].withdrawn, false);
});

test('selectable durations control the deadline and preserve the default', () => {
    assert.strictEqual(T.create({ id: 'default', host: 'a', hostName: 'A', now: 1000 }).durationMs, 60 * 60000);
    for (const minutes of [15, 30, 45, 60]) {
        assert.strictEqual(T.validDurationMinutes(minutes), true);
        const t = T.create({ id: 't', host: 'a', hostName: 'A', now: 1000, durationMs: minutes * 60000 });
        assert.strictEqual(T.endTs(t), 1000 + minutes * 60000);
        assert.strictEqual(T.updateStatus(t, T.endTs(t) - 1), false);
        assert.strictEqual(T.clone(t).durationMs, minutes * 60000);
        assert.strictEqual(T.updateStatus(t, T.endTs(t)), true);
        assert.strictEqual(t.status, 'finished');
    }
    for (const value of [undefined, null, '30', 0, 20, 90, NaN, Infinity]) {
        assert.strictEqual(T.validDurationMinutes(value), false);
    }
});

test('pairing pairs idle online players, balances colours and avoids immediate rematches', () => {
    const t = setup(4);
    const online = new Set(Object.keys(t.players));
    const pairs = T.pairings(t, 10000, online);
    assert.strictEqual(pairs.length, 2);
    assert.strictEqual(new Set(pairs.flatMap((p) => [p.white, p.black])).size, 4);
    assert.deepStrictEqual(T.pairings(t, 10000, new Set(['a@x'])), [], 'offline players are not paired');

    pairs.forEach((p, i) => T.startGame(t, `g${i}`, p.white, p.black, 10000));
    assert.deepStrictEqual(T.pairings(t, 11000, online), [], 'busy players are not paired');
    T.applyResult(t, 'g0', '1-0', 'checkmate', 20000);
    assert.deepStrictEqual(T.pairings(t, 20000 + T.REST_MS, online), [], 'no immediate rematch while others play');
    T.applyResult(t, 'g1', '0-1', 'resign', 20000);
    const next = T.pairings(t, 20000 + T.REST_MS, online);
    assert.strictEqual(next.length, 2);
    for (const p of next) {
        assert.notStrictEqual(t.players[p.white].lastOpp, p.black, 'new opponent');
        assert.ok(t.players[p.white].whites <= t.players[p.white].blacks, 'previous black gets white');
    }
});

test('arena scoring with streak bonus and standings', () => {
    const t = setup(2);
    for (let i = 0; i < 3; i++) {
        T.startGame(t, `g${i}`, 'a@x', 'b@x', i);
        T.applyResult(t, `g${i}`, '1-0', 'checkmate', i);
    }
    assert.strictEqual(t.players['a@x'].score, 2 + 2 + 4);
    assert.strictEqual(T.applyResult(t, 'g0', '0-1', 'x', 9), false, 'result applied once');
    T.startGame(t, 'g3', 'b@x', 'a@x', 10);
    T.applyResult(t, 'g3', '1/2-1/2', 'stalemate', 10);
    assert.strictEqual(t.players['a@x'].score, 8 + 2, 'draw on fire is doubled');
    const st = T.standings(t);
    assert.strictEqual(st[0].addr, 'a@x');
    assert.strictEqual(st[0].rank, 1);
    assert.strictEqual(st[1].score, 1);
});

test('lifecycle: running -> finishing -> finished, stale games adjudicated', () => {
    const t = setup(2);
    T.startGame(t, 'g', 'a@x', 'b@x', 1000);
    const end = T.endTs(t);
    assert.ok(T.updateStatus(t, end));
    assert.strictEqual(t.status, 'finishing');
    assert.deepStrictEqual(T.pairings(t, end, null), []);
    assert.ok(T.adjudicateStale(t, 1000 + T.MAX_GAME_MS + 1));
    T.updateStatus(t, end + 1);
    assert.strictEqual(t.status, 'finished');
});

test('pickNewer keeps the highest revision and converges on one tournament', () => {
    const a = setup(2), b = T.clone(a);
    T.addPlayer(b, 'z@x', 'Z', 5);
    assert.strictEqual(T.pickNewer(a, b), b);
    assert.strictEqual(T.pickNewer(b, a), b);
    assert.strictEqual(T.pickNewer(null, a), a);
    const later = T.create({ id: 't2', host: 'b@x', hostName: 'B', now: 100 });
    assert.strictEqual(T.pickNewer(a, later), a, 'earliest active tournament wins');
    assert.strictEqual(T.pickNewer(later, a), a);
});

test('tournament finishes early after play when fewer than two reachable participants remain', () => {
    for (const remaining of [new Set<string>(), new Set(['a@x']), new Set(['outsider'])]) {
        const t = setup(2);
        T.startGame(t, 'g', 'a@x', 'b@x', 1000);
        T.applyResult(t, 'g', '1-0', 'forfeit', 2000);
        const rev = t.rev;
        assert.ok(T.updateStatus(t, 2001, remaining));
        assert.strictEqual(t.status, 'finished');
        assert.strictEqual(t.rev, rev + 1);
        assert.ok(2001 < T.endTs(t));
        assert.deepStrictEqual(T.pairings(t, 2001, remaining), []);
        assert.strictEqual(T.updateStatus(t, 2002, remaining), false);
        assert.strictEqual(t.players['a@x'].score, 2, 'existing scores are retained');
    }
    const t = setup(2);
    T.startGame(t, 'g', 'a@x', 'b@x', 1000);
    T.applyResult(t, 'g', '1-0', 'checkmate', 2000);
    T.withdraw(t, 'b@x');
    assert.ok(T.updateStatus(t, 2001, new Set(['a@x', 'b@x'])));
    assert.strictEqual(t.status, 'finished', 'withdrawn players cannot keep the tournament running');
});

test('early completion preserves initial waiting, running matches, rest periods and rematches', () => {
    const t = setup(2);
    const online = new Set(['a@x', 'b@x']);
    assert.strictEqual(T.updateStatus(t, 1000, new Set(['a@x'])), false, 'wait for initial participants');
    T.startGame(t, 'g', 'a@x', 'b@x', 1000);
    assert.strictEqual(T.updateStatus(t, 2000, new Set(['a@x'])), false, 'do not end ongoing matches');
    T.applyResult(t, 'g', '1-0', 'checkmate', 3000);
    assert.deepStrictEqual(T.pairings(t, 3001, online), [], 'both players are resting');
    assert.strictEqual(T.updateStatus(t, 3001, online), false, 'rest is not a reason to finish');
    assert.strictEqual(T.updateStatus(t, 3001), false, 'unknown presence does not trigger early completion');
    assert.strictEqual(T.pairings(t, 3000 + T.REST_MS, online).length, 1, 'rematches remain possible');
    assert.strictEqual(t.status, 'running');
});

test('only the host can publish state, regardless of revision', () => {
    const t = setup(3);
    const incoming = T.clone(t);
    incoming.rev += 1000;
    assert.equal(T.canPublishState(t, incoming, 'c@x', new Set(['a@x', 'c@x'])), false);
    assert.equal(T.canPublishState(t, incoming, 'a@x', new Set(['a@x', 'c@x'])), true);
    assert.equal(T.canPublishState(null, incoming, 'c@x', null), false);
    incoming.durationMs++;
    assert.equal(T.canPublishState(t, incoming, 'a@x', null), false);
});

test('host failover requires the lowest online existing participant and an offline host', () => {
    const t = setup(3);
    const incoming = T.clone(t);
    incoming.host = 'b@x';
    incoming.rev++;
    assert.equal(T.canPublishState(t, incoming, 'b@x', new Set(['a@x', 'b@x'])), false);
    assert.equal(T.canPublishState(t, incoming, 'b@x', new Set(['b@x', 'c@x'])), true);
    incoming.host = 'c@x';
    assert.equal(T.canPublishState(t, incoming, 'c@x', new Set(['b@x', 'c@x'])), false);
    assert.equal(T.canPublishState(t, incoming, 'c@x', new Set(['c@x'])), true);
    assert.equal(T.canPublishState(t, incoming, 'c@x', null), true, 'replay requires existing membership, not historical presence');
    T.withdraw(t, 'c@x');
    incoming.rev = t.rev + 1;
    assert.equal(T.canPublishState(t, incoming, 'c@x', null), false);
    incoming.host = 'outsider';
    assert.equal(T.canPublishState(t, incoming, 'outsider', null), false);
});

test('tournament schema validates fields used in standings and game rendering', () => {
    const t = setup(2);
    T.startGame(t, 'g', 'a@x', 'b@x', 1);
    assert.equal(T.isValidState(t), true);
    assert.equal(T.isValidState({ ...t, rev: Infinity }), false);
    assert.equal(T.isValidState({ ...t, host: 'unknown' }), false);
    assert.equal(T.isValidState({ ...t, games: [] }), false);
    assert.equal(T.isValidState({
        ...t, players: { ...t.players, 'a@x': { ...t.players['a@x'], results: ['" onclick="alert(1)'] } }
    }), false);
    assert.equal(T.isValidState({
        ...t, games: { g: { ...t.games.g, white: '__proto__' } }
    }), false);
});
