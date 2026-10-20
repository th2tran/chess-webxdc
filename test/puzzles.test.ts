import test from 'node:test';
import assert from 'node:assert/strict';
import { PUZZLE_TYPES, Puzzle, matchesPuzzleResponse, puzzleContinuation, puzzleThemeLabel, validPuzzleType } from '../src/puzzles.ts';
import { START_FEN } from '../src/engine.ts';
import { GameRecord } from '../src/game.ts';
import { PgnError } from '../src/pgn.ts';
import { APP_ID, type MessageOf } from '../src/net.ts';

const player = { addr: 'me', name: 'Player' };
const blackPuzzle = `[Result "*"]
[FEN "2k3r1/pp2pbr1/q1p4p/4RPn1/3P4/PNB1Q3/1PP3BP/5R1K b - - 0 1"]

1... Qxf1+ 2. Bxf1 Nf3 3. Qxf3 Rg1# *`;

test('solved nonterminal puzzles continue from the final position with the original player side', () => {
    for (const [pgn, moves, color] of [
        [`[FEN "${START_FEN}"]\n1. e4 e5 2. Nf3 *`, ['e2e4', 'g1f3'], 'w'],
        ['[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"]\n1... e5 2. Nf3 Nc6 *',
            ['e7e5', 'b8c6'], 'b']
    ] as const) {
        const puzzle = new Puzzle(pgn, 'continue', player);
        assert.equal(puzzleContinuation(puzzle.game, player.addr), null);
        for (const move of moves) assert.equal(puzzle.play(move), true);
        const g = puzzle.game;
        assert.equal(g.reason, 'puzzle solved');
        assert.equal(g.status().over, false);
        assert.deepEqual(puzzleContinuation(g, player.addr), { color, startFen: g.chess.fen() });
        assert.notEqual(g.turn, color, 'the computer, not the player, moves next');
        assert.equal(puzzleContinuation(g, 'spectator'), null);
    }
});

test('continuation excludes checkmate, drawn positions and non-puzzle games', () => {
    const puzzle = new Puzzle(blackPuzzle, 'mate', player);
    for (const move of ['a6f1', 'g5f3', 'g7g1']) assert.equal(puzzle.play(move), true);
    assert.equal(puzzle.game.status().reason, 'checkmate');
    assert.equal(puzzleContinuation(puzzle.game, player.addr), null);
    for (const fen of [
        '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
        '7k/8/6K1/8/8/8/8/8 b - - 0 1',
        '7k/8/6K1/8/8/8/8/R7 b - - 100 1'
    ]) {
        puzzle.game.chess.load(fen);
        assert.equal(puzzle.game.status().over, true);
        assert.equal(puzzleContinuation(puzzle.game, player.addr), null);
    }
    const computer = new GameRecord({
        id: 'computer', kind: 'computer', white: player, black: { addr: 'ai', name: 'Computer' }, tc: 0, startTs: 0
    });
    computer.end('1-0', 'puzzle solved', 1);
    assert.equal(puzzleContinuation(computer, player.addr), null);
});

test('puzzle themes have readable English labels, including future camelCase tags', () => {
    for (const [theme, label] of [
        ['mateIn2', 'Mate in 2'], ['mateIn3', 'Mate in 3'], ['mateIn5', 'Mate in 5 or more'],
        ['mate', 'Checkmate'], ['fork', 'Fork'], ['pin', 'Pin'],
        ['backRankMate', 'Back-rank mate'], ['xRayAttack', 'X-ray attack'],
        ['discoveredAttack', 'Discovered attack'], ['rookEndgame', 'Rook endgame'],
        ['anastasiaMate', "Anastasia's mate"], ['underPromotion', 'Underpromotion'],
        ['newFutureTheme', 'New future theme'], ['constructor', 'Constructor']
    ]) assert.equal(puzzleThemeLabel(theme), label);
});

test('puzzles retain deduplicated themes for display and PGN export without revealing solution moves', () => {
    const puzzle = new Puzzle(blackPuzzle, 'themes', player, 1000, ['mateIn3', 'sacrifice', 'mateIn3']);
    assert.equal(puzzle.game.pgnTags.Themes, 'mateIn3 sacrifice');
    assert.match(puzzle.game.pgn(), /\[Themes "mateIn3 sacrifice"\]/);
    assert.doesNotMatch(puzzle.game.pgn(), /Qxf1|Rg1/);
    assert.equal(new Puzzle(blackPuzzle, 'legacy', player).game.pgnTags.Themes, undefined);
    assert.equal(new Puzzle(blackPuzzle, 'empty', player, 1000, []).game.pgnTags.Themes, undefined);
});

test('puzzles reject malformed theme metadata with a visible puzzle error', () => {
    for (const value of ['null', '"mateIn2"', '[2]', '["<img>"]', '[""]']) {
        assert.throws(() => new Puzzle(blackPuzzle, 'bad-themes', player, 1000, JSON.parse(value)), PgnError);
    }
    assert.throws(() => new Puzzle(blackPuzzle, 'too-many', player, 1000, Array(101).fill('fork')), PgnError);
});

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

test('Lichess PGN starts after the setup move and retains source attribution without exposing the solution', () => {
    const puzzle = new Puzzle(`[Site "https://lichess.org/training/00sHx"]
[Result "*"]
[SetUp "1"]
[FEN "q5nr/1ppknQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 w - - 1 18"]

18. Be6+ Kd8 19. Qf8# *`, 'lichess', player);
    assert.equal(puzzle.game.turn, 'w');
    assert.equal(puzzle.game.plies.length, 0);
    assert.equal(puzzle.game.pgnTags.Event, 'Lichess random puzzle');
    assert.equal(puzzle.game.pgnTags.Site, 'https://lichess.org/training/00sHx');
    assert.doesNotMatch(puzzle.game.pgn(), /Be6|Qf8/);
    assert.equal(puzzle.play('a2e6'), true);
    assert.deepEqual(puzzle.game.plies.map(p => p.uci), ['a2e6', 'd7d8']);
    assert.equal(puzzle.play('f7f8'), true);
    assert.equal(puzzle.game.reason, 'puzzle solved');
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

test('puzzle type options are unique Lichess theme tags with an "any" default', () => {
    assert.equal(PUZZLE_TYPES[0].value, '');
    assert.equal(new Set(PUZZLE_TYPES.map((t) => t.value)).size, PUZZLE_TYPES.length);
    for (const t of PUZZLE_TYPES.slice(1)) assert.match(t.value, /^[a-z][A-Za-z0-9]*$/);
    for (const value of ['', 'mateIn2', 'mateIn3', 'oneMove']) assert.equal(validPuzzleType(value), true);
    for (const value of ['mateInTwo', 'mate-in-2', undefined, null, 2]) assert.equal(validPuzzleType(value), false);
});
