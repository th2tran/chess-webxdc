import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRecord } from '../src/game.ts';
import { importPgn, PgnError, MAX_PGN_LENGTH } from '../src/pgn.ts';

const CHAT_PGN = `Event "Game vs computer"]
[Site "webxdc"]
[Date "2026.10.13"]
[White "my last brain cell"]
[Black "Computer · Intermediate"]
[Result "1-0"]
[TimeControl "-"]
[Termination "checkmate"]
e4 Nc6 2. d4 d5 3. exd5 Qxd5 4. Nf3 Nf6 5. c4 Qe4+ 6. Be2 e5 7. Nc3 Bb4 8. dxe5 Bxc3+ 9. bxc3 Nxe5 10. O-O Nxf3+ 11. Bxf3 Qxc4 12. Re1+ Be6 13. Ba3 Rd8 14. Qc2 Nd5 15. Qf5 Nxc3 16. Qg5 Nd5 17. Bxd5 Qh4 18. Qxh4 Kd7 19. Bxb7 c5 20. Bxc5 Kc7 21. Bf3 Bd5 22. Bxd5 Rxd5 23. Qc4 Rd7 24. Be7+ Kb8 25. Rab1+ Rb7 26. Qf4+ Ka8 27. Qf3 Rb8 28. Bd6 a6 29. Bxb8 Kxb8 30. Qxb7# 1-0`;

test('imports the supplied chat PGN, including its clipped header and missing first move number', () => {
    const g = importPgn(CHAT_PGN, 'import', 1000);
    assert.equal(g.kind, 'imported');
    assert.equal(g.white.name, 'my last brain cell');
    assert.equal(g.black.name, 'Computer · Intermediate');
    assert.equal(g.plies.length, 59);
    assert.equal(g.plies[0].uci, 'e2e4');
    assert.equal(g.plies[58].san, 'Qxb7#');
    assert.equal(g.status().reason, 'checkmate');
    assert.equal(g.result, '1-0');
    assert.equal(g.reason, 'checkmate');
    assert.equal(g.over, true);
    assert.equal(g.timed, false);
    assert.equal(g.colorOf('me@local'), null);
    assert.notEqual(g.fenAt(0), g.fenAt(59));
    assert.equal(g.startTs, new Date(2026, 9, 13).getTime());
    assert.equal(g.applyMove('a6a5', null, 1000), null, 'imported record is read-only');
    assert.match(g.pgn(), /\[Event "Game vs computer"\]/);
    assert.match(g.pgn(), /\[Date "2026\.10\.13"\]/);
    assert.match(g.pgn(), /\[TimeControl "-"\]/);
    const roundTrip = importPgn(g.pgn(), 'again');
    assert.equal(roundTrip.chess.fen(), g.chess.fen());
    assert.deepEqual(roundTrip.plies.map((p) => p.uci), g.plies.map((p) => p.uci));
});

test('imports native app exports and preserves escaped names and metadata', () => {
    const source = new GameRecord({
        id: 'computer', kind: 'computer', white: { addr: 'w', name: 'A "quoted" \\ name' },
        black: { addr: 'b', name: '<b>Black</b>' }, tc: 0, startTs: 1000
    });
    source.applyMove('e2e4', null, 1000);
    source.applyMove('e7e5', null, 1000);
    source.end('0-1', 'resignation', 1000);
    const imported = importPgn(source.pgn(), 'import');
    assert.equal(imported.white.name, source.white.name);
    assert.equal(imported.black.name, source.black.name);
    assert.equal(imported.result, '0-1');
    assert.equal(imported.reason, 'resignation');
    assert.equal(imported.pgnTags.Event, 'Game vs computer');
});

test('accepts code fences, attached move numbers, annotations, comments, NAGs and nested variations', () => {
    const g = importPgn('```pgn\n1.e4! {hello} (1.d4 (1.c4) d5) 1...e5 $1 2.Nf3?! ; comment\nNc6 *\n```', 'i');
    assert.deepEqual(g.plies.map((p) => p.uci), ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    assert.equal(g.result, null);
    assert.equal(g.over, true);
    assert.match(g.pgn(), /\[Result "\*"\]/);
});

test('imports unfinished games, result-only headers, castling, and inferred checkmate', () => {
    assert.equal(importPgn('1. e4 e5', 'i').result, null);
    assert.equal(importPgn('[Result "1/2-1/2"]\n1. e4 e5', 'i').result, '1/2-1/2');
    const castling = importPgn('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.0-0 *', 'i');
    assert.equal(castling.plies[6].san, 'O-O');
    const mate = importPgn('1.f3 e5 2.g4 Qh4#', 'i');
    assert.equal(mate.result, '0-1');
    assert.equal(mate.reason, 'checkmate');
});

test('rejects invalid PGN explicitly rather than importing a partial game', () => {
    for (const pgn of [
        '', '[Event "Game"]', '[Event Game]\n1.e4', '[Result "winner"]\n1.e4',
        '[Result "1-0"]\n1.e4 0-1', '1.e4 e5 2.Bh6 *',
        '1.e4 {unclosed', '1.e4 (1.d4', '1.e4 )',
        '1.e4 }', '1.e4 * 1.d4', '1.f3 e5 2.g4 Qh4# 1-0',
        '[SetUp "1"]\n1.e4', '[FEN "custom"]\n1.e4',
        '[White "A"]\n[White "B"]\n1.e4',
        '1.e4 *\n[Event "Second game"]\n1.d4 *'
    ]) assert.throws(() => importPgn(pgn, 'i'), PgnError, pgn);
    assert.throws(() => importPgn('x'.repeat(MAX_PGN_LENGTH + 1), 'i'), /too large/);
});
