import test from 'node:test';
import assert from 'node:assert/strict';
import { Puzzle, matchesPuzzleResponse } from '../src/puzzles.ts';
import { PgnError } from '../src/pgn.ts';
import { APP_ID, type MessageOf } from '../src/net.ts';

const player = { addr: 'me', name: 'Player' };
const blackPuzzle = `[Result "*"]
[FEN "2k3r1/pp2pbr1/q1p4p/4RPn1/3P4/PNB1Q3/1PP3BP/5R1K b - - 0 1"]

1... Qxf1+ 2. Bxf1 Nf3 3. Qxf3 Rg1# *`;

test('puzzles start at the PGN FEN, hide the solution, and give the player the side to move', () => {
    const puzzle = new Puzzle(blackPuzzle, 'puzzle', player, 1000);
    const g = puzzle.game;
    assert.equal(g.kind, 'puzzle');
    assert.equal(g.turn, 'b');
    assert.equal(g.colorOf(player.addr), 'b');
    assert.equal(g.plies.length, 0);
    assert.equal(g.over, false);
    assert.equal(g.timed, false);
    assert.equal(g.learnerMode, false);
    assert.doesNotMatch(g.pgn(), /Qxf1|Rg1/);
    assert.match(g.startFen, / b - - 0 1$/);
});

test('incorrect moves leave the puzzle unchanged; correct moves play the computer reply and solve', () => {
    const puzzle = new Puzzle(blackPuzzle, 'puzzle', player);
    const g = puzzle.game;
    const start = g.chess.fen();
    assert.equal(puzzle.play('a6a5'), false);
    assert.equal(g.chess.fen(), start);
    assert.equal(g.plies.length, 0);
    assert.equal(puzzle.play('a6f1'), true);
    assert.deepEqual(g.plies.map(p => p.uci), ['a6f1', 'g2f1']);
    assert.equal(g.turn, 'b');
    assert.equal(g.over, false);
    assert.equal(puzzle.play('g5f3'), true);
    assert.deepEqual(g.plies.map(p => p.uci), ['a6f1', 'g2f1', 'g5f3', 'e3f3']);
    assert.equal(puzzle.play('g7g1'), true);
    assert.equal(g.over, true);
    assert.equal(g.result, '0-1');
    assert.equal(g.reason, 'puzzle solved');
    assert.equal(puzzle.play('g7g1'), false);
});

test('white puzzles support promotion and a one-move solution', () => {
    const puzzle = new Puzzle('[FEN "7k/P7/6K1/8/8/8/8/8 w - - 0 23"]\n23. a8=Q# *', 'promotion', player);
    assert.equal(puzzle.game.colorOf(player.addr), 'w');
    assert.equal(puzzle.play('a7a8n'), false);
    assert.equal(puzzle.play('a7a8q'), true);
    assert.equal(puzzle.game.over, true);
    assert.equal(puzzle.game.result, '1-0');
    assert.equal(puzzle.game.plies.length, 1);
});

test('puzzles reject malformed, oversized, missing-FEN, empty and illegal solutions', () => {
    for (const pgn of [
        '', 'x'.repeat(100001), '1. e4 *',
        '[FEN "7k/8/6K1/8/8/8/8/Q7 w - - 0 1"]\n*',
        '[FEN "invalid"]\n*', blackPuzzle.replace('Qxf1+', 'Qa9'),
    ]) assert.throws(() => new Puzzle(pgn, 'invalid', player), PgnError);
});

test('puzzle replies must match the current coach, recipient, request, game and response window', () => {
    const pending = { requestId: 'r', gameId: 'g', coach: 'coach', sentAt: 10_000 };
    const response: MessageOf<'puzzle-response'> = {
        app: APP_ID, id: 'response', from: 'coach', name: 'Coach', ts: 11_000,
        type: 'puzzle-response', to: 'me', requestId: 'r', gameId: 'g', pgn: blackPuzzle
    };
    assert.equal(matchesPuzzleResponse(response, pending, 'me', 12_000), true);
    for (const patch of [
        { to: 'peer' }, { from: 'another-coach' }, { requestId: 'old' }, { gameId: 'old' },
        { ts: 0 }, { ts: 20_000 }
    ]) assert.equal(matchesPuzzleResponse({ ...response, ...patch }, pending, 'me', 12_000), false);
    assert.equal(matchesPuzzleResponse(response, pending, 'me', 40_001), false);
    assert.equal(matchesPuzzleResponse(response, pending, 'me', 9999), false);
});
