import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, START_FEN } from '../src/engine.ts';
import { GameRecord } from '../src/game.ts';
import { importPgn } from '../src/pgn.ts';

test('computer games from imported positions support either side moving first, replay and takeback', () => {
    for (const color of ['w', 'b'] as const) {
        const fen = `6k1/8/8/8/8/8/5Q2/1B4K1 ${color} - - 0 23`;
        const imported = importPgn(`[SetUp "1"]\n[FEN "${fen}"]\n*`, 'imported');
        const me = { addr: 'me', name: 'Player' };
        const ai = { addr: 'ai', name: 'Computer' };
        const init = {
            id: 'computer', kind: 'computer' as const, tc: 0, startTs: 1000, level: 4,
            startFen: imported.fenAt(0),
            white: color === 'w' ? me : ai, black: color === 'b' ? me : ai
        };
        const g = new GameRecord(init);
        assert.equal(g.turn, g.colorOf(me.addr));
        assert.equal(g.over, false);
        assert.equal(g.plies.length, 0);
        assert.equal(g.level, 4);
        const moves = color === 'w' ? ['f2f3', 'g8h8'] : ['g8h8', 'f2f3'];
        for (const move of moves) assert.ok(g.applyMove(move, null, 1000));
        assert.equal(g.plies[0].color, color);
        const saved = JSON.parse(JSON.stringify({ ...init, moves: g.plies.map(p => p.uci) }));
        const restored = new GameRecord(saved);
        for (const move of saved.moves) assert.ok(restored.applyMove(move, null, 1000));
        assert.equal(restored.chess.fen(), g.chess.fen());
        assert.equal(importPgn(g.pgn(), 'round-trip').startFen, fen);
        restored.takeBack(2);
        assert.equal(restored.chess.fen(), fen);
        assert.equal(restored.turn, color);
        assert.equal(restored.plies.length, 0);
        assert.equal(imported.chess.fen(), fen, 'the source record remains unchanged');
    }
});

test('a computer continuation starts at the selected review ply rather than the final position', () => {
    const imported = importPgn('1. e4 e5 2. Nf3 *', 'imported');
    const startFen = imported.fenAt(1);
    const g = new GameRecord({
        id: 'computer', kind: 'computer', tc: 0, startTs: 1000, startFen,
        white: { addr: 'ai', name: 'Computer' }, black: { addr: 'me', name: 'Player' }
    });
    assert.notEqual(startFen, imported.chess.fen());
    assert.equal(g.turn, 'b');
    assert.equal(g.plies.length, 0);
    assert.ok(g.applyMove('c7c5', null, 1000));
    assert.equal(g.plies[0].san, 'c5');
    assert.match(g.pgn(), /1\.\.\. c5 \*/);
    assert.equal(imported.plies.length, 3);
});

test('computer games without a starting FEN remain standard-start games', () => {
    const g = new GameRecord({
        id: 'old-save', kind: 'computer', tc: 0, startTs: 1000,
        white: { addr: 'me', name: 'Player' }, black: { addr: 'ai', name: 'Computer' }
    });
    assert.equal(g.startFen, START_FEN);
    assert.ok(g.applyMove('e2e4', null, 1000));
    assert.equal(g.chess.fen(), new Chess(g.fenAt(1)).fen());
});
