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

const PUZZLE_FEN = '6k1/8/8/8/8/8/5Q2/1B4K1 w - - 0 1';
const PUZZLE_PGN = `[Event "Tactics Puzzle"]
[Site "?"]
[Date "????.??.??"]
[White "White"]
[Black "Black"]
[Result "*"]
[SetUp "1"]
[FEN "${PUZZLE_FEN}"]

*
`;

test('imports the supplied position-only puzzle and preserves it through export', () => {
    const g = importPgn(PUZZLE_PGN, 'puzzle', 1000);
    assert.equal(g.kind, 'imported');
    assert.equal(g.startFen, PUZZLE_FEN);
    assert.equal(g.chess.fen(), PUZZLE_FEN);
    assert.equal(g.fenAt(0), PUZZLE_FEN);
    assert.equal(g.plies.length, 0);
    assert.equal(g.turn, 'w');
    assert.equal(g.result, null);
    assert.equal(g.over, true);
    assert.equal(g.startTs, 1000);
    assert.equal(g.applyMove('f2f8', null, 1000), null);
    assert.match(g.pgn(), /\[Event "Tactics Puzzle"\]/);
    assert.match(g.pgn(), /\[Date "\?\?\?\?\.\?\?\.\?\?"\]/);
    assert.match(g.pgn(), /\[SetUp "1"\]/);
    const roundTrip = importPgn(g.pgn(), 'again');
    assert.equal(roundTrip.fenAt(0), PUZZLE_FEN);
    assert.equal(roundTrip.plies.length, 0);
});

test('imports moves from a custom position and rejects moves legal only at the standard start', () => {
    const headers = PUZZLE_PGN.slice(0, PUZZLE_PGN.lastIndexOf('*'));
    const g = importPgn(headers.replace('[Result "*"]', '[Result "1-0"]') + '1. Qf3 Kh8 2. Qf8# 1-0', 'puzzle');
    assert.deepEqual(g.plies.map(p => p.uci), ['f2f3', 'g8h8', 'f3f8']);
    assert.equal(g.fenAt(0), PUZZLE_FEN);
    assert.equal(g.fenAt(1), g.plies[0].fen);
    assert.match(g.pgn(), /1\. Qf3 Kh8 2\. Qf8# 1-0/);
    const roundTrip = importPgn(g.pgn(), 'again');
    assert.equal(roundTrip.chess.fen(), g.chess.fen());
    assert.throws(() => importPgn(headers + '1. e4 *', 'bad'), /Invalid or illegal move/);
});

test('preserves black-to-move positions and noninitial move numbers', () => {
    const fen = '6k1/8/8/8/8/8/5Q2/1B4K1 b - - 0 23';
    const g = importPgn(`[SetUp "1"]\n[FEN "${fen}"]\n23... Kh8 24. Qf8# 1-0`, 'black');
    assert.equal(g.turn, 'b');
    assert.equal(g.plies[0].color, 'b');
    assert.equal(g.moveNumberAt(0), 23);
    assert.equal(g.moveNumberAt(1), 24);
    assert.equal(g.moveNumberAt(2), 24);
    assert.equal(g.result, '1-0');
    assert.match(g.pgn(), /23\.\.\. Kh8 24\. Qf8# 1-0/);
    assert.equal(importPgn(g.pgn(), 'again').chess.fen(), g.chess.fen());
    const white = importPgn(`[FEN "${PUZZLE_FEN.replace('0 1', '0 23')}"]\n23. Qf3 Kh8 *`, 'white');
    assert.equal(white.moveNumberAt(0), 23);
    assert.equal(white.moveNumberAt(1), 23);
    assert.equal(white.moveNumberAt(2), 24);
    assert.match(white.pgn(), /23\. Qf3 Kh8 \*/);
});

test('accepts FEN without SetUp or moves and checks terminal positions and results', () => {
    assert.equal(importPgn(`[FEN "${PUZZLE_FEN}"]`, 'fen').startFen, PUZZLE_FEN);
    const mate = '[SetUp "1"]\n[FEN "7k/8/8/8/8/8/8/K6Q b - - 0 1"]\n';
    // The king on h8 is in check but can still escape.
    assert.equal(importPgn(mate + '*', 'check').status().over, false);
    const terminal = '[SetUp "1"]\n[FEN "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1"]\n';
    assert.equal(importPgn(terminal + '*', 'mate').result, '1-0');
    assert.throws(() => importPgn(terminal + '0-1', 'bad'), /contradicts/);
    assert.throws(() => importPgn(terminal + 'Kh7 *', 'bad'), /finished position/);
});

test('rejects malformed FEN and inconsistent setup headers explicitly', () => {
    for (const fen of [
        '', 'custom', '8/8/8/8/8/8/8/8 w - - 0 1',
        PUZZLE_FEN.replace('6k1', '5k1'),
        PUZZLE_FEN.replace('6k1', '5kk1'),
        PUZZLE_FEN.replace('6k1', '6kp'),
        PUZZLE_FEN.replace(' w ', ' x '),
        PUZZLE_FEN.replace(' - - ', ' KK - '),
        PUZZLE_FEN.replace(' - - ', ' - a9 '),
        PUZZLE_FEN.replace('0 1', '-1 1'),
        PUZZLE_FEN.replace('0 1', '0 0'),
        PUZZLE_FEN.replace('0 1', '0 1junk'),
        PUZZLE_FEN.replace('0 1', '0 9007199254740992')
    ]) assert.throws(() => importPgn(`[FEN "${fen}"]\n*`, 'bad'), PgnError, fen);
    for (const setup of ['0', '2', '']) {
        assert.throws(() => importPgn(`[SetUp "${setup}"]\n[FEN "${PUZZLE_FEN}"]\n*`, 'bad'), PgnError);
    }
});

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
    assert.deepEqual(g.commentsAt(1), ['hello']);
    assert.deepEqual(g.commentsAt(3), ['comment']);
    assert.match(g.pgn(), /\[Result "\*"\]/);
});

test('retains the supplied Albin annotations for each playback step and PGN round trip', () => {
    const g = importPgn(`[Event "Albin Countergambit - 2...e5"]
[Site "?"]
[ECO "D08"]

1. d4 {Claim the center.} d5 {Counter-claim the center.}
2. c4 {Attack d5.} e5 {Counter-gambit: attack d4 and offer a pawn back.}
3. dxe5 {Capture; if White declines with e3 the gambit is unsound.} d4
 {Strike at e3 and disrupt White's setup.}
4. e3 {Defend e5 and block the d4-pawn.} Nc6 {Develop and prepare ...Nxe5
 or ...dxe3.}
5. Nf3 {Develop; the e5-pawn is a target.}`, 'albin');
    const expected = [
        [],
        ['Claim the center.'],
        ['Counter-claim the center.'],
        ['Attack d5.'],
        ['Counter-gambit: attack d4 and offer a pawn back.'],
        ['Capture; if White declines with e3 the gambit is unsound.'],
        ["Strike at e3 and disrupt White's setup."],
        ['Defend e5 and block the d4-pawn.'],
        ['Develop and prepare ...Nxe5 or ...dxe3.'],
        ['Develop; the e5-pawn is a target.']
    ];
    assert.equal(g.plies.length, 9);
    const roundTrip = importPgn(g.pgn(), 'again');
    for (let ply = 0; ply <= g.plies.length; ply++) {
        assert.deepEqual(g.commentsAt(ply), expected[ply]);
        assert.deepEqual(roundTrip.commentsAt(ply), expected[ply]);
        assert.equal(roundTrip.fenAt(ply), g.fenAt(ply));
    }
    assert.equal(roundTrip.pgnTags.ECO, 'D08');
});

test('keeps initial, adjacent, trailing and line comments but excludes variation comments', () => {
    const g = importPgn(`{Introduction}
; Starting position
1.e4{First}{Second} (1.d4 {Ignored} (1.c4 ; Also ignored
) d5) e5 2.Nf3 ; <b>Develop</b> } safely
Nc6 * {Final} ; End of file`, 'comments');
    assert.deepEqual(g.commentsAt(0), ['Introduction', 'Starting position']);
    assert.deepEqual(g.commentsAt(1), ['First', 'Second']);
    assert.deepEqual(g.commentsAt(2), []);
    assert.deepEqual(g.commentsAt(3), ['<b>Develop</b> } safely']);
    assert.deepEqual(g.commentsAt(4), ['Final', 'End of file']);
    // Navigating backwards must not retain a later move's comment.
    assert.deepEqual(g.commentsAt(2), []);
    const roundTrip = importPgn(g.pgn(), 'again');
    for (let ply = 0; ply <= g.plies.length; ply++) {
        assert.deepEqual(roundTrip.commentsAt(ply), g.commentsAt(ply));
    }
    const position = importPgn(`[FEN "${PUZZLE_FEN}"]\n{Find the mate.} *`, 'position');
    assert.deepEqual(position.commentsAt(0), ['Find the mate.']);
    assert.deepEqual(importPgn(position.pgn(), 'again').commentsAt(0), ['Find the mate.']);
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
