import test from 'node:test';
import assert from 'node:assert';
import { Chess } from '../src/engine.ts';
import { bestMove } from '../src/ai.ts';

test('AI finds mate in one', () => {
    const c = new Chess('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    assert.strictEqual(bestMove(c, 3)!.uci, 'd1d8');
});

test('AI wins a hanging queen and plays legal moves at every level', () => {
    const c = new Chess('rnb1kbnr/pppp1ppp/8/4p1q1/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    assert.strictEqual(bestMove(c, 4)!.uci, 'c1g5');
    for (const level of [1, 2, 3, 4, 5]) {
        const start = new Chess();
        const res = bestMove(start, level)!;
        assert.ok(start.move(res.uci), `level ${level} move ${res.uci} is legal`);
    }
});
