/* Arena tournament logic (pure functions, no I/O).
 * The tournament state is a plain JSON object replicated between peers. Only the host (state.host)
 * mutates it; every mutation bumps state.rev so peers can keep the newest copy. */
import type { GameResult } from './engine.ts';

export const DEFAULT_DURATION_MS = 60 * 60 * 1000;
export const REST_MS = 6000;               // pause after a game before a player is paired again
export const MAX_GAME_MS = 12 * 60 * 1000; // a 5+0 game can never legitimately last longer than ~10 minutes

export type TournamentStatus = 'running' | 'finishing' | 'finished';
export type Outcome = 'W' | 'D' | 'L';

export interface TPlayer {
    addr: string;
    name: string;
    joinedTs: number;
    withdrawn: boolean;
    score: number;
    wins: number;
    draws: number;
    losses: number;
    streak: number;
    results: Outcome[];
    whites: number;
    blacks: number;
    lastOpp: string | null;
    currentGame: string | null;
    lastFreeTs: number;
}

export interface TGame {
    id: string;
    white: string;
    black: string;
    result: GameResult | null;
    reason: string | null;
    startTs: number;
    endTs: number | null;
}

export interface TournamentState {
    id: string;
    host: string;
    createdBy: string;
    name: string;
    startTs: number;
    durationMs: number;
    status: TournamentStatus;
    rev: number;
    players: Record<string, TPlayer>;
    games: Record<string, TGame>;
}

export interface Standing extends TPlayer { rank: number; onFire: boolean; }

export function create(opts: { id: string; host: string; hostName: string; now: number; durationMs?: number }): TournamentState {
    const t: TournamentState = {
        id: opts.id, host: opts.host, createdBy: opts.host, name: `${opts.hostName || 'Someone'}'s Arena`,
        startTs: opts.now, durationMs: opts.durationMs || DEFAULT_DURATION_MS,
        status: 'running', rev: 1, players: {}, games: {}
    };
    addPlayer(t, opts.host, opts.hostName, opts.now);
    t.rev = 1;
    return t;
}

export function endTs(t: TournamentState): number { return t.startTs + t.durationMs; }

export function addPlayer(t: TournamentState, addr: string, name: string, now: number): boolean {
    if (!addr || t.status === 'finished') return false;
    const p = t.players[addr];
    if (p) {
        let changed = false;
        if (p.withdrawn) { p.withdrawn = false; p.lastFreeTs = now; changed = true; }
        if (name && p.name !== name) { p.name = name; changed = true; }
        if (changed) t.rev++;
        return changed;
    }
    t.players[addr] = {
        addr, name: name || addr, joinedTs: now, withdrawn: false,
        score: 0, wins: 0, draws: 0, losses: 0, streak: 0, results: [],
        whites: 0, blacks: 0, lastOpp: null, currentGame: null, lastFreeTs: now - REST_MS
    };
    t.rev++;
    return true;
}

export function withdraw(t: TournamentState, addr: string): boolean {
    const p = t.players[addr];
    if (!p || p.withdrawn) return false;
    p.withdrawn = true;
    t.rev++;
    return true;
}

export function startGame(t: TournamentState, gameId: string, white: string, black: string, now: number): boolean {
    const w = t.players[white], b = t.players[black];
    if (!w || !b || t.games[gameId]) return false;
    t.games[gameId] = { id: gameId, white, black, result: null, reason: null, startTs: now, endTs: null };
    w.currentGame = gameId; b.currentGame = gameId;
    w.whites++; b.blacks++;
    w.lastOpp = black; b.lastOpp = white;
    t.rev++;
    return true;
}

function score(p: TPlayer, outcome: Outcome): void {
    // Lichess-style arena: 2 per win, 1 per draw; on a streak (2+ wins in a row) points are doubled.
    const onFire = p.streak >= 2;
    if (outcome === 'W') { p.wins++; p.score += onFire ? 4 : 2; p.streak++; }
    else if (outcome === 'D') { p.draws++; p.score += onFire ? 2 : 1; p.streak = 0; }
    else { p.losses++; p.streak = 0; }
    p.results.push(outcome);
}

export function applyResult(t: TournamentState, gameId: string, result: GameResult, reason: string | null, now: number): boolean {
    const g = t.games[gameId];
    if (!g || g.result) return false;
    g.result = result; g.reason = reason || null; g.endTs = now;
    const w = t.players[g.white], b = t.players[g.black];
    const wOut: Outcome = result === '1-0' ? 'W' : result === '0-1' ? 'L' : 'D';
    const bOut: Outcome = wOut === 'W' ? 'L' : wOut === 'L' ? 'W' : 'D';
    if (w) { score(w, wOut); if (w.currentGame === gameId) w.currentGame = null; w.lastFreeTs = now; }
    if (b) { score(b, bOut); if (b.currentGame === gameId) b.currentGame = null; b.lastFreeTs = now; }
    t.rev++;
    return true;
}

/** Ends games that are impossibly old (both players vanished) so the tournament can finish. */
export function adjudicateStale(t: TournamentState, now: number): boolean {
    let changed = false;
    for (const g of Object.values(t.games)) {
        if (!g.result && now - g.startTs > MAX_GAME_MS) changed = applyResult(t, g.id, '1/2-1/2', 'abandoned', now) || changed;
    }
    return changed;
}

export function ongoingGames(t: TournamentState): TGame[] { return Object.values(t.games).filter((g) => !g.result); }

/** Advances the lifecycle, including early completion when no further match is possible. */
export function updateStatus(t: TournamentState, now: number, online?: Set<string>): boolean {
    const before = t.status;
    if (t.status === 'running' && now >= endTs(t)) t.status = 'finishing';
    if (t.status === 'running' && online && Object.keys(t.games).length > 0
        && ongoingGames(t).length === 0
        && Object.values(t.players).filter(p => !p.withdrawn && online.has(p.addr)).length < 2) {
        t.status = 'finished';
    }
    if (t.status === 'finishing' && ongoingGames(t).length === 0) t.status = 'finished';
    if (t.status !== before) { t.rev++; return true; }
    return false;
}

/** Pairs idle players. `online` is the set of reachable addrs (null = everyone). */
export function pairings(t: TournamentState, now: number, online: Set<string> | null): { white: string; black: string }[] {
    if (t.status !== 'running' || now >= endTs(t)) return [];
    const isOnline = (addr: string): boolean => !online || online.has(addr);
    const free = Object.values(t.players).filter((p) => !p.withdrawn && !p.currentGame
        && isOnline(p.addr) && now - p.lastFreeTs >= REST_MS);
    free.sort((a, b) => b.score - a.score || a.addr.localeCompare(b.addr));
    const pairs: { white: string; black: string }[] = [];
    while (free.length >= 2) {
        const a = free.shift()!;
        // Prefer the closest-ranked opponent that is not the previous opponent.
        let idx = free.findIndex((p) => p.addr !== a.lastOpp && a.addr !== p.lastOpp);
        if (idx < 0) {
            // Only an immediate rematch is possible; wait if someone else may become free soon.
            const busy = Object.values(t.players).some((p) => !p.withdrawn && p.currentGame && isOnline(p.addr));
            if (busy) break;
            idx = 0;
        }
        const b = free.splice(idx, 1)[0];
        const balA = a.whites - a.blacks, balB = b.whites - b.blacks;
        const aWhite = balA < balB || (balA === balB && a.addr < b.addr);
        pairs.push(aWhite ? { white: a.addr, black: b.addr } : { white: b.addr, black: a.addr });
    }
    return pairs;
}

export function standings(t: TournamentState): Standing[] {
    const played = (p: TPlayer): number => p.wins + p.draws + p.losses;
    const list = Object.values(t.players).slice().sort((a, b) =>
        b.score - a.score || b.wins - a.wins || played(a) - played(b) || a.name.localeCompare(b.name));
    let rank = 0;
    let prev: TPlayer | null = null;
    return list.map((p, i) => {
        if (!prev || prev.score !== p.score || prev.wins !== p.wins) rank = i + 1;
        prev = p;
        return { ...p, rank, onFire: p.streak >= 2 };
    });
}

/** Chooses which copy of a tournament state to keep. */
export function pickNewer(local: TournamentState | null, incoming: TournamentState | null): TournamentState | null {
    if (!incoming) return local;
    if (!local) return incoming;
    if (local.id !== incoming.id) {
        // An unfinished tournament beats a finished one; two concurrently created ones converge on the
        // earliest; among finished ones the most recent is kept.
        if (isActive(local) !== isActive(incoming)) return isActive(incoming) ? incoming : local;
        if (incoming.startTs !== local.startTs) {
            const incomingEarlier = incoming.startTs < local.startTs;
            return isActive(incoming) === incomingEarlier ? incoming : local;
        }
        return incoming.id < local.id ? incoming : local;
    }
    if (incoming.rev > local.rev) return incoming;
    if (incoming.rev === local.rev && incoming.host < local.host) return incoming;
    return local;
}

export function isActive(t: TournamentState | null): boolean { return !!t && t.status !== 'finished'; }

export function isValidState(t: unknown): t is TournamentState {
    const x = t as TournamentState;
    return !!x && typeof x.id === 'string' && typeof x.host === 'string' && typeof x.createdBy === 'string'
        && typeof x.name === 'string' && Number.isSafeInteger(x.rev) && x.rev >= 1
        && Number.isFinite(x.startTs) && Number.isFinite(x.durationMs) && x.durationMs > 0
        && ['running', 'finishing', 'finished'].includes(x.status)
        && !!x.players && typeof x.players === 'object' && !Array.isArray(x.players)
        && !!x.games && typeof x.games === 'object' && !Array.isArray(x.games)
        && Object.prototype.hasOwnProperty.call(x.players, x.host)
        && Object.prototype.hasOwnProperty.call(x.players, x.createdBy)
        && Object.entries(x.players).every(([addr, p]) => !!p && p.addr === addr && typeof p.name === 'string'
            && typeof p.withdrawn === 'boolean' && Array.isArray(p.results) && p.results.every((r) => ['W', 'D', 'L'].includes(r))
            && Number.isFinite(p.joinedTs) && Number.isFinite(p.lastFreeTs)
            && (p.currentGame === null || typeof p.currentGame === 'string') && (p.lastOpp === null || typeof p.lastOpp === 'string')
            && [p.score, p.wins, p.draws, p.losses, p.streak, p.whites, p.blacks].every((n) => Number.isSafeInteger(n) && n >= 0))
        && Object.entries(x.games).every(([id, g]) => !!g && g.id === id
            && Object.prototype.hasOwnProperty.call(x.players, g.white) && Object.prototype.hasOwnProperty.call(x.players, g.black)
            && g.white !== g.black && [null, '1-0', '0-1', '1/2-1/2'].includes(g.result)
            && (g.reason === null || typeof g.reason === 'string') && Number.isFinite(g.startTs)
            && (g.endTs === null || Number.isFinite(g.endTs)));
}

/** Payload identities are self-declared; this checks authority, not authentication. */
export function canPublishState(
    local: TournamentState | null, incoming: TournamentState, from: string, online: Set<string> | null
): boolean {
    if (from !== incoming.host) return false;
    if (!local || local.id !== incoming.id) return true;
    if (incoming.createdBy !== local.createdBy || incoming.startTs !== local.startTs || incoming.durationMs !== local.durationMs) return false;
    if (incoming.host === local.host) return true;
    if (!isActive(local) || incoming.rev <= local.rev) return false;
    const candidate = Object.prototype.hasOwnProperty.call(local.players, from) ? local.players[from] : null;
    if (!candidate || candidate.withdrawn) return false;
    // Historical updates cannot reconstruct realtime presence, but the successor must be an existing member.
    if (!online) return true;
    if (online.has(local.host)) return false;
    const candidates = Object.values(local.players).filter((p) => !p.withdrawn && online.has(p.addr))
        .map((p) => p.addr).sort();
    return candidates[0] === from;
}

export function clone<T>(t: T): T { return JSON.parse(JSON.stringify(t)) as T; }
