import test from 'node:test';
import assert from 'node:assert/strict';
import { hintArrowPath } from '../src/board.ts';

test('hint arrows end at the destination square in both board orientations', () => {
    assert.match(hintArrowPath('e2', 'e4', 'w'), /L 4.5 4.5 L/);
    assert.match(hintArrowPath('e2', 'e4', 'b'), /L 3.5 3.5 L/);
    assert.match(hintArrowPath('g1', 'f3', 'w'), /L 5.5 5.5 L/);
    assert.match(hintArrowPath('g1', 'f3', 'b'), /L 2.5 2.5 L/);
    assert.match(hintArrowPath('a7', 'a8', 'w'), /L 0.5 0.5 L/);
    assert.match(hintArrowPath('e1', 'g1', 'b'), /L 1.5 0.5 L/);
});

test('hint arrows form closed shapes without invalid coordinates', () => {
    for (const [from, to] of [['e2', 'e4'], ['g1', 'f3'], ['e1', 'g1'], ['a7', 'a8'], ['h8', 'a1']]) {
        for (const orientation of ['w', 'b'] as const) {
            const path = hintArrowPath(from, to, orientation);
            assert.match(path, /^M .* Z$/);
            assert.doesNotMatch(path, /NaN|Infinity/);
        }
    }
    assert.equal(hintArrowPath('e2', 'e2', 'w'), '');
});
