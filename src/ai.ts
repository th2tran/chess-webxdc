/* Chess AI: iterative-deepening negamax alpha-beta with quiescence, transposition table and PSTs. */
import {
    Chess, type Move, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, FLAG_CAPTURE, FLAG_PROMO
} from './engine.ts';

const VALUE = [0, 100, 320, 330, 500, 900, 0];
const MATE = 100000;
const INF = 1000000;

// Piece-square tables from white's view; index = row * 8 + file with row 0 = rank 8.
const PST: Record<number, number[]> = {
    [PAWN]: [
        0, 0, 0, 0, 0, 0, 0, 0,
        50, 50, 50, 50, 50, 50, 50, 50,
        10, 10, 20, 30, 30, 20, 10, 10,
        5, 5, 10, 25, 25, 10, 5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, -5, -10, 0, 0, -10, -5, 5,
        5, 10, 10, -20, -20, 10, 10, 5,
        0, 0, 0, 0, 0, 0, 0, 0],
    [KNIGHT]: [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50],
    [BISHOP]: [
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -20, -10, -10, -10, -10, -10, -10, -20],
    [ROOK]: [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, 10, 10, 10, 10, 5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        0, 0, 0, 5, 5, 0, 0, 0],
    [QUEEN]: [
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -5, 0, 5, 5, 5, 5, 0, -5,
        0, 0, 5, 5, 5, 5, 0, -5,
        -10, 5, 5, 5, 5, 5, 0, -10,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20],
    [KING]: [
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        20, 20, 0, 0, 0, 0, 20, 20,
        20, 30, 10, 0, 0, 10, 30, 20]
};
const KING_END = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50];

function pstIndex(sq: number, color: number): number {
    const rank = sq >> 4, file = sq & 7;
    return color === WHITE ? (7 - rank) * 8 + file : rank * 8 + file;
}

/** Static evaluation in centipawns from the side-to-move's perspective. */
export function evaluate(c: Chess): number {
    const b = c.board;
    let nonPawn = 0;
    for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const t = b[sq] & 7;
        if (t && t !== PAWN && t !== KING) nonPawn += VALUE[t];
    }
    const endgame = nonPawn <= 1300;
    let score = 0, bishopsW = 0, bishopsB = 0;
    for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = b[sq];
        if (!p) continue;
        const t = p & 7, color = p >> 3;
        const idx = pstIndex(sq, color);
        const v = VALUE[t] + (t === KING && endgame ? KING_END[idx] : PST[t][idx]);
        if (t === BISHOP) { if (color === WHITE) bishopsW++; else bishopsB++; }
        score += color === WHITE ? v : -v;
    }
    if (bishopsW >= 2) score += 30;
    if (bishopsB >= 2) score -= 30;
    return c.turn === WHITE ? score : -score;
}

const TT_SIZE = 1 << 18, TT_MASK = TT_SIZE - 1;
const EXACT = 1, LOWER = 2, UPPER = 3;

export interface SearchOptions { maxDepth?: number; timeMs?: number; noise?: number; }
export interface SearchResult { move: Move; score: number; depth: number; }

export class Searcher {
    private ttKey = new Int32Array(TT_SIZE);
    private ttDepth = new Int8Array(TT_SIZE);
    private ttFlag = new Int8Array(TT_SIZE);
    private ttScore = new Int32Array(TT_SIZE);
    private ttMove = new Int32Array(TT_SIZE);
    private historyTable = new Int32Array(16 * 128);
    private killers: number[][] = [];
    private nodes = 0;
    private deadline = 0;
    private aborted = false;
    private rootBest: Move | null = null;
    private rootScore = 0;
    private rootImproved = false;

    private encode(m: Move): number { return m.from | (m.to << 7) | ((m.promo & 7) << 14) | (1 << 20); }

    private orderMoves(moves: Move[], ttMove: number, ply: number): void {
        const killers = this.killers[ply] || [];
        for (const m of moves) {
            const code = this.encode(m);
            let s: number;
            if (code === ttMove) s = 1e7;
            else if (m.flags & FLAG_CAPTURE) s = 1e6 + VALUE[m.captured & 7] * 10 - VALUE[m.piece & 7] / 10;
            else if (m.flags & FLAG_PROMO) s = 9e5 + VALUE[m.promo & 7];
            else if (killers[0] === code) s = 8e5;
            else if (killers[1] === code) s = 7e5;
            else s = this.historyTable[m.piece * 128 + m.to];
            m.order = s;
        }
        moves.sort((a, b) => (b.order || 0) - (a.order || 0));
    }

    private timeUp(): boolean {
        if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.aborted = true;
        return this.aborted;
    }

    private isRepetition(c: Chess): boolean {
        const h = c.history;
        for (let i = h.length - 2, r = c.halfmove - 1; i >= 0 && r > 0; i -= 2, r -= 2) {
            if (h[i].hashLo === c.hashLo && h[i].hashHi === c.hashHi) return true;
        }
        return false;
    }

    private quiesce(c: Chess, alpha: number, beta: number, ply: number): number {
        if (this.timeUp()) return 0;
        const stand = evaluate(c);
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
        if (ply > 40) return stand;
        const moves = c.pseudoMoves(true);
        this.orderMoves(moves, 0, ply);
        for (const m of moves) {
            if (!(m.flags & FLAG_PROMO) && stand + VALUE[m.captured & 7] + 200 < alpha) continue;
            if (!c.makeMove(m)) continue;
            const score = -this.quiesce(c, -beta, -alpha, ply + 1);
            c.undoMove();
            if (this.aborted) return 0;
            if (score >= beta) return score;
            if (score > alpha) alpha = score;
        }
        return alpha;
    }

    private hasPieces(c: Chess): boolean {
        for (let sq = 0; sq < 128; sq++) {
            if (sq & 0x88) { sq += 7; continue; }
            const p = c.board[sq];
            if (p && (p >> 3) === c.turn && (p & 7) !== PAWN && (p & 7) !== KING) return true;
        }
        return false;
    }

    private negamax(c: Chess, depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
        if (ply > 0 && (c.halfmove >= 100 || this.isRepetition(c))) return 0;
        const inCheck = c.inCheck();
        if (inCheck) depth++;
        if (depth <= 0) return this.quiesce(c, alpha, beta, ply);
        if (this.timeUp()) return 0;

        const idx = c.hashLo & TT_MASK;
        let ttMove = 0;
        if (this.ttKey[idx] === c.hashHi && this.ttMove[idx]) {
            ttMove = this.ttMove[idx];
            if (ply > 0 && this.ttDepth[idx] >= depth) {
                const s = this.ttScore[idx], f = this.ttFlag[idx];
                const adj = s > MATE - 1000 ? s - ply : s < -MATE + 1000 ? s + ply : s;
                if (f === EXACT || (f === LOWER && adj >= beta) || (f === UPPER && adj <= alpha)) return adj;
            }
        }

        if (allowNull && !inCheck && depth >= 3 && ply > 0 && beta < MATE - 1000 && this.hasPieces(c) && evaluate(c) >= beta) {
            c.makeNullMove();
            const score = -this.negamax(c, depth - 3, -beta, -beta + 1, ply + 1, false);
            c.undoNullMove();
            if (this.aborted) return 0;
            if (score >= beta) return beta;
        }

        const moves = c.pseudoMoves(false);
        this.orderMoves(moves, ttMove, ply);
        const origAlpha = alpha;
        let best = -INF, bestMove: Move | null = null, legal = 0;
        for (const m of moves) {
            if (!c.makeMove(m)) continue;
            legal++;
            let score: number;
            if (legal === 1) score = -this.negamax(c, depth - 1, -beta, -alpha, ply + 1, true);
            else {
                // Late move reduction for quiet moves, then PVS re-search if it looks better.
                const reduce = depth >= 3 && legal > 4 && !inCheck && !(m.flags & (FLAG_CAPTURE | FLAG_PROMO)) ? 1 : 0;
                score = -this.negamax(c, depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
                if (score > alpha && !this.aborted) score = -this.negamax(c, depth - 1, -beta, -alpha, ply + 1, true);
            }
            c.undoMove();
            if (this.aborted) return 0;
            if (score > best) {
                best = score; bestMove = m;
                if (ply === 0) { this.rootBest = m; this.rootScore = score; this.rootImproved = legal > 1; }
            }
            if (score > alpha) alpha = score;
            if (alpha >= beta) {
                if (!(m.flags & FLAG_CAPTURE)) {
                    const code = this.encode(m);
                    const k = this.killers[ply] || (this.killers[ply] = [0, 0]);
                    if (k[0] !== code) { k[1] = k[0]; k[0] = code; }
                    this.historyTable[m.piece * 128 + m.to] += depth * depth;
                }
                break;
            }
        }
        if (!legal) return inCheck ? -MATE + ply : 0;

        this.ttKey[idx] = c.hashHi;
        this.ttDepth[idx] = depth;
        this.ttScore[idx] = best > MATE - 1000 ? best + ply : best < -MATE + 1000 ? best - ply : best;
        this.ttFlag[idx] = best <= origAlpha ? UPPER : best >= beta ? LOWER : EXACT;
        this.ttMove[idx] = bestMove ? this.encode(bestMove) : 0;
        return best;
    }

    search(c: Chess, opts: SearchOptions): SearchResult | null {
        const maxDepth = opts.maxDepth || 64;
        this.deadline = Date.now() + (opts.timeMs || 1000);
        this.nodes = 0;
        this.aborted = false;
        this.killers = [];
        this.historyTable.fill(0);
        const legal = c.legalMoves();
        if (!legal.length) return null;
        if (legal.length === 1) return { move: legal[0], score: 0, depth: 0 };
        if (opts.noise) return this.noisySearch(c, legal, Math.min(maxDepth, 3), opts.noise);

        let result: SearchResult = { move: legal[0], score: 0, depth: 0 };
        for (let depth = 1; depth <= maxDepth; depth++) {
            this.rootBest = null;
            this.rootImproved = false;
            const score = this.negamax(c, depth, -INF, INF, 0, false);
            if (this.aborted) {
                // A partially searched iteration is only trusted if it found a better move than the previous best.
                if (this.rootBest && this.rootImproved) result = { move: this.rootBest, score: this.rootScore, depth };
                break;
            }
            if (this.rootBest) result = { move: this.rootBest, score, depth };
            if (Math.abs(score) > MATE - 100) break;
        }
        return result;
    }

    /** Weaker play: score every root move with a full window and add random noise. */
    private noisySearch(c: Chess, legal: Move[], depth: number, noise: number): SearchResult {
        this.deadline = Date.now() + 5000;
        let best: SearchResult | null = null;
        for (const m of legal) {
            c.makeMove(m);
            const score = -this.negamax(c, depth - 1, -INF, INF, 1, false) + (Math.random() * 2 - 1) * noise;
            c.undoMove();
            if (!best || score > best.score) best = { move: m, score, depth };
        }
        return best!;
    }
}

export const LEVELS: Record<number, SearchOptions> = {
    1: { maxDepth: 1, noise: 180 },
    2: { maxDepth: 2, noise: 70 },
    3: { maxDepth: 3, timeMs: 700 },
    4: { maxDepth: 6, timeMs: 1500 },
    5: { maxDepth: 64, timeMs: 3000 }
};

export const LEVEL_NAMES: Record<number, string> = {
    1: 'Beginner', 2: 'Casual', 3: 'Intermediate', 4: 'Advanced', 5: 'Expert'
};

let shared: Searcher | null = null;

/** Best move in UCI notation at the given level (1-5), or null if there is no legal move. */
export function bestMove(chess: Chess, level: number): { uci: string; score: number; depth: number } | null {
    shared = shared || new Searcher();
    const res = shared.search(chess, LEVELS[level] || LEVELS[3]);
    return res ? { uci: chess.toUci(res.move), score: res.score, depth: res.depth } : null;
}
