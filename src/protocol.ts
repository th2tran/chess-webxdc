import { GameRecord, FLAG_GRACE_MS, opposite } from './game.ts';
import type { GameResult } from './engine.ts';
import type { Clock, MessageOf } from './net.ts';

export const MAX_PENDING_MOVES = 64;
export const COMPLETED_GAME_LIMIT = 100;

export function validClock(clock: Clock): boolean {
    return !!clock && Number.isFinite(clock.w) && Number.isFinite(clock.b) && clock.w >= 0 && clock.b >= 0;
}

export function canMove(g: GameRecord, from: string, ply: number): boolean {
    return Number.isSafeInteger(ply) && ply >= 0 && g.colorOf(from) === (ply % 2 === 0 ? 'w' : 'b');
}

export function canEndGame(g: GameRecord, from: string, result: GameResult, reason: string, at: number): boolean {
    const color = g.colorOf(from);
    if (!color || !['1-0', '0-1', '1/2-1/2'].includes(result)) return false;
    if (reason === 'resignation') return result === (color === 'w' ? '0-1' : '1-0');
    if (reason === 'agreement') return result === '1/2-1/2' && !!g.drawOffer && g.drawOffer !== from;
    if (reason === 'aborted') return result === '1/2-1/2' && g.plies.length === 0;
    if (reason === 'time out') {
        return g.timed && g.remaining(g.turn, at) <= (g.turn === color ? 0 : -FLAG_GRACE_MS)
            && result === g.timeoutResult(g.turn);
    }
    const status = g.status();
    return status.over && status.result === result && status.reason === reason;
}

/** Validate the complete history before appending anything to a live game. */
export function validSync(g: GameRecord, msg: MessageOf<'gsync'>, viewer: string): boolean {
    if (!g.colorOf(msg.from) || !Array.isArray(msg.moves) || msg.moves.length < g.plies.length || msg.moves.length > 2048) return false;
    const probe = new GameRecord({
        id: g.id, kind: g.kind, white: g.white, black: g.black, tc: g.tc, startTs: g.startTs
    });
    for (let i = 0; i < msg.moves.length; i++) {
        const move = msg.moves[i];
        if (!move || typeof move.uci !== 'string' || !validClock(move.clock)) return false;
        if (i < g.plies.length && move.uci !== g.plies[i].uci) return false;
        // A remote sync may not invent moves for this device's player.
        if (i >= g.plies.length && probe.player(probe.turn).addr === viewer && msg.from !== viewer) {
            const pending = g.pending.get(i);
            if (!pending || pending.from !== viewer || pending.uci !== move.uci) return false;
        }
        if (!probe.applyMove(move.uci, move.clock, g.startTs, true)) return false;
        if (i < msg.moves.length - 1 && probe.status().over) return false;
    }
    return true;
}

export function syncClock(g: GameRecord, ply: number, received: Clock, viewer: string): Clock {
    const pending = g.pending.get(ply);
    return pending?.from === viewer ? pending.clock : received;
}

export function pruneCompletedGames(games: Map<string, GameRecord>, displayed: GameRecord | null): void {
    const completed = [...games.values()].filter((g) => g.over)
        .sort((a, b) => (b.endTs ?? b.startTs) - (a.endTs ?? a.startTs));
    for (const g of completed.slice(COMPLETED_GAME_LIMIT)) {
        if (g !== displayed) games.delete(g.id);
    }
}

export function canDeclineDraw(g: GameRecord, from: string): boolean {
    const offered = g.drawOffer ? g.colorOf(g.drawOffer) : null;
    return !!offered && g.colorOf(from) === opposite(offered);
}
