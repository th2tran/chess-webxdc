/* Chess rules engine: 0x88 board, legal move generation, SAN, FEN, game-end detection. */

export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;
export const BLACK_BIT = 8;

export const FLAG_CAPTURE = 1, FLAG_EP = 2, FLAG_CASTLE_K = 4, FLAG_CASTLE_Q = 8, FLAG_DOUBLE = 16, FLAG_PROMO = 32;
const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const KNIGHT_OFFSETS = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_OFFSETS = [17, 15, -17, -15];
const ROOK_OFFSETS = [16, -16, 1, -1];
const KING_OFFSETS = [17, 15, -17, -15, 16, -16, 1, -1];

const PIECE_CHARS = ' pnbrqk';
const FILES = 'abcdefgh';

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece { type: PieceType; color: Color; }
export type GameResult = '1-0' | '0-1' | '1/2-1/2';

/** Internal move representation (0x88 squares, numeric piece codes). */
export interface Move {
    from: number;
    to: number;
    piece: number;
    captured: number;
    promo: number;
    flags: number;
    order?: number;
}

export interface PublicMove {
    from: string;
    to: string;
    piece: PieceType;
    color: Color;
    captured: PieceType | null;
    promotion: PieceType | null;
    flags: number;
    uci: string;
    san: string;
}

export interface MoveInput { from: string; to: string; promotion?: string | null; }

export interface Status {
    over: boolean;
    check: boolean;
    result: GameResult | null;
    reason: string | null;
}

interface HistoryEntry {
    move: Move | null;
    castling: number;
    ep: number;
    halfmove: number;
    fullmove: number;
    hashLo: number;
    hashHi: number;
}

// Castling rights kept when a piece moves from/to a square.
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~CASTLE_WQ;
CASTLE_MASK[0x07] = 15 & ~CASTLE_WK;
CASTLE_MASK[0x04] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[0x70] = 15 & ~CASTLE_BQ;
CASTLE_MASK[0x77] = 15 & ~CASTLE_BK;
CASTLE_MASK[0x74] = 15 & ~(CASTLE_BK | CASTLE_BQ);

// Deterministic Zobrist keys (two 32-bit halves).
let seed = 0x9e3779b9;
function rand32(): number {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed | 0;
}
const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = rand32(); Z_PIECE_HI[i] = rand32(); }
const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rand32(); Z_CASTLE_HI[i] = rand32(); }
const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rand32(); Z_EP_HI[i] = rand32(); }
const Z_SIDE_LO = rand32(), Z_SIDE_HI = rand32();

export function sqName(sq: number): string { return FILES[sq & 7] + ((sq >> 4) + 1); }
export function sqIndex(name: string): number {
    if (typeof name !== 'string' || name.length !== 2) return -1;
    const f = FILES.indexOf(name[0]);
    const r = name.charCodeAt(1) - 49;
    if (f < 0 || r < 0 || r > 7) return -1;
    return r * 16 + f;
}
export function colorOf(p: number): number { return p >> 3; }
export function typeOf(p: number): number { return p & 7; }
function typeChar(p: number): PieceType { return PIECE_CHARS[typeOf(p)] as PieceType; }

export class Chess {
    board = new Int8Array(128);
    turn = WHITE;
    castling = 0;
    ep = -1;
    halfmove = 0;
    fullmove = 1;
    kings: [number, number] = [-1, -1];
    history: HistoryEntry[] = [];
    hashLo = 0;
    hashHi = 0;
    startFen = START_FEN;

    constructor(fen?: string) {
        this.load(fen || START_FEN);
    }

    private clear(): void {
        this.board.fill(0);
        this.turn = WHITE;
        this.castling = 0;
        this.ep = -1;
        this.halfmove = 0;
        this.fullmove = 1;
        this.kings = [-1, -1];
        this.history = [];
        this.hashLo = 0;
        this.hashHi = 0;
    }

    load(fen: string): void {
        const parts = String(fen).trim().split(/\s+/);
        if (parts.length < 4) throw new Error('Invalid FEN: ' + fen);
        this.clear();
        const rows = parts[0].split('/');
        if (rows.length !== 8) throw new Error('Invalid FEN board: ' + fen);
        for (let i = 0; i < 8; i++) {
            const rank = 7 - i;
            let file = 0;
            for (const ch of rows[i]) {
                if (ch >= '1' && ch <= '8') { file += +ch; continue; }
                const lower = ch.toLowerCase();
                const type = PIECE_CHARS.indexOf(lower);
                if (type <= 0 || file > 7) throw new Error('Invalid FEN piece: ' + fen);
                const color = ch === lower ? BLACK : WHITE;
                this.put(rank * 16 + file, type | (color ? BLACK_BIT : 0));
                file++;
            }
            if (file !== 8) throw new Error('Invalid FEN rank: ' + fen);
        }
        this.turn = parts[1] === 'b' ? BLACK : WHITE;
        if (parts[2].includes('K')) this.castling |= CASTLE_WK;
        if (parts[2].includes('Q')) this.castling |= CASTLE_WQ;
        if (parts[2].includes('k')) this.castling |= CASTLE_BK;
        if (parts[2].includes('q')) this.castling |= CASTLE_BQ;
        this.ep = parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : -1;
        this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
        this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
        this.startFen = this.fen();
        this.recomputeHash();
    }

    private put(sq: number, piece: number): void {
        this.board[sq] = piece;
        if (typeOf(piece) === KING) this.kings[colorOf(piece)] = sq;
    }

    private recomputeHash(): void {
        let lo = 0, hi = 0;
        for (let sq = 0; sq < 128; sq++) {
            if (sq & 0x88) { sq += 7; continue; }
            const p = this.board[sq];
            if (p) { lo ^= Z_PIECE_LO[p * 128 + sq]; hi ^= Z_PIECE_HI[p * 128 + sq]; }
        }
        lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
        if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
        if (this.turn === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
        this.hashLo = lo; this.hashHi = hi;
    }

    fen(): string {
        let out = '';
        for (let rank = 7; rank >= 0; rank--) {
            let empty = 0;
            for (let file = 0; file < 8; file++) {
                const p = this.board[rank * 16 + file];
                if (!p) { empty++; continue; }
                if (empty) { out += empty; empty = 0; }
                const ch = PIECE_CHARS[typeOf(p)];
                out += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
            }
            if (empty) out += empty;
            if (rank) out += '/';
        }
        let c = '';
        if (this.castling & CASTLE_WK) c += 'K';
        if (this.castling & CASTLE_WQ) c += 'Q';
        if (this.castling & CASTLE_BK) c += 'k';
        if (this.castling & CASTLE_BQ) c += 'q';
        return `${out} ${this.turn === WHITE ? 'w' : 'b'} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.halfmove} ${this.fullmove}`;
    }

    isAttacked(sq: number, by: number): boolean {
        const b = this.board;
        const bb = by ? BLACK_BIT : 0;
        if (by === WHITE) {
            let s = sq - 15; if (!(s & 0x88) && b[s] === PAWN) return true;
            s = sq - 17; if (!(s & 0x88) && b[s] === PAWN) return true;
        } else {
            let s = sq + 15; if (!(s & 0x88) && b[s] === (PAWN | BLACK_BIT)) return true;
            s = sq + 17; if (!(s & 0x88) && b[s] === (PAWN | BLACK_BIT)) return true;
        }
        for (let i = 0; i < 8; i++) {
            const s = sq + KNIGHT_OFFSETS[i];
            if (!(s & 0x88) && b[s] === (KNIGHT | bb)) return true;
        }
        for (let i = 0; i < 8; i++) {
            const s = sq + KING_OFFSETS[i];
            if (!(s & 0x88) && b[s] === (KING | bb)) return true;
        }
        for (let i = 0; i < 4; i++) {
            const d = BISHOP_OFFSETS[i];
            let s = sq + d;
            while (!(s & 0x88)) {
                const p = b[s];
                if (p) {
                    if (p === (BISHOP | bb) || p === (QUEEN | bb)) return true;
                    break;
                }
                s += d;
            }
        }
        for (let i = 0; i < 4; i++) {
            const d = ROOK_OFFSETS[i];
            let s = sq + d;
            while (!(s & 0x88)) {
                const p = b[s];
                if (p) {
                    if (p === (ROOK | bb) || p === (QUEEN | bb)) return true;
                    break;
                }
                s += d;
            }
        }
        return false;
    }

    inCheck(color: number = this.turn): boolean {
        return this.kings[color] >= 0 && this.isAttacked(this.kings[color], color ^ 1);
    }

    /** Pseudo-legal moves for the side to move (capturesOnly also includes quiet promotions). */
    pseudoMoves(capturesOnly: boolean): Move[] {
        const moves: Move[] = [];
        const b = this.board;
        const us = this.turn, them = us ^ 1;
        const forward = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;

        const add = (from: number, to: number, piece: number, captured: number, flags: number): void => {
            if (typeOf(piece) === PAWN && (to >> 4) === promoRank) {
                for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
                    moves.push({ from, to, piece, captured, promo: promo | (us ? BLACK_BIT : 0), flags: flags | FLAG_PROMO });
                }
            } else {
                moves.push({ from, to, piece, captured, promo: 0, flags });
            }
        };

        for (let from = 0; from < 128; from++) {
            if (from & 0x88) { from += 7; continue; }
            const piece = b[from];
            if (!piece || colorOf(piece) !== us) continue;
            const type = typeOf(piece);
            if (type === PAWN) {
                const one = from + forward;
                if (!(one & 0x88) && !b[one]) {
                    if (!capturesOnly || (one >> 4) === promoRank) add(from, one, piece, 0, 0);
                    const two = one + forward;
                    if (!capturesOnly && (from >> 4) === startRank && !b[two]) add(from, two, piece, 0, FLAG_DOUBLE);
                }
                for (let side = -1; side <= 1; side += 2) {
                    const to = one + side;
                    if (to & 0x88) continue;
                    const target = b[to];
                    if (target && colorOf(target) === them) add(from, to, piece, target, FLAG_CAPTURE);
                    else if (to === this.ep) add(from, to, piece, PAWN | (them ? BLACK_BIT : 0), FLAG_CAPTURE | FLAG_EP);
                }
            } else {
                const offsets = type === KNIGHT ? KNIGHT_OFFSETS : type === BISHOP ? BISHOP_OFFSETS
                    : type === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
                const slides = type === BISHOP || type === ROOK || type === QUEEN;
                for (let i = 0; i < offsets.length; i++) {
                    const d = offsets[i];
                    let to = from + d;
                    while (!(to & 0x88)) {
                        const target = b[to];
                        if (target) {
                            if (colorOf(target) === them) add(from, to, piece, target, FLAG_CAPTURE);
                            break;
                        }
                        if (!capturesOnly) add(from, to, piece, 0, 0);
                        if (!slides) break;
                        to += d;
                    }
                }
                if (type === KING && !capturesOnly) {
                    const kingSide = us === WHITE ? CASTLE_WK : CASTLE_BK;
                    const queenSide = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
                    const home = us === WHITE ? 0x04 : 0x74;
                    const rook = ROOK | (us ? BLACK_BIT : 0);
                    if (from === home && (this.castling & (kingSide | queenSide)) && !this.isAttacked(from, them)) {
                        if ((this.castling & kingSide) && !b[from + 1] && !b[from + 2] && b[from + 3] === rook
                            && !this.isAttacked(from + 1, them) && !this.isAttacked(from + 2, them)) {
                            add(from, from + 2, piece, 0, FLAG_CASTLE_K);
                        }
                        if ((this.castling & queenSide) && !b[from - 1] && !b[from - 2] && !b[from - 3] && b[from - 4] === rook
                            && !this.isAttacked(from - 1, them) && !this.isAttacked(from - 2, them)) {
                            add(from, from - 2, piece, 0, FLAG_CASTLE_Q);
                        }
                    }
                }
            }
        }
        return moves;
    }

    private xorPiece(piece: number, sq: number): void {
        this.hashLo ^= Z_PIECE_LO[piece * 128 + sq];
        this.hashHi ^= Z_PIECE_HI[piece * 128 + sq];
    }

    /** Applies a move. Returns false (and reverts) if it leaves the mover's king in check. */
    makeMove(m: Move): boolean {
        const b = this.board;
        const us = this.turn;
        this.history.push({
            move: m, castling: this.castling, ep: this.ep, halfmove: this.halfmove,
            fullmove: this.fullmove, hashLo: this.hashLo, hashHi: this.hashHi
        });

        this.hashLo ^= Z_CASTLE_LO[this.castling]; this.hashHi ^= Z_CASTLE_HI[this.castling];
        if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }

        if (m.flags & FLAG_EP) {
            const capSq = m.to + (us === WHITE ? -16 : 16);
            this.xorPiece(b[capSq], capSq);
            b[capSq] = 0;
        } else if (m.captured) {
            this.xorPiece(m.captured, m.to);
        }
        this.xorPiece(m.piece, m.from);
        b[m.from] = 0;
        const placed = m.promo || m.piece;
        b[m.to] = placed;
        this.xorPiece(placed, m.to);
        if (typeOf(m.piece) === KING) this.kings[us] = m.to;

        if (m.flags & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
            const rookFrom = m.flags & FLAG_CASTLE_K ? m.to + 1 : m.to - 2;
            const rookTo = m.flags & FLAG_CASTLE_K ? m.to - 1 : m.to + 1;
            const rook = b[rookFrom];
            b[rookFrom] = 0; b[rookTo] = rook;
            this.xorPiece(rook, rookFrom); this.xorPiece(rook, rookTo);
        }

        this.castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
        this.ep = m.flags & FLAG_DOUBLE ? m.from + (us === WHITE ? 16 : -16) : -1;
        this.halfmove = typeOf(m.piece) === PAWN || m.captured ? 0 : this.halfmove + 1;
        if (us === BLACK) this.fullmove++;
        this.turn = us ^ 1;

        this.hashLo ^= Z_CASTLE_LO[this.castling]; this.hashHi ^= Z_CASTLE_HI[this.castling];
        if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }
        this.hashLo ^= Z_SIDE_LO; this.hashHi ^= Z_SIDE_HI;

        if (this.isAttacked(this.kings[us], us ^ 1)) {
            this.undoMove();
            return false;
        }
        return true;
    }

    undoMove(): Move | null {
        const h = this.history.pop();
        if (!h || !h.move) return null;
        const m = h.move;
        const b = this.board;
        const us = this.turn ^ 1;
        this.turn = us;
        this.castling = h.castling; this.ep = h.ep; this.halfmove = h.halfmove; this.fullmove = h.fullmove;
        this.hashLo = h.hashLo; this.hashHi = h.hashHi;

        b[m.from] = m.piece;
        if (m.flags & FLAG_EP) {
            b[m.to] = 0;
            b[m.to + (us === WHITE ? -16 : 16)] = m.captured;
        } else {
            b[m.to] = m.captured || 0;
        }
        if (typeOf(m.piece) === KING) this.kings[us] = m.from;
        if (m.flags & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
            const rookFrom = m.flags & FLAG_CASTLE_K ? m.to + 1 : m.to - 2;
            const rookTo = m.flags & FLAG_CASTLE_K ? m.to - 1 : m.to + 1;
            b[rookFrom] = b[rookTo]; b[rookTo] = 0;
        }
        return m;
    }

    /** Null move (side to move passes); used by the search. */
    makeNullMove(): void {
        this.history.push({ move: null, castling: this.castling, ep: this.ep, halfmove: this.halfmove,
            fullmove: this.fullmove, hashLo: this.hashLo, hashHi: this.hashHi });
        if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }
        this.ep = -1;
        this.turn ^= 1;
        this.hashLo ^= Z_SIDE_LO; this.hashHi ^= Z_SIDE_HI;
    }

    undoNullMove(): void {
        const h = this.history.pop()!;
        this.turn ^= 1;
        this.castling = h.castling; this.ep = h.ep; this.halfmove = h.halfmove; this.fullmove = h.fullmove;
        this.hashLo = h.hashLo; this.hashHi = h.hashHi;
    }

    legalMoves(): Move[] {
        const out: Move[] = [];
        for (const m of this.pseudoMoves(false)) {
            if (this.makeMove(m)) { this.undoMove(); out.push(m); }
        }
        return out;
    }

    perft(depth: number): number {
        if (depth === 0) return 1;
        let n = 0;
        for (const m of this.pseudoMoves(false)) {
            if (!this.makeMove(m)) continue;
            n += depth === 1 ? 1 : this.perft(depth - 1);
            this.undoMove();
        }
        return n;
    }

    toUci(m: Move): string {
        return sqName(m.from) + sqName(m.to) + (m.promo ? PIECE_CHARS[typeOf(m.promo)] : '');
    }

    toSan(m: Move, legal: Move[] = this.legalMoves()): string {
        let san: string;
        if (m.flags & FLAG_CASTLE_K) san = 'O-O';
        else if (m.flags & FLAG_CASTLE_Q) san = 'O-O-O';
        else {
            const type = typeOf(m.piece);
            const capture = !!(m.flags & FLAG_CAPTURE);
            if (type === PAWN) {
                san = (capture ? FILES[m.from & 7] + 'x' : '') + sqName(m.to);
                if (m.promo) san += '=' + PIECE_CHARS[typeOf(m.promo)].toUpperCase();
            } else {
                let disambig = '';
                const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
                if (rivals.length) {
                    const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
                    const sameRank = rivals.some((o) => (o.from >> 4) === (m.from >> 4));
                    if (!sameFile) disambig = FILES[m.from & 7];
                    else if (!sameRank) disambig = String((m.from >> 4) + 1);
                    else disambig = sqName(m.from);
                }
                san = PIECE_CHARS[type].toUpperCase() + disambig + (capture ? 'x' : '') + sqName(m.to);
            }
        }
        this.makeMove(m);
        if (this.inCheck()) san += this.legalMoves().length ? '+' : '#';
        this.undoMove();
        return san;
    }

    private publicMove(m: Move, legal: Move[]): PublicMove {
        return {
            from: sqName(m.from), to: sqName(m.to),
            piece: typeChar(m.piece),
            color: colorOf(m.piece) === WHITE ? 'w' : 'b',
            captured: m.captured ? typeChar(m.captured) : null,
            promotion: m.promo ? typeChar(m.promo) : null,
            flags: m.flags,
            uci: this.toUci(m),
            san: this.toSan(m, legal)
        };
    }

    /** Legal destinations from a square (e.g. 'e2'), without SAN for speed. */
    movesFrom(square?: string): { from: string; to: string; promotion: PieceType | null; uci: string }[] {
        const from = square ? sqIndex(square) : -1;
        return this.legalMoves().filter((m) => from < 0 || m.from === from).map((m) => ({
            from: sqName(m.from), to: sqName(m.to), promotion: m.promo ? typeChar(m.promo) : null, uci: this.toUci(m)
        }));
    }

    private findMove(input: string | MoveInput): { move: Move; legal: Move[] } | null {
        const legal = this.legalMoves();
        let target: MoveInput;
        if (typeof input === 'string') {
            const s = input.trim();
            const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(s);
            if (!uci) {
                const clean = (x: string): string => x.replace(/[+#?!]/g, '').replace(/0/g, 'O');
                const found = legal.find((m) => clean(this.toSan(m, legal)) === clean(s));
                return found ? { move: found, legal } : null;
            }
            target = { from: uci[1], to: uci[2], promotion: uci[3] };
        } else {
            target = input;
        }
        const from = sqIndex(target.from), to = sqIndex(target.to);
        const promoType = target.promotion ? PIECE_CHARS.indexOf(String(target.promotion).toLowerCase()) : QUEEN;
        const found = legal.find((m) => m.from === from && m.to === to && (!m.promo || typeOf(m.promo) === promoType));
        return found ? { move: found, legal } : null;
    }

    /** Plays a move given as SAN, UCI, or {from,to,promotion}. Returns the move or null if illegal. */
    move(input: string | MoveInput): PublicMove | null {
        const res = this.findMove(input);
        if (!res) return null;
        const pub = this.publicMove(res.move, res.legal);
        this.makeMove(res.move);
        return pub;
    }

    get(square: string): Piece | null {
        const p = this.board[sqIndex(square)];
        if (!p) return null;
        return { type: typeChar(p), color: colorOf(p) === WHITE ? 'w' : 'b' };
    }

    turnColor(): Color { return this.turn === WHITE ? 'w' : 'b'; }

    repetitionCount(): number {
        let count = 1;
        const h = this.history;
        for (let i = h.length - 1, reversible = this.halfmove; i >= 0 && reversible > 0; i--, reversible--) {
            if (h[i].hashLo === this.hashLo && h[i].hashHi === this.hashHi) count++;
        }
        return count;
    }

    insufficientMaterial(): boolean {
        const minors: { t: number; sq: number }[] = [];
        for (let sq = 0; sq < 128; sq++) {
            if (sq & 0x88) { sq += 7; continue; }
            const p = this.board[sq];
            if (!p) continue;
            const t = typeOf(p);
            if (t === KING) continue;
            if (t === PAWN || t === ROOK || t === QUEEN) return false;
            minors.push({ t, sq });
        }
        if (minors.length <= 1) return true;
        if (minors.every((m) => m.t === BISHOP)) {
            const shade = (sq: number): number => ((sq >> 4) + (sq & 7)) & 1;
            return minors.every((m) => shade(m.sq) === shade(minors[0].sq));
        }
        return false;
    }

    status(): Status {
        const check = this.inCheck();
        if (this.legalMoves().length === 0) {
            if (check) return { over: true, check, result: this.turn === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
            return { over: true, check, result: '1/2-1/2', reason: 'stalemate' };
        }
        if (this.insufficientMaterial()) return { over: true, check, result: '1/2-1/2', reason: 'insufficient material' };
        if (this.halfmove >= 100) return { over: true, check, result: '1/2-1/2', reason: '50-move rule' };
        if (this.repetitionCount() >= 3) return { over: true, check, result: '1/2-1/2', reason: 'threefold repetition' };
        return { over: false, check, result: null, reason: null };
    }

    /** True if `color` could still possibly deliver mate (timeout adjudication). */
    hasMatingMaterial(color: Color): boolean {
        const c = color === 'b' ? BLACK : WHITE;
        let minors = 0;
        for (let sq = 0; sq < 128; sq++) {
            if (sq & 0x88) { sq += 7; continue; }
            const p = this.board[sq];
            if (!p || colorOf(p) !== c) continue;
            const t = typeOf(p);
            if (t === PAWN || t === ROOK || t === QUEEN) return true;
            if (t === KNIGHT || t === BISHOP) minors++;
        }
        return minors >= 2;
    }

    kingSquare(color: Color): string | null {
        const k = this.kings[color === 'b' ? BLACK : WHITE];
        return k >= 0 ? sqName(k) : null;
    }
}
