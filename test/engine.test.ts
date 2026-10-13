import test from 'node:test';
import assert from 'node:assert';
import { Chess, START_FEN } from '../src/engine.ts';

const PERFT: [string, number[]][] = [
    [START_FEN, [20, 400, 8902, 197281]],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]]
];

test('perft node counts match reference values', () => {
    for (const [fen, counts] of PERFT) {
        const c = new Chess(fen);
        counts.forEach((expected, i) => assert.strictEqual(c.perft(i + 1), expected, `${fen} depth ${i + 1}`));
        assert.strictEqual(c.fen(), new Chess(fen).fen(), 'position restored after perft');
    }
});

test('SAN generation, checkmate detection and FEN round trip', () => {
    const c = new Chess();
    for (const san of ['f3', 'e5', 'g4']) assert.ok(c.move(san), san);
    assert.strictEqual(c.move('Qh4')!.san, 'Qh4#');
    assert.deepStrictEqual(c.status(), { over: true, check: true, result: '0-1', reason: 'checkmate' });
    assert.strictEqual(new Chess(c.fen()).fen(), c.fen());
});

test('castling, en passant, promotion and disambiguation', () => {
    let c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    assert.strictEqual(c.move('e1g1')!.san, 'O-O');
    assert.strictEqual(c.move('O-O-O')!.san, 'O-O-O');
    assert.ok(c.fen().startsWith('2kr3r/8/8/8/8/8/8/R4RK1'));

    c = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    assert.strictEqual(c.move('exd6')!.san, 'exd6');
    assert.strictEqual(c.get('d5'), null);

    c = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    assert.strictEqual(c.move({ from: 'a7', to: 'a8', promotion: 'n' })!.san, 'a8=N');
    assert.deepStrictEqual(c.get('a8'), { type: 'n', color: 'w' });

    c = new Chess('k7/8/8/8/8/8/8/KN3N2 w - - 0 1');
    assert.strictEqual(c.move('b1d2')!.san, 'Nbd2');
});

test('draw detection: stalemate, insufficient material, threefold', () => {
    assert.strictEqual(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').status().reason, 'stalemate');
    assert.strictEqual(new Chess('8/8/4k3/8/8/3BK3/8/8 w - - 0 1').status().reason, 'insufficient material');
    const c = new Chess();
    for (let i = 0; i < 2; i++) for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) c.move(m);
    assert.strictEqual(c.status().reason, 'threefold repetition');
    assert.strictEqual(new Chess('8/8/4k3/8/8/3NK3/8/8 w - - 0 1').hasMatingMaterial('w'), false);
});
