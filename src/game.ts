/* Game record: position, move history and chess clock for live games and imported PGN reviews. */
import { Chess, START_FEN, type Color, type GameResult, type PieceType, type Status } from './engine.ts';
import type { Clock, PlayerRef } from './net.ts';

export type GameKind = 'computer' | 'network' | 'tournament' | 'imported' | 'puzzle';

export interface PlyRecord {
    uci: string;
    san: string;
    from: string;
    to: string;
    color: Color;
    captured: PieceType | null;
    fen: string;
    check: boolean;
    clock: Clock | null;
    comments?: string[];
}

export interface GameInit {
    id: string;
    kind: GameKind;
    white: PlayerRef;
    black: PlayerRef;
    /** Initial time per side in ms; 0 means untimed. */
    tc: number;
    startTs: number;
    tourId?: string | null;
    cid?: string | null;
    level?: number;
    learnerMode?: boolean;
    pgnTags?: Record<string, string>;
    startFen?: string;
}

export const NETWORK_TC_MS = 5 * 60 * 1000;
/** Extra time granted to a silent opponent before their flag is claimed (network latency). */
export const FLAG_GRACE_MS = 2500;

export function opposite(c: Color): Color { return c === 'w' ? 'b' : 'w'; }

export function describeResult(result: GameResult | null, reason: string | null): string {
    if (!result) return '';
    const winner = result === '1-0' ? 'White is victorious' : result === '0-1' ? 'Black is victorious' : 'Draw';
    const why = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : '';
    if (result === '1/2-1/2') return why ? `${why} • Draw` : 'Draw';
    return why ? `${why} • ${winner}` : winner;
}

export class GameRecord {
    readonly id: string;
    readonly kind: GameKind;
    readonly white: PlayerRef;
    readonly black: PlayerRef;
    readonly tc: number;
    readonly startTs: number;
    readonly tourId: string | null;
    readonly cid: string | null;
    readonly level: number;
    readonly learnerMode: boolean;
    readonly pgnTags: Readonly<Record<string, string>>;
    readonly chess: Chess;
    readonly startFen: string;
    plies: PlyRecord[] = [];
    initialComments: string[] = [];
    clock: Clock;
    turnStart: number;
    over = false;
    result: GameResult | null = null;
    reason: string | null = null;
    endTs: number | null = null;
    /** Address of the player currently offering a draw. */
    drawOffer: string | null = null;
    /** Out-of-order moves waiting for missing plies. */
    pending = new Map<number, { from: string; uci: string; clock: Clock; at: number }>();
    pendingEnd: { from: string; result: GameResult; reason: string; at: number; replay: boolean } | null = null;
    lastSyncRequest = 0;

    constructor(init: GameInit) {
        this.id = init.id;
        this.kind = init.kind;
        this.white = init.white;
        this.black = init.black;
        this.tc = init.tc;
        this.startTs = init.startTs;
        this.tourId = init.tourId || null;
        this.cid = init.cid || null;
        this.level = init.level || 0;
        this.learnerMode = init.kind === 'computer' && init.learnerMode === true;
        this.pgnTags = { ...init.pgnTags };
        this.chess = new Chess(init.startFen);
        this.startFen = this.chess.fen();
        this.clock = { w: init.tc, b: init.tc };
        this.turnStart = init.startTs;
    }

    get timed(): boolean { return this.tc > 0; }
    get turn(): Color { return this.chess.turnColor(); }

    colorOf(addr: string): Color | null {
        if (addr === this.white.addr) return 'w';
        if (addr === this.black.addr) return 'b';
        return null;
    }

    player(color: Color): PlayerRef { return color === 'w' ? this.white : this.black; }

    /** Remaining clock time (ms) for a side at time `now`. */
    remaining(color: Color, now: number): number {
        if (!this.timed) return Infinity;
        const running = !this.over && this.turn === color;
        return this.clock[color] - (running ? Math.max(0, now - this.turnStart) : 0);
    }

    /** Clock values to publish right after `color` moves at `now`. */
    clockAfterMove(color: Color, now: number): Clock {
        const c = { ...this.clock };
        if (this.timed) c[color] = Math.max(0, this.remaining(color, now));
        return c;
    }

    /** Applies a UCI move. `at` is when the opponent's clock starts running. */
    applyMove(uci: string, clock: Clock | null, at: number, historical = false): PlyRecord | null {
        if (this.over) return null;
        const color = this.turn;
        if (this.timed && clock && (!Number.isFinite(clock.w) || !Number.isFinite(clock.b) || clock.w < 0 || clock.b < 0)) return null;
        const mv = this.chess.move(uci);
        if (!mv) return null;
        if (this.timed) {
            // Live clocks use local elapsed time; replay only restores the mover's bounded clock.
            this.clock[color] = historical && clock
                ? Math.min(this.clock[color], clock[color])
                : Math.max(0, this.clock[color] - Math.max(0, at - this.turnStart));
        }
        this.turnStart = historical ? Math.min(at, Date.now()) : at;
        this.drawOffer = null;
        const rec: PlyRecord = {
            uci: mv.uci, san: mv.san, from: mv.from, to: mv.to, color: mv.color,
            captured: mv.captured, fen: this.chess.fen(), check: mv.san.endsWith('+') || mv.san.endsWith('#'),
            clock: this.timed ? { ...this.clock } : null
        };
        this.plies.push(rec);
        return rec;
    }

    /** Removes the last `n` plies (computer games only). */
    takeBack(n: number): void {
        const keep = this.plies.slice(0, Math.max(0, this.plies.length - n)).map((p) => p.uci);
        this.chess.load(this.startFen);
        this.plies = [];
        this.over = false; this.result = null; this.reason = null; this.endTs = null;
        for (const uci of keep) this.applyMove(uci, null, Date.now());
    }

    status(): Status { return this.chess.status(); }

    end(result: GameResult, reason: string, now: number): boolean {
        if (this.over) return false;
        if (this.timed) {
            const side = this.turn;
            this.clock[side] = Math.max(0, this.remaining(side, now));
        }
        this.over = true;
        this.result = result;
        this.reason = reason;
        this.endTs = now;
        this.drawOffer = null;
        this.pending.clear();
        this.pendingEnd = null;
        return true;
    }

    /** Result when `color` runs out of time (draw if the opponent cannot mate). */
    timeoutResult(color: Color): GameResult {
        const winner = opposite(color);
        if (!this.chess.hasMatingMaterial(winner)) return '1/2-1/2';
        return winner === 'w' ? '1-0' : '0-1';
    }

    fenAt(ply: number): string {
        if (ply <= 0) return this.startFen;
        return this.plies[Math.min(ply, this.plies.length) - 1].fen;
    }

    commentsAt(ply: number): readonly string[] {
        if (ply <= 0) return this.initialComments;
        return this.plies[Math.min(ply, this.plies.length) - 1]?.comments ?? [];
    }

    /** Opponent pieces captured by `color` up to ply (exclusive end index). */
    capturedBy(color: Color, upto = this.plies.length): Record<PieceType, number> {
        const counts: Record<PieceType, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
        for (const p of this.plies.slice(0, upto)) if (p.color === color && p.captured) counts[p.captured]++;
        return counts;
    }

    moveNumberAt(ply: number): number {
        const fields = this.startFen.split(' ');
        return Number(fields[5]) + Math.floor((ply + (fields[1] === 'b' ? 1 : 0)) / 2);
    }

    pgn(): string {
        const date = new Date(this.startTs);
        const pad = (n: number): string => String(n).padStart(2, '0');
        const headers: [string, string][] = [
            ['Event', this.kind === 'tournament' ? 'Arena tournament' : this.kind === 'computer' ? 'Game vs computer' : this.kind === 'imported' ? 'Imported game' : 'Casual game'],
            ['Site', 'webxdc'],
            ['Date', `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`],
            ['White', this.white.name],
            ['Black', this.black.name],
            ['Result', this.result || '*'],
            ['TimeControl', this.timed ? `${this.tc / 1000}+0` : '-']
        ];
        if (this.reason) headers.push(['Termination', this.reason]);
        const formatComments = (comments: readonly string[]): string => comments.map(
            comment => comment.includes('}') ? `; ${comment}\n` : `{${comment}} `
        ).join('');
        let moves = formatComments(this.initialComments);
        this.plies.forEach((p, i) => {
            if (p.color === 'w') moves += `${this.moveNumberAt(i)}. `;
            else if (i === 0) moves += `${this.moveNumberAt(i)}... `;
            moves += p.san + ' ';
            moves += formatComments(p.comments ?? []);
        });
        const tags = new Map(headers);
        for (const [key, value] of Object.entries(this.pgnTags)) tags.set(key, value);
        if (this.startFen !== START_FEN) {
            tags.set('SetUp', '1');
            tags.set('FEN', this.startFen);
        }
        tags.set('Result', this.result || '*');
        const escapeTag = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
        return [...tags].map(([k, v]) => `[${k} "${escapeTag(v)}"]`).join('\n') + '\n\n' + moves + (this.result || '*') + '\n';
    }
}
