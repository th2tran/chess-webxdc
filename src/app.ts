/* Main application: game modes, peer presence, challenges, tournaments and rendering. */
import { Chess, type Color, type GameResult, type PieceType } from './engine.ts';
import { fallbackMove, LEVEL_NAMES } from './ai.ts';
import { BoardView, type BoardState, type BoardHint } from './board.ts';
import { GameRecord, NETWORK_TC_MS, FLAG_GRACE_MS, describeResult, opposite } from './game.ts';
import { Net, randomId, type Message, type MessageOf, type PeerStatus, type PlayerRef, type ReceiveContext } from './net.ts';
import * as T from './tournament.ts';
import { pieceUrl } from './pieces.ts';
import { $, esc, formatClock, formatDuration, loadJson, Modals, saveJson, Sounds, timeAgo, toast } from './ui.ts';
import type { AiRequest, AiResponse } from './ai-worker.ts';
import { canMove, canEndGame, canDeclineDraw, canForfeitOnExit, exitForfeitResult, validClock, validSync, syncClock, pruneCompletedGames, MAX_PENDING_MOVES } from './protocol.ts';
import { importPgn, PgnError } from './pgn.ts';
import { canRequestHint, describeHint, matchesCoachAvailability, matchesHintResponse, waitForCoachHint } from './learner.ts';
import { ChatHistory } from './chat.ts';
import { PUZZLE_TYPES, Puzzle, matchesPuzzleResponse, puzzleContinuation, puzzleThemeLabel, validPuzzleType } from './puzzles.ts';

type Mode = 'computer' | 'network' | 'tournament' | 'puzzles';
type Tab = 'peers' | 'chat' | 'standings';

interface Peer {
    addr: string;
    name: string;
    status: PeerStatus;
    gameId: string | null;
    tourId: string | null;
    opp: string | null;
    lastSeen: number;
}

interface Challenge {
    cid: string;
    from: string;
    fromName: string;
    to: string;
    toName: string;
    color: Color | 'random';
    ts: number;
    state: 'pending' | 'accepted' | 'declined' | 'cancelled';
}

interface SavedComputerGame {
    id: string;
    myColor: Color;
    level: number;
    startTs: number;
    moves: string[];
    result: GameResult | null;
    reason: string | null;
    learnerMode?: boolean;
    startFen?: string;
}

interface Prefs { muted: boolean; level: number; color: Color | 'random'; mode: Mode; learnerMode: boolean; tournamentMinutes: number; puzzleType: string; }

const CHALLENGE_TTL_MS = 60000;
const SYNC_RETRY_MS = 5000;
const AI_ADDR = 'computer@local';
const STORAGE_PREFS = 'chess-xdc:prefs';
const STORAGE_COMPUTER = 'chess-xdc:computer-game';
const STORAGE_DISMISSED_TOUR = 'chess-xdc:dismissed-tour';

const net = new Net();
const me: PlayerRef = net.me;
const sounds = new Sounds();
const modals = new Modals($('#modal-root'));
const appStart = Date.now();
const chat = new ChatHistory();

const prefs: Prefs = { muted: false, level: 3, color: 'random', mode: 'computer', learnerMode: false, tournamentMinutes: 60, puzzleType: '', ...loadJson<Partial<Prefs>>(STORAGE_PREFS, {}) };
if (!T.validDurationMinutes(prefs.tournamentMinutes)) prefs.tournamentMinutes = 60;
if (!validPuzzleType(prefs.puzzleType)) prefs.puzzleType = '';
sounds.muted = prefs.muted;

const S = {
    mode: prefs.mode === 'puzzles' ? 'computer' : prefs.mode as Mode,
    tab: 'peers' as Tab,
    game: null as GameRecord | null,
    viewPly: null as number | null,
    flipped: false,
    games: new Map<string, GameRecord>(),
    peers: new Map<string, Peer>(),
    challenges: new Map<string, Challenge>(),
    outgoing: null as string | null,
    unreadChat: 0,
    tour: null as T.TournamentState | null,
    tourDirty: false,
    lastTourBroadcast: 0,
    joiningTour: null as string | null,
    lastJoinSent: 0,
    lastPresence: 0,
    lastPresenceKey: '',
    aiThinking: false,
    aiRequestId: 0,
    lastLowTimeBeep: 0
};

// ---------------------------------------------------------------- helpers

function now(): number { return Date.now(); }

function peerTimeout(): number { return net.hasRealtime ? 12000 : 75000; }

function isOnline(addr: string): boolean {
    if (addr === me.addr) return true;
    const p = S.peers.get(addr);
    return !!p && now() - p.lastSeen < peerTimeout();
}

function onlinePeers(): Peer[] {
    return [...S.peers.values()].filter((p) => isOnline(p.addr)).sort((a, b) => a.name.localeCompare(b.name));
}

function onlineSet(): Set<string> {
    return new Set([me.addr, ...onlinePeers().map((p) => p.addr)]);
}

function myColorIn(g: GameRecord | null): Color | null {
    if (!g) return null;
    if (g.kind === 'imported') return null;
    if (g.kind === 'computer') return g.white.addr === me.addr ? 'w' : 'b';
    return g.colorOf(me.addr);
}

function myActiveNetworkGame(): GameRecord | null {
    for (const g of S.games.values()) {
        if (!g.over && g.colorOf(me.addr)) return g;
    }
    return null;
}

function inActiveTournament(): boolean {
    const t = S.tour;
    return !!t && T.isActive(t) && !!t.players[me.addr] && !t.players[me.addr].withdrawn;
}

function isBusy(): boolean { return !!myActiveNetworkGame() || inActiveTournament(); }

function myStatus(): PeerStatus {
    if (myActiveNetworkGame()) return 'playing';
    if (inActiveTournament()) return 'tournament';
    if ((S.game?.kind === 'computer' || S.game?.kind === 'puzzle') && !S.game.over) return 'computer';
    return 'idle';
}

function savePrefs(): void { saveJson(STORAGE_PREFS, prefs); }

let renderQueued = false;
function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    const run = (): void => {
        if (!renderQueued) return;
        renderQueued = false;
        render();
    };
    // requestAnimationFrame is paused in hidden pages; the timeout keeps state visible on return.
    requestAnimationFrame(run);
    setTimeout(run, 100);
}

// ---------------------------------------------------------------- presence

function sendPresence(force = false): void {
    if (!net.available || net.replaying) return;
    const status = myStatus();
    const active = myActiveNetworkGame();
    const opp = active ? active.player(opposite(active.colorOf(me.addr)!)).name : null;
    const key = `${status}|${active?.id || ''}|${S.tour?.id || ''}`;
    const interval = net.hasRealtime ? 4000 : 30000;
    if (!force && key === S.lastPresenceKey && now() - S.lastPresence < interval) return;
    S.lastPresence = now();
    S.lastPresenceKey = key;
    net.send({ type: 'presence', status, gameId: active?.id || null, tourId: inActiveTournament() ? S.tour!.id : null, opp });
}

function touchPeer(addr: string, name: string, ts: number): Peer {
    let p = S.peers.get(addr);
    if (!p) {
        p = { addr, name, status: 'idle', gameId: null, tourId: null, opp: null, lastSeen: ts };
        S.peers.set(addr, p);
    }
    p.name = name || p.name;
    p.lastSeen = Math.max(p.lastSeen, ts);
    return p;
}

// ---------------------------------------------------------------- message handling

function handleMessage(msg: Message, ctx: ReceiveContext): void {
    if (msg.type === 'coach-probe') return;
    if (msg.type === 'coach-available') {
        if (!ctx.local && !ctx.replay) onCoachAvailable(msg);
        return;
    }
    if (msg.type === 'hint-request') return;
    if (msg.type === 'puzzle-request') return;
    if (msg.type === 'puzzle-response') {
        if (!ctx.local && !ctx.replay) onPuzzleResponse(msg);
        return;
    }
    if (msg.type === 'hint-response') {
        if (!ctx.local && !ctx.replay) onHintResponse(msg);
        return;
    }
    if (!ctx.local && !ctx.replay && msg.from !== me.addr) {
        const wasOnline = isOnline(msg.from);
        touchPeer(msg.from, msg.name, now());
        if (!wasOnline && msg.type !== 'bye') scheduleRender();
    }
    switch (msg.type) {
        case 'hello': onHello(msg, ctx); break;
        case 'presence': onPresence(msg, ctx); break;
        case 'bye': onBye(msg, ctx); break;
        case 'chat': onChat(msg, ctx); break;
        case 'challenge': onChallenge(msg, ctx); break;
        case 'challenge-cancel': onChallengeCancel(msg, ctx); break;
        case 'challenge-decline': onChallengeDecline(msg, ctx); break;
        case 'gstart': onGameStart(msg, ctx); break;
        case 'move': onMove(msg, ctx); break;
        case 'gend': onGameEnd(msg, ctx); break;
        case 'draw-offer': onDrawOffer(msg, ctx); break;
        case 'draw-decline': onDrawDecline(msg, ctx); break;
        case 'gsync-req': onSyncRequest(msg, ctx); break;
        case 'gsync': onSync(msg, ctx); break;
        case 'tstate': onTournamentState(msg, ctx); break;
        case 'tjoin': onTournamentJoin(msg, ctx); break;
        case 'tleave': onTournamentLeave(msg, ctx); break;
    }
}

function onBye(msg: MessageOf<'bye'>, ctx: ReceiveContext): void {
    if (ctx.local || ctx.replay) return;
    S.peers.delete(msg.from);
    const g = typeof msg.gameId === 'string' ? S.games.get(msg.gameId) : undefined;
    if (g && canForfeitOnExit(g, msg, ctx.replay, now())) {
        finishGame(g, exitForfeitResult(g, msg.from)!, 'forfeit', { announce: false });
    }
    scheduleRender();
}

function onHello(msg: MessageOf<'hello'>, ctx: ReceiveContext): void {
    if (ctx.local || ctx.replay) return;
    sendPresence(true);
    if (S.tour && S.tour.host === me.addr && T.isActive(S.tour)) broadcastTour(false);
    void msg;
}

function onPresence(msg: MessageOf<'presence'>, ctx: ReceiveContext): void {
    if (ctx.local || msg.from === me.addr) return;
    if (ctx.replay && now() - msg.ts > peerTimeout()) return;
    const p = touchPeer(msg.from, msg.name, ctx.replay ? msg.ts : now());
    p.status = msg.status;
    p.gameId = msg.gameId;
    p.tourId = msg.tourId;
    p.opp = msg.opp;
    scheduleRender();
}

function onChat(msg: MessageOf<'chat'>, ctx: ReceiveContext): void {
    const text = String(msg.text || '').slice(0, 300).trim();
    if (!text) return;
    if (!chat.add({ id: msg.id, from: msg.from, name: msg.name, text, ts: msg.ts })) return;
    if (!ctx.local && !ctx.replay && S.tab !== 'chat') {
        S.unreadChat++;
        sounds.play('notify');
    }
    scheduleRender();
}

// ---------------------------------------------------------------- challenges

function onChallenge(msg: MessageOf<'challenge'>, ctx: ReceiveContext): void {
    if (typeof msg.cid !== 'string' || typeof msg.to !== 'string' || msg.from === msg.to
        || !['w', 'b', 'random'].includes(msg.color)) {
        console.warn('chess: malformed challenge');
        return;
    }
    const toPeer = S.peers.get(msg.to);
    const c: Challenge = {
        cid: msg.cid, from: msg.from, fromName: msg.name, to: msg.to, toName: toPeer?.name || (msg.to === me.addr ? me.name : msg.to),
        color: msg.color, ts: msg.ts, state: 'pending'
    };
    if (S.challenges.has(c.cid)) return;
    S.challenges.set(c.cid, c);
    if (ctx.replay) return;
    if (ctx.local) {
        S.outgoing = c.cid;
        showOutgoingChallenge(c);
    } else if (c.to === me.addr) {
        presentIncomingChallenge(c);
    }
}

function onChallengeCancel(msg: MessageOf<'challenge-cancel'>, ctx: ReceiveContext): void {
    const c = S.challenges.get(msg.cid);
    if (!c || c.state !== 'pending') return;
    if (msg.from !== c.from) { console.warn('chess: unauthorized challenge cancellation', msg.cid); return; }
    c.state = 'cancelled';
    if (S.outgoing === c.cid) S.outgoing = null;
    modals.close(`challenge-in-${c.cid}`);
    modals.close(`challenge-out-${c.cid}`);
    if (!ctx.replay && !ctx.local && c.to === me.addr) toast(`${c.fromName} withdrew the challenge.`);
}

function onChallengeDecline(msg: MessageOf<'challenge-decline'>, ctx: ReceiveContext): void {
    const c = S.challenges.get(msg.cid);
    if (!c || c.state !== 'pending') return;
    if (msg.from !== c.to) { console.warn('chess: unauthorized challenge decline', msg.cid); return; }
    c.state = 'declined';
    if (S.outgoing === c.cid) S.outgoing = null;
    modals.close(`challenge-out-${c.cid}`);
    modals.close(`challenge-in-${c.cid}`);
    if (!ctx.replay && c.from === me.addr) {
        toast(msg.reason === 'busy' ? `${msg.name} is busy right now.` : `${msg.name} declined your challenge.`, 'warn');
    }
}

function colorLabel(c: Color | 'random'): string {
    return c === 'w' ? 'White' : c === 'b' ? 'Black' : 'a random color';
}

function presentIncomingChallenge(c: Challenge): void {
    const age = now() - c.ts;
    if (c.state !== 'pending' || age > CHALLENGE_TTL_MS) return;
    if (isBusy()) {
        net.send({ type: 'challenge-decline', cid: c.cid, reason: 'busy' }, { persist: true });
        return;
    }
    sounds.play('notify');
    const myColor = c.color === 'random' ? 'random' : opposite(c.color);
    modals.show({
        id: `challenge-in-${c.cid}`,
        title: 'Challenge received',
        body: `<p><b>${esc(c.fromName)}</b> challenges you to a <b>5+0</b> game.</p><p>You would play ${colorLabel(myColor)}.</p>`,
        dismissible: false,
        timeoutMs: Math.max(1000, CHALLENGE_TTL_MS - age),
        buttons: [
            { label: 'Decline', kind: 'secondary', action: () => { net.send({ type: 'challenge-decline', cid: c.cid, reason: 'declined' }, { persist: true }); } },
            { label: 'Accept', kind: 'primary', action: () => { acceptChallenge(c); } }
        ]
    });
}

function acceptChallenge(c: Challenge): void {
    if (c.state !== 'pending') { toast('That challenge is no longer available.', 'warn'); return; }
    if (isBusy()) { toast('Finish your current game first.', 'warn'); return; }
    const challengerColor: Color = c.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : c.color;
    const challenger: PlayerRef = { addr: c.from, name: c.fromName };
    const white = challengerColor === 'w' ? challenger : me;
    const black = challengerColor === 'w' ? me : challenger;
    net.send({ type: 'gstart', gameId: randomId('g'), cid: c.cid, tourId: null, white, black, tc: NETWORK_TC_MS },
        { persist: true, summary: `${white.name} vs ${black.name}` });
}

function showOutgoingChallenge(c: Challenge): void {
    const render = (): string => {
        const left = Math.max(0, Math.ceil((c.ts + CHALLENGE_TTL_MS - now()) / 1000));
        return `<p>Waiting for <b>${esc(c.toName)}</b> to accept your challenge…</p><p class="dim">Expires in ${left}s</p>`;
    };
    modals.show({
        id: `challenge-out-${c.cid}`,
        title: 'Challenge sent',
        body: render(),
        dismissible: false,
        buttons: [{ label: 'Cancel', kind: 'secondary', action: () => cancelOutgoing() }]
    });
    const timer = window.setInterval(() => {
        if (c.state !== 'pending' || S.outgoing !== c.cid) { clearInterval(timer); return; }
        if (now() - c.ts > CHALLENGE_TTL_MS) {
            clearInterval(timer);
            cancelOutgoing();
            toast(`${c.toName} did not answer.`, 'warn');
            return;
        }
        modals.update(`challenge-out-${c.cid}`, render());
    }, 1000);
}

function cancelOutgoing(): void {
    const cid = S.outgoing;
    if (!cid) return;
    S.outgoing = null;
    net.send({ type: 'challenge-cancel', cid }, { persist: true });
}

function openChallengeDialog(peer: Peer): void {
    if (!net.available) return;
    if (isBusy()) { toast('You are already in a network game or tournament.', 'warn'); return; }
    if (S.outgoing) { toast('You already have a pending challenge.', 'warn'); return; }
    modals.show({
        id: 'challenge-setup',
        title: `Challenge ${peer.name}`,
        dismissible: true,
        body: `<p>Casual game, <b>5 minutes</b> per side.</p>
            <div class="choice-row" role="radiogroup" aria-label="Your color">
                ${(['w', 'random', 'b'] as const).map((c) => `<label class="choice">
                    <input type="radio" name="ch-color" value="${c}" ${prefs.color === c ? 'checked' : ''}>
                    <span class="color-chip ${c}">${c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</span></label>`).join('')}
            </div>`,
        buttons: [
            { label: 'Cancel', kind: 'secondary' },
            {
                label: 'Send challenge', kind: 'primary', action: (dialog) => {
                    const color = (dialog.querySelector<HTMLInputElement>('input[name=ch-color]:checked')?.value || 'random') as Color | 'random';
                    prefs.color = color; savePrefs();
                    if (!isOnline(peer.addr) || isBusy()) { toast('That peer is not available any more.', 'warn'); return; }
                    S.mode = 'network';
                    net.send({ type: 'challenge', cid: randomId('c'), to: peer.addr, color }, {
                        persist: true,
                        notify: { [peer.addr]: `${me.name} challenges you to a game of chess` }
                    });
                }
            }
        ]
    });
}

// ---------------------------------------------------------------- network games

function onGameStart(msg: MessageOf<'gstart'>, ctx: ReceiveContext): void {
    if (S.games.has(msg.gameId)) return;
    const challenge = msg.cid ? S.challenges.get(msg.cid) : null;
    const tour = S.tour;
    const validPlayers = msg.white && msg.black && typeof msg.white.addr === 'string' && typeof msg.black.addr === 'string'
        && typeof msg.white.name === 'string' && typeof msg.black.name === 'string' && msg.white.addr !== msg.black.addr;
    const validStart = validPlayers && msg.tc === NETWORK_TC_MS && (msg.tourId
        ? tour?.id === msg.tourId && tour.host === msg.from && !!tour.players[msg.white.addr] && !!tour.players[msg.black.addr]
        : !!challenge && challenge.state !== 'accepted' && msg.from === challenge.to
            && [msg.white.addr, msg.black.addr].includes(challenge.from)
            && [msg.white.addr, msg.black.addr].includes(challenge.to)
            && (challenge.color === 'random' || (challenge.color === 'w' ? msg.white.addr : msg.black.addr) === challenge.from));
    if (!validStart) { console.warn('chess: unauthorized game start', msg.gameId); return; }
    const startTs = ctx.replay ? msg.ts : now();
    const g = new GameRecord({
        id: msg.gameId, kind: msg.tourId ? 'tournament' : 'network', white: msg.white, black: msg.black,
        tc: msg.tc || NETWORK_TC_MS, startTs, tourId: msg.tourId, cid: msg.cid
    });
    S.games.set(g.id, g);
    let challengeState: Challenge['state'] | null = null;
    if (msg.cid) {
        const c = S.challenges.get(msg.cid);
        challengeState = c?.state || null;
        if (c) c.state = 'accepted';
        modals.close(`challenge-in-${msg.cid}`);
        modals.close(`challenge-out-${msg.cid}`);
        if (S.outgoing === msg.cid) S.outgoing = null;
    }
    const mine = g.colorOf(me.addr);
    if (!mine || ctx.replay) { scheduleRender(); return; }
    // Challenge withdrawn before the acceptance arrived, or we are already playing elsewhere.
    const cancelled = !ctx.local && (challengeState === 'cancelled' || challengeState === 'declined');
    const other = [...S.games.values()].find((x) => x !== g && !x.over && x.colorOf(me.addr));
    if (cancelled || other) { abortGame(g); return; }
    enterGame(g);
}

function abortGame(g: GameRecord): void {
    net.send({ type: 'gend', gameId: g.id, result: '1/2-1/2', reason: 'aborted' }, { persist: true });
}

function enterGame(g: GameRecord): void {
    S.game = g;
    S.viewPly = null;
    S.flipped = false;
    const color = myColorIn(g);
    if (g.kind !== 'computer') {
        S.mode = g.kind === 'tournament' ? 'tournament' : 'network';
        const opp = color ? g.player(opposite(color)).name : '';
        sounds.play('notify');
        toast(color ? `Game started vs ${opp} — you play ${color === 'w' ? 'White' : 'Black'}.` : 'Watching game.', 'success');
        modals.closeMatching('tour-invite');
    }
    sendPresence(true);
    render();
}

function requestSync(g: GameRecord): void {
    if (now() - g.lastSyncRequest < SYNC_RETRY_MS || net.replaying) return;
    g.lastSyncRequest = now();
    net.send({ type: 'gsync-req', gameId: g.id, have: g.plies.length }, { persist: true });
}

function onMove(msg: MessageOf<'move'>, ctx: ReceiveContext): void {
    const g = S.games.get(msg.gameId);
    if (!g || g.over) return;
    if (!canMove(g, msg.from, msg.ply) || !validClock(msg.clock) || typeof msg.uci !== 'string') {
        console.warn('chess: unauthorized or malformed move', msg.gameId, msg.ply);
        return;
    }
    if (msg.ply < g.plies.length) return;
    const at = ctx.replay ? msg.ts : now();
    if (msg.ply > g.plies.length) {
        if (msg.ply - g.plies.length > MAX_PENDING_MOVES || g.pending.size >= MAX_PENDING_MOVES) {
            console.warn('chess: excessive move gap', g.id, msg.ply);
            if (!ctx.replay) requestSync(g);
            return;
        }
        g.pending.set(msg.ply, { from: msg.from, uci: msg.uci, clock: msg.clock, at });
        if (!ctx.replay) requestSync(g);
        if (!ctx.replay && g === S.game) toast('Waiting for missing moves. Requesting game sync.', 'warn');
        return;
    }
    if (!applyNetworkMove(g, msg.uci, msg.clock, at, ctx)) return;
    while (g.pending.has(g.plies.length) && !g.over) {
        const p = g.pending.get(g.plies.length)!;
        g.pending.delete(g.plies.length);
        if (!canMove(g, p.from, g.plies.length) || !applyNetworkMove(g, p.uci, p.clock, ctx.replay ? p.at : now(), ctx)) break;
    }
    applyPendingEnd(g);
}

function applyNetworkMove(
    g: GameRecord, uci: string, clock: { w: number; b: number }, at: number, ctx: ReceiveContext, historical = ctx.replay
): boolean {
    const rec = g.applyMove(uci, clock, at, historical);
    if (!rec) {
        console.warn('chess: rejected move', g.id, uci);
        if (!ctx.replay) requestSync(g);
        return false;
    }
    if (g === S.game && !ctx.replay) {
        sounds.play(rec.captured ? 'capture' : 'move');
        if (S.viewPly !== null && S.viewPly >= g.plies.length - 1) S.viewPly = null;
    }
    const st = g.status();
    if (st.over && st.result) finishGame(g, st.result, st.reason || '', { announce: ctx.local && !ctx.replay, at, replay: ctx.replay });
    scheduleRender();
    return true;
}

function onGameEnd(msg: MessageOf<'gend'>, ctx: ReceiveContext): void {
    const g = S.games.get(msg.gameId);
    if (!g || g.over) return;
    const at = ctx.replay ? msg.ts : now();
    if (!canEndGame(g, msg.from, msg.result, msg.reason, at)) {
        console.warn('chess: rejected game result', msg.gameId, msg.reason);
        if (g.pending.size && g.colorOf(msg.from) && ['agreement', 'time out', 'checkmate', 'stalemate', 'insufficient material',
            'threefold repetition', '50-move rule'].includes(msg.reason)) {
            g.pendingEnd = { from: msg.from, result: msg.result, reason: msg.reason, at, replay: ctx.replay };
            if (!ctx.replay) requestSync(g);
        }
        return;
    }
    finishGame(g, msg.result, msg.reason, { announce: false, at, replay: ctx.replay });
}

function applyPendingEnd(g: GameRecord): void {
    const end = g.pendingEnd;
    if (!end || g.over) return;
    if (!canEndGame(g, end.from, end.result, end.reason, end.at)) {
        if (!g.pending.size) g.pendingEnd = null;
        return;
    }
    g.pendingEnd = null;
    finishGame(g, end.result, end.reason, { announce: false, at: end.at, replay: end.replay });
}

interface FinishOptions { announce: boolean; at?: number; replay?: boolean; }

function finishGame(g: GameRecord, result: GameResult, reason: string, opts: FinishOptions): void {
    if (!g.end(result, reason, opts.at ?? now())) return;
    if (g.kind === 'computer') {
        saveComputerGame();
    } else {
        if (opts.announce && g.colorOf(me.addr)) {
            const info = g.kind === 'network'
                ? `♟ ${g.white.name} vs ${g.black.name}: ${result.replace('1/2-1/2', '½-½')} (${reason})` : undefined;
            net.send({ type: 'gend', gameId: g.id, result, reason }, { persist: true, info, summary: `${g.white.name} vs ${g.black.name}: ${result}` });
        }
        hostRecordResult(g.id, result, reason);
    }
    if (g === S.game && !opts.replay) {
        sounds.play('end');
        const mine = myColorIn(g);
        if (mine && g.kind !== 'computer') {
            const won = (result === '1-0' && mine === 'w') || (result === '0-1' && mine === 'b');
            const msg = result === '1/2-1/2' ? 'Game drawn' : won ? 'You won!' : 'You lost';
            toast(`${msg} — ${describeResult(result, reason)}`, won ? 'success' : 'info', 5000);
        }
    }
    if (!opts.replay) sendPresence(true);
    scheduleRender();
}

function onDrawOffer(msg: MessageOf<'draw-offer'>, ctx: ReceiveContext): void {
    const g = S.games.get(msg.gameId);
    if (!g || g.over) return;
    if (!g.colorOf(msg.from)) { console.warn('chess: unauthorized draw offer', g.id); return; }
    g.drawOffer = msg.from;
    applyPendingEnd(g);
    if (!ctx.local && !ctx.replay && g === S.game && g.colorOf(me.addr)) {
        sounds.play('notify');
        toast(`${msg.name} offers a draw.`);
    }
    scheduleRender();
}

function onDrawDecline(msg: MessageOf<'draw-decline'>, ctx: ReceiveContext): void {
    const g = S.games.get(msg.gameId);
    if (!g || g.over) return;
    if (!canDeclineDraw(g, msg.from)) { console.warn('chess: unauthorized draw decline', g.id); return; }
    g.drawOffer = null;
    if (!ctx.local && !ctx.replay && g === S.game) toast(`${msg.name} declined the draw offer.`);
    scheduleRender();
}

function onSyncRequest(msg: MessageOf<'gsync-req'>, ctx: ReceiveContext): void {
    if (ctx.local || ctx.replay) return;
    const g = S.games.get(msg.gameId);
    if (!g || !g.colorOf(me.addr) || g.plies.length <= msg.have && !g.over) return;
    net.send({
        type: 'gsync', gameId: g.id, moves: g.plies.map((p) => ({ uci: p.uci, clock: p.clock || { w: g.tc, b: g.tc } })),
        result: g.result, reason: g.reason
    });
}

function onSync(msg: MessageOf<'gsync'>, ctx: ReceiveContext): void {
    if (ctx.local) return;
    const g = S.games.get(msg.gameId);
    if (!g || g.over) return;
    if (!validSync(g, msg, me.addr)) { console.warn('chess: rejected game sync', g.id); return; }
    const at = ctx.replay ? msg.ts : now();
    for (let i = g.plies.length; i < msg.moves.length && !g.over; i++) {
        const clock = syncClock(g, i, msg.moves[i].clock, me.addr);
        if (!applyNetworkMove(g, msg.moves[i].uci, clock, at, { ...ctx, local: false }, true)) return;
        g.pending.delete(i);
    }
    for (const ply of g.pending.keys()) if (ply < g.plies.length) g.pending.delete(ply);
    while (g.pending.has(g.plies.length) && !g.over) {
        const p = g.pending.get(g.plies.length)!;
        g.pending.delete(g.plies.length);
        if (!canMove(g, p.from, g.plies.length) || !applyNetworkMove(g, p.uci, p.clock, at, ctx, true)) break;
    }
    if (msg.result && !g.over) {
        if (canEndGame(g, msg.from, msg.result, msg.reason || '', at)) {
            finishGame(g, msg.result, msg.reason || '', { announce: false, at, replay: ctx.replay });
        } else console.warn('chess: rejected sync result', g.id);
    }
    applyPendingEnd(g);
    scheduleRender();
}

// ---------------------------------------------------------------- tournaments

function broadcastTour(persist: boolean, extra: { info?: string; notify?: Record<string, string> } = {}): void {
    const t = S.tour;
    if (!t || net.replaying) return;
    S.lastTourBroadcast = now();
    S.tourDirty = false;
    const players = Object.keys(t.players).length;
    net.send({ type: 'tstate', tour: T.clone(t) }, { persist, summary: `Tournament: ${players} player${players === 1 ? '' : 's'}`, ...extra });
}

function hostRecordResult(gameId: string, result: GameResult, reason: string): void {
    const t = S.tour;
    if (!t || t.host !== me.addr || !t.games[gameId]) return;
    if (T.applyResult(t, gameId, result, reason, now())) {
        S.tourDirty = true;
        if (!net.replaying) broadcastTour(true);
    }
}

function reconcileTournamentGames(t: T.TournamentState, replay: boolean): void {
    for (const result of Object.values(t.games)) {
        const g = S.games.get(result.id);
        if (!g || g.over || g.tourId !== t.id || !result.result
            || g.white.addr !== result.white || g.black.addr !== result.black) continue;
        finishGame(g, result.result, result.reason || '', {
            announce: false, at: replay ? result.endTs ?? now() : now(), replay
        });
    }
}

function onTournamentState(msg: MessageOf<'tstate'>, ctx: ReceiveContext): void {
    if (!T.isValidState(msg.tour)) { console.warn('chess: malformed tournament state'); return; }
    const prev = S.tour;
    const incoming = msg.tour;
    const successor = prev?.id === incoming.id && prev.host !== incoming.host;
    if (!T.canPublishState(prev, incoming, msg.from, ctx.replay ? null : onlineSet())
        || (successor && !ctx.replay && now() - appStart <= peerTimeout() + 5000)) {
        console.warn('chess: unauthorized tournament state', incoming.id, msg.from);
        return;
    }
    if (T.pickNewer(prev, incoming) !== incoming || prev === incoming) {
        // Help a lagging peer catch up with our newer copy.
        if (!ctx.replay && !ctx.local && prev && prev.id === incoming.id && prev.host === me.addr
            && incoming.rev < prev.rev && now() - S.lastTourBroadcast > 2000) broadcastTour(false);
        return;
    }
    S.tour = T.clone(incoming);
    const t = S.tour;
    reconcileTournamentGames(t, ctx.replay);
    if (t.players[me.addr] && S.joiningTour === t.id) S.joiningTour = null;
    if (!ctx.replay && !ctx.local) {
        const isNew = !prev || prev.id !== t.id;
        if (isNew && t.status === 'running' && !t.players[me.addr]) inviteToTournament(t);
        if (prev && prev.id === t.id && prev.status !== 'finished' && t.status === 'finished' && t.players[me.addr]) showTournamentResults(t);
        if (prev && prev.id === t.id && prev.host !== t.host && t.host === me.addr) toast('You are now coordinating the tournament.');
    }
    scheduleRender();
}

function onTournamentJoin(msg: MessageOf<'tjoin'>, ctx: ReceiveContext): void {
    const t = S.tour;
    if (!t || t.id !== msg.tourId || t.host !== me.addr) return;
    if (T.addPlayer(t, msg.from, msg.name, ctx.replay ? msg.ts : now())) {
        S.tourDirty = true;
        if (!ctx.replay) {
            if (!ctx.local) toast(`${msg.name} joined the tournament.`);
            broadcastTour(true);
        }
        scheduleRender();
    }
}

function onTournamentLeave(msg: MessageOf<'tleave'>, ctx: ReceiveContext): void {
    const t = S.tour;
    if (!t || t.id !== msg.tourId || t.host !== me.addr) return;
    if (T.withdraw(t, msg.from)) {
        S.tourDirty = true;
        if (!ctx.replay) broadcastTour(true);
        scheduleRender();
    }
}

function inviteToTournament(t: T.TournamentState): void {
    if (loadJson<string>(STORAGE_DISMISSED_TOUR, '') === t.id) return;
    const host = t.players[t.createdBy]?.name || 'Someone';
    const count = Object.values(t.players).filter((p) => !p.withdrawn).length;
    if (myActiveNetworkGame()) {
        toast(`${host} started a tournament. Join it from the Tournament menu after your game.`);
        return;
    }
    sounds.play('notify');
    modals.show({
        id: `tour-invite-${t.id}`,
        title: 'Tournament invitation',
        body: `<p><b>${esc(host)}</b> invites you to <b>${esc(t.name)}</b>, a ${t.durationMs / 60000}-minute arena tournament with 5+0 games.</p>
            <p class="dim">${count} player${count === 1 ? '' : 's'} so far • ${formatDuration(T.endTs(t) - now())} left</p>`,
        dismissible: false,
        buttons: [
            { label: 'Not now', kind: 'secondary', action: () => saveJson(STORAGE_DISMISSED_TOUR, t.id) },
            { label: 'Join tournament', kind: 'primary', action: () => joinTournament() }
        ]
    });
}

function createTournament(minutes: number): void {
    if (!T.validDurationMinutes(minutes)) { toast('Choose a tournament duration of 15, 30, 45, or 60 minutes.', 'warn'); return; }
    if (!net.available) { toast('Tournaments need a webxdc messenger chat.', 'warn'); return; }
    if (isBusy()) { toast('You are already in a game or tournament.', 'warn'); return; }
    if (S.tour && T.isActive(S.tour)) { joinTournament(); return; }
    if (S.game?.kind === 'computer' || S.game?.kind === 'puzzle') S.game = null;
    prefs.tournamentMinutes = minutes;
    savePrefs();
    S.tour = T.create({ id: randomId('t'), host: me.addr, hostName: me.name, now: now(), durationMs: minutes * 60000 });
    S.mode = 'tournament';
    S.tab = 'standings';
    const notify: Record<string, string> = {};
    for (const p of onlinePeers()) notify[p.addr] = `${me.name} invites you to a chess tournament`;
    broadcastTour(true, { info: `🏆 ${me.name} started a ${minutes}-minute chess tournament. Open Chess to join!`, notify });
    sendPresence(true);
    toast('Tournament created. Waiting for players to join…', 'success');
    render();
}

function joinTournament(): void {
    const t = S.tour;
    if (!t || !T.isActive(t)) { toast('There is no tournament running.', 'warn'); return; }
    if (t.status !== 'running') { toast('The tournament is finishing; no new players.', 'warn'); return; }
    if (myActiveNetworkGame()) { toast('Finish your current game first.', 'warn'); return; }
    if ((S.game?.kind === 'computer' || S.game?.kind === 'puzzle') && !S.game.over) S.game = null;
    S.mode = 'tournament';
    S.tab = 'standings';
    S.joiningTour = t.id;
    S.lastJoinSent = now();
    net.send({ type: 'tjoin', tourId: t.id }, { persist: true });
    sendPresence(true);
    render();
}

function withdrawFromTournament(): void {
    const t = S.tour;
    if (!t || !t.players[me.addr]) return;
    const g = myActiveNetworkGame();
    modals.show({
        id: 'tour-withdraw',
        title: 'Withdraw from tournament?',
        body: g ? '<p>Your current game will be resigned.</p>' : '<p>You will not be paired again. Your points are kept and you can rejoin while it is running.</p>',
        dismissible: true,
        buttons: [
            { label: 'Stay', kind: 'secondary' },
            {
                label: 'Withdraw', kind: 'danger', action: () => {
                    if (g && g.tourId === t.id) resign(g);
                    S.joiningTour = null;
                    net.send({ type: 'tleave', tourId: t.id }, { persist: true });
                    sendPresence(true);
                }
            }
        ]
    });
}

function showTournamentResults(t: T.TournamentState): void {
    const st = T.standings(t).slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    modals.show({
        id: `tour-results-${t.id}`,
        title: `${t.name} has finished`,
        dismissible: true,
        body: `<ol class="podium">${st.map((p, i) => `<li>${medals[i]} <b>${esc(p.name)}</b> — ${p.score} pts</li>`).join('')}</ol>`,
        buttons: [{ label: 'Standings', kind: 'primary', action: () => { S.tab = 'standings'; render(); } }]
    });
}

/** Tournament duties: the host pairs players and publishes state; other members watch the host. */
function tournamentLoop(): void {
    const t = S.tour;
    if (!t || net.replaying) return;
    const ts = now();
    if (t.host === me.addr) {
        if (t.status === 'finished') return;
        const online = onlineSet();
        let changed = T.updateStatus(t, ts, online);
        changed = T.adjudicateStale(t, ts) || changed;
        changed = T.updateStatus(t, ts, online) || changed;
        reconcileTournamentGames(t, false);
        for (const pair of T.pairings(t, ts, online)) {
            const gameId = randomId('g');
            T.startGame(t, gameId, pair.white, pair.black, ts);
            changed = true;
            const ref = (addr: string): PlayerRef => ({ addr, name: t.players[addr].name });
            net.send({ type: 'gstart', gameId, cid: null, tourId: t.id, white: ref(pair.white), black: ref(pair.black), tc: NETWORK_TC_MS }, { persist: true });
        }
        if ((t.status as T.TournamentState['status']) === 'finished') {
            const winner = T.standings(t)[0];
            broadcastTour(true, { info: `🏆 ${t.name} finished${winner ? ` — winner: ${winner.name} (${winner.score} pts)` : ''}` });
            if (t.players[me.addr]) showTournamentResults(t);
        } else if (changed || S.tourDirty) {
            broadcastTour(true);
        } else if (net.hasRealtime && ts - S.lastTourBroadcast > 10000) {
            broadcastTour(false);
        }
        if (changed) scheduleRender();
        return;
    }
    if (!T.isActive(t)) return;
    // Retry joining until the host includes us.
    if (S.joiningTour === t.id && !t.players[me.addr] && ts - S.lastJoinSent > 6000) {
        S.lastJoinSent = ts;
        net.send({ type: 'tjoin', tourId: t.id });
    }
    // Host failover: the lowest-addressed online participant takes over if the host disappears.
    if (t.players[me.addr] && !t.players[me.addr].withdrawn && ts - appStart > peerTimeout() + 5000 && !isOnline(t.host)) {
        const candidates = Object.values(t.players).filter((p) => !p.withdrawn && isOnline(p.addr)).map((p) => p.addr).sort();
        if (candidates[0] === me.addr) {
            t.host = me.addr;
            t.rev++;
            broadcastTour(true);
            toast('The tournament host left; you are now coordinating the tournament.');
            scheduleRender();
        }
    }
}

// ---------------------------------------------------------------- computer games

let worker: Worker | null = null;
try {
    worker = new Worker('assets/ai-worker.js');
    worker.onmessage = (e: MessageEvent<AiResponse>) => onAiResponse(e.data);
    worker.onerror = (event) => {
        console.warn('chess: AI worker failed', event.message);
        worker?.terminate();
        worker = null;
        for (const [id, pending] of pendingAi) {
            pendingAi.delete(id);
            runAiFallback(pending.req, pending.deliver);
        }
    };
} catch (err) {
    console.warn('chess: AI worker unavailable', err);
    worker = null;
}

function computerRef(level: number): PlayerRef {
    return { addr: AI_ADDR, name: `Computer · ${LEVEL_NAMES[level] || 'Level ' + level}` };
}

function startComputerGame(color: Color | 'random', level: number, restore?: SavedComputerGame, startFen?: string): void {
    const myColor: Color = restore ? restore.myColor : startFen && color === 'random' ? new Chess(startFen).turnColor()
        : color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    const ai = computerRef(level);
    const g = new GameRecord({
        id: restore?.id || randomId('c'), kind: 'computer', white: myColor === 'w' ? me : ai, black: myColor === 'w' ? ai : me,
        tc: 0, startTs: restore?.startTs || now(), level, learnerMode: restore ? restore.learnerMode === true : prefs.learnerMode,
        startFen: restore?.startFen || startFen
    });
    if (restore) {
        for (const uci of restore.moves) if (!g.applyMove(uci, null, now())) break;
        if (restore.result) g.end(restore.result, restore.reason || '', now());
    }
    cancelPuzzleRequest();
    clearHint();
    puzzle = null;
    S.game = g;
    S.viewPly = null;
    S.flipped = false;
    S.mode = 'computer';
    S.aiThinking = false;
    S.aiRequestId++;
    if (!restore) saveComputerGame();
    sendPresence(true);
    render();
    probeChessCoach(g);
    maybeAiMove();
}

let coachProbe: { game?: GameRecord; requestId: string; sentAt: number } | null = null;
let availableCoach: { addr: string; until: number } | null = null;

function probeChessCoach(game?: GameRecord): void {
    if (!net.available) return;
    coachProbe = { game, requestId: randomId('coach'), sentAt: now() };
    net.send({ type: 'coach-probe', requestId: coachProbe.requestId });
}

function onCoachAvailable(msg: MessageOf<'coach-available'>): void {
    const pending = coachProbe;
    if (!pending || !matchesCoachAvailability(msg, pending, me.addr, now())) return;
    availableCoach = { addr: msg.from, until: now() + 30_000 };
    coachProbe = null;
    if (pending.game === S.game && pending.game?.learnerMode && !pending.game.over) {
        toast('Chess Coach is available and can provide a suggestion when you request HINT in VS-COMPUTER mode.', 'info', 6000);
    }
    scheduleRender();
}

function coachAvailable(): boolean {
    return !!availableCoach && now() < availableCoach.until;
}

let puzzle: Puzzle | null = null;
let puzzleRequest: {
    requestId: string; gameId: string; coach: string; sentAt: number; cancel: () => void;
} | null = null;

function cancelPuzzleRequest(): void {
    puzzleRequest?.cancel();
    puzzleRequest = null;
}

function continuePuzzle(): void {
    const position = S.game && puzzleContinuation(S.game, me.addr);
    if (!position || S.viewPly !== null) return;
    if (isBusy()) { toast('Finish your network game or leave the tournament first.', 'warn'); return; }
    openComputerSetup(position.startFen, { color: position.color, level: 5 });
}

function requestPuzzle(): void {
    if (!coachAvailable()) { toast('Chess coach is not available.', 'warn'); return; }
    if (isBusy()) { toast('Finish your network game or leave the tournament first.', 'warn'); return; }
    cancelPuzzleRequest();
    clearHint();
    S.aiRequestId++;
    S.aiThinking = false;
    S.mode = 'puzzles';
    S.game = null;
    S.viewPly = null;
    puzzle = null;
    const pending = {
        requestId: randomId('puzzle-request'), gameId: randomId('puzzle'),
        coach: availableCoach!.addr, sentAt: now(), cancel: () => {}
    };
    puzzleRequest = pending;
    const payload = {
        type: 'puzzle-request' as const, requestId: pending.requestId, gameId: pending.gameId,
        ...(prefs.puzzleType && { puzzleType: prefs.puzzleType })
    };
    const send = (): void => {
        net.send(payload, { persist: true });
    };
    pending.cancel = waitForCoachHint(() => {
        net.send(payload);
    }, () => {
        if (puzzleRequest !== pending) return;
        cancelPuzzleRequest();
        toast('Chess coach did not return a puzzle within 30 seconds. Its Lichess database may still be downloading or preparing. Please try again later.', 'warn');
        render();
    });
    send();
    sendPresence(true);
    render();
}

function onPuzzleResponse(msg: MessageOf<'puzzle-response'>): void {
    const pending = puzzleRequest;
    if (!pending || S.mode !== 'puzzles' || S.game ||
        !matchesPuzzleResponse(msg, pending, me.addr, now())) return;
    cancelPuzzleRequest();
    try {
        if (typeof msg.error === 'string') throw new PgnError(`Chess coach: ${msg.error.slice(0, 200)}`);
        if (typeof msg.pgn !== 'string') throw new PgnError('Chess coach returned no puzzle PGN.');
        puzzle = new Puzzle(msg.pgn, pending.gameId, me, now(), msg.themes);
        S.game = puzzle.game;
        S.flipped = false;
        toast('Find the next move. The computer will play the puzzle replies.', 'info');
    } catch (error) {
        if (!(error instanceof PgnError)) throw error;
        console.warn('chess: puzzle request failed', error);
        toast(error.message, 'warn');
    }
    render();
}

function saveComputerGame(): void {
    const g = S.game;
    if (!g || g.kind !== 'computer') return;
    const saved: SavedComputerGame = {
        id: g.id, myColor: myColorIn(g)!, level: g.level, startTs: g.startTs,
        moves: g.plies.map((p) => p.uci), result: g.result, reason: g.reason, learnerMode: g.learnerMode,
        startFen: g.startFen
    };
    saveJson(STORAGE_COMPUTER, saved);
}

function maybeAiMove(): void {
    const g = S.game;
    if (!g || g.kind !== 'computer' || g.over || S.aiThinking || g.turn === myColorIn(g)) return;
    S.aiThinking = true;
    const id = ++S.aiRequestId;
    const req: AiRequest = { id, startFen: g.startFen, moves: g.plies.map((p) => p.uci), level: g.level };
    const started = now();
    scheduleRender();
    const deliver = (uci: string | null): void => {
        const wait = Math.max(0, 350 - (now() - started));
        setTimeout(() => onAiResponse({ id, uci }), wait);
    };
    if (worker) {
        pendingAi.set(id, { req, deliver });
        try {
            worker.postMessage(req);
        } catch (err) {
            console.warn('chess: AI worker send failed', err);
            pendingAi.delete(id);
            worker.terminate();
            worker = null;
            runAiFallback(req, deliver);
        }
    } else {
        runAiFallback(req, deliver);
    }
}

let fallbackNoticeShown = false;
function runAiFallback(req: AiRequest, deliver: (uci: string | null) => void): void {
    if (!fallbackNoticeShown) {
        fallbackNoticeShown = true;
        toast('AI worker unavailable. Using a reduced-strength computer to keep the interface responsive.', 'warn', 5000);
    }
    const c = new Chess(req.startFen);
    for (const m of req.moves) c.move(m);
    void fallbackMove(c).then(deliver).catch((err: unknown) => {
        console.error('chess: AI fallback failed', err);
        if (req.id === S.aiRequestId) {
            S.aiThinking = false;
            toast('Computer move failed. Start a new computer game to retry.', 'warn');
            scheduleRender();
        }
    });
}

const pendingAi = new Map<number, { req: AiRequest; deliver: (uci: string | null) => void }>();

let hint: {
    game: GameRecord; fen: string; requestId: string; move: BoardHint | null; worker: Worker | null;
    cancelWait?: () => void; local: boolean;
} | null = null;

function clearHint(): void {
    hint?.worker?.terminate();
    hint?.cancelWait?.();
    hint = null;
}

function refreshHint(): void {
    if (hint && (hint.game !== S.game || hint.fen !== hint.game.chess.fen()
        || !canRequestHint(hint.game, myColorIn(hint.game), S.viewPly !== null, S.aiThinking))) clearHint();
}

function requestHint(): void {
    const g = S.game;
    if (!g || !canRequestHint(g, myColorIn(g), S.viewPly !== null, S.aiThinking)) return;
    if (g.kind === 'puzzle' && (!net.available || !coachAvailable())) {
        toast('Chess coach is not available for a puzzle hint. Please try again when it reconnects.', 'warn');
        return;
    }
    clearHint();
    const search: NonNullable<typeof hint> = {
        game: g, fen: g.chess.fen(), requestId: randomId('hint'),
        move: null, worker: null, local: false
    };
    hint = search;
    if (net.available) {
        const payload = {
            type: 'hint-request' as const, requestId: search.requestId, gameId: g.id,
            fen: search.fen, startFen: g.startFen, moves: g.plies.map(p => p.uci)
        };
        // Discovery can finish after the first broadcast; retry the same request, not a new search.
        search.cancelWait = waitForCoachHint(() => {
            refreshHint();
            if (hint === search && net.hasRealtime) net.send(payload);
        }, () => {
            refreshHint();
            if (hint !== search) return;
            if (g.kind === 'puzzle') {
                failCoachHint('Chess coach did not respond. Please try requesting a puzzle hint again.');
                return;
            }
            console.warn('chess: coach hint timed out; using local Expert-level AI');
            toast('Chess coach did not respond. Using local Expert-level AI for this hint.', 'warn', 5000);
            requestLocalHint(search);
        });
        net.send(payload, { persist: true });
        scheduleRender();
        return;
    }
    requestLocalHint(search);
}

function requestLocalHint(search: NonNullable<typeof hint>): void {
    search.cancelWait?.();
    search.local = true;
    const fail = (message: string): void => {
        if (hint !== search) return;
        console.warn('chess: hint search failed', message);
        clearHint();
        toast('Hint unavailable. Please try again; hints require a working AI worker.', 'warn');
        scheduleRender();
    };
    try {
        const engine = new Worker('assets/ai-worker.js');
        search.worker = engine;
        engine.onerror = (event) => fail(event.message);
        engine.onmessage = (event: MessageEvent<AiResponse>) => {
            if (hint !== search) return;
            refreshHint();
            if (hint !== search) return;
            const response = event.data;
            if (response.error || !response.uci) { fail(response.error || 'No move returned'); return; }
            const text = describeHint(search.fen, response.uci);
            if (!text) { fail('The engine returned an illegal move'); return; }
            engine.terminate();
            search.worker = null;
            const move = new Chess(search.fen).move(response.uci)!;
            search.move = { from: move.from, to: move.to, label: text, promotion: move.promotion };
            scheduleRender();
        };
        const req: AiRequest = { id: 1, startFen: search.fen, moves: [], level: 5 };
        engine.postMessage(req);
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
    scheduleRender();
}

function failCoachHint(message: string): void {
    console.warn('chess: coach hint failed', message);
    clearHint();
    toast(message, 'warn', 5000);
    scheduleRender();
}

function onHintResponse(msg: MessageOf<'hint-response'>): void {
    refreshHint();
    const search = hint;
    if (!search || search.local || search.move || !matchesHintResponse(msg, {
        requestId: search.requestId, gameId: search.game.id, fen: search.fen
    }, me.addr)) return;
    if (typeof msg.error === 'string' && msg.error) {
        failCoachHint(`Chess coach: ${msg.error.slice(0, 200)}`);
        return;
    }
    if (typeof msg.uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(msg.uci)) {
        failCoachHint('Chess coach returned an invalid move. Please try again.');
        return;
    }
    const label = describeHint(search.fen, msg.uci);
    if (!label) {
        failCoachHint('Chess coach returned an illegal move. Please try again.');
        return;
    }
    search.cancelWait?.();
    const move = new Chess(search.fen).move(msg.uci)!;
    search.move = { from: move.from, to: move.to, label, promotion: move.promotion };
    scheduleRender();
}

function onAiResponse(res: AiResponse): void {
    const pending = pendingAi.get(res.id);
    if (pending) {
        // First arrival from the worker: apply the minimum "thinking" delay.
        pendingAi.delete(res.id);
        pending.deliver(res.uci);
        return;
    }
    if (res.id !== S.aiRequestId) return;
    S.aiThinking = false;
    const g = S.game;
    if (!g || g.kind !== 'computer' || g.over || !res.uci) { scheduleRender(); return; }
    const rec = g.applyMove(res.uci, null, now());
    if (rec) {
        sounds.play(rec.captured ? 'capture' : 'move');
        const st = g.status();
        if (st.over && st.result) finishGame(g, st.result, st.reason || '', { announce: false });
        saveComputerGame();
    }
    render();
}

function openComputerSetup(startFen?: string, options: { color?: Color; level?: number } = {}): void {
    if (myActiveNetworkGame()) { toast('Finish your current network game first.', 'warn'); return; }
    const position = startFen ? new Chess(startFen) : null;
    if (position?.status().over) { toast('This position is already finished. Choose an earlier position to play from.', 'warn'); return; }
    const color = options.color ?? position?.turnColor();
    const level = options.level ?? prefs.level;
    modals.show({
        id: 'computer-setup',
        title: 'Play against the computer',
        dismissible: true,
        body: `<div class="field-label">Strength</div>
            <div class="choice-row levels">${[1, 2, 3, 4, 5].map((l) => `<label class="choice">
                <input type="radio" name="level" value="${l}" ${level === l ? 'checked' : ''}>
                <span class="level-chip" title="${LEVEL_NAMES[l]}">${l}</span></label>`).join('')}</div>
            <div class="dim level-name"></div>
            ${position ? `<p>You play ${color === 'w' ? 'White' : 'Black'}. ${position.turnColor() === color ? 'You move' : 'The computer moves'} first from the displayed position.</p>` : `<div class="field-label">Your color</div>
            <div class="choice-row">${(['w', 'random', 'b'] as const).map((c) => `<label class="choice">
                <input type="radio" name="color" value="${c}" ${prefs.color === c ? 'checked' : ''}>
                <span class="color-chip ${c}">${c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</span></label>`).join('')}</div>`}
            <label class="learner-option"><input type="checkbox" name="learner-mode" ${prefs.learnerMode ? 'checked' : ''}>
                <span>Learner mode</span></label>
            <p class="dim small">Show a Hint button to suggest a move on your turn.</p>`,
        buttons: [
            { label: 'Cancel', kind: 'secondary' },
            {
                label: 'Start game', kind: 'primary', action: (dialog) => {
                    if (myActiveNetworkGame()) { toast('Finish your current network game first.', 'warn'); return false; }
                    prefs.level = Number(dialog.querySelector<HTMLInputElement>('input[name=level]:checked')?.value || 3);
                    if (!position) prefs.color = (dialog.querySelector<HTMLInputElement>('input[name=color]:checked')?.value || 'random') as Color | 'random';
                    prefs.mode = 'computer';
                    prefs.learnerMode = dialog.querySelector<HTMLInputElement>('input[name=learner-mode]')?.checked === true;
                    savePrefs();
                    startComputerGame(color ?? prefs.color, prefs.level, undefined, startFen);
                }
            }
        ],
        onOpen: (dialog) => {
            const update = (): void => {
                const l = Number(dialog.querySelector<HTMLInputElement>('input[name=level]:checked')?.value || 3);
                const out = dialog.querySelector('.level-name');
                if (out) out.textContent = `Level ${l}: ${LEVEL_NAMES[l]}`;
            };
            dialog.querySelectorAll<HTMLInputElement>('input[name=level]').forEach((i) => i.addEventListener('change', update));
            update();
        }
    });
}

// ---------------------------------------------------------------- user actions

function userMove(from: string, to: string, promotion: PieceType | null): void {
    const g = S.game;
    const color = myColorIn(g);
    if (!g || !color || g.over || g.turn !== color || S.viewPly !== null) return;
    if (g.pending.size) { toast('Waiting for missing moves. Requesting game sync.', 'warn'); requestSync(g); return; }
    const legal = g.chess.movesFrom(from).find((m) => m.to === to && (!m.promotion || m.promotion === (promotion || 'q')));
    if (!legal) return;
    if (g.kind === 'puzzle') {
        if (!puzzle || puzzle.game !== g) return;
        if (!puzzle.play(legal.uci)) {
            toast('Not the puzzle solution. Try another move.', 'warn');
        } else {
            sounds.play(g.over ? 'end' : 'move');
            if (g.over) toast('Puzzle solved!', 'success');
        }
        render();
        return;
    }
    if (g.kind === 'computer') {
        if (S.aiThinking) return;
        const rec = g.applyMove(legal.uci, null, now());
        if (!rec) return;
        sounds.play(rec.captured ? 'capture' : 'move');
        const st = g.status();
        if (st.over && st.result) finishGame(g, st.result, st.reason || '', { announce: false });
        saveComputerGame();
        render();
        maybeAiMove();
        return;
    }
    const ts = now();
    if (g.timed && g.remaining(color, ts) <= 0) return;
    net.send({ type: 'move', gameId: g.id, ply: g.plies.length, uci: legal.uci, clock: g.clockAfterMove(color, ts) }, { persist: true });
}

function resign(g: GameRecord): void {
    const color = myColorIn(g);
    if (!color || g.over) return;
    finishGame(g, color === 'w' ? '0-1' : '1-0', 'resignation', { announce: true });
}

function confirmResign(): void {
    const g = S.game;
    if (!g || g.over || !myColorIn(g)) return;
    modals.show({
        id: 'resign', title: 'Resign this game?', body: '<p>Your opponent will be awarded the win.</p>', dismissible: true,
        buttons: [{ label: 'Keep playing', kind: 'secondary' }, { label: 'Resign', kind: 'danger', action: () => resign(g) }]
    });
}

function offerDraw(): void {
    const g = S.game;
    if (!g || g.over || g.kind === 'computer' || !g.colorOf(me.addr)) return;
    if (g.drawOffer && g.drawOffer !== me.addr) {
        finishGame(g, '1/2-1/2', 'agreement', { announce: true });
        return;
    }
    if (g.drawOffer === me.addr) return;
    net.send({ type: 'draw-offer', gameId: g.id }, { persist: true });
    toast('Draw offer sent.');
}

function declineDraw(): void {
    const g = S.game;
    if (!g || g.over || !g.drawOffer || g.drawOffer === me.addr) return;
    net.send({ type: 'draw-decline', gameId: g.id }, { persist: true });
}

function rematch(): void {
    const g = S.game;
    const color = myColorIn(g);
    if (!g || !color || g.kind !== 'network') return;
    const opp = g.player(opposite(color));
    const peer = S.peers.get(opp.addr);
    if (!peer || !isOnline(opp.addr)) { toast(`${opp.name} is not connected.`, 'warn'); return; }
    if (isBusy() || S.outgoing) { toast('You are busy.', 'warn'); return; }
    net.send({ type: 'challenge', cid: randomId('c'), to: opp.addr, color: opposite(color) }, {
        persist: true, notify: { [opp.addr]: `${me.name} wants a rematch` }
    });
}

function leaveGame(): void {
    const g = S.game;
    if (g && !g.over && myColorIn(g) && g.kind !== 'computer' && g.kind !== 'puzzle') return;
    cancelPuzzleRequest();
    if (g?.kind === 'puzzle') puzzle = null;
    S.game = null;
    S.viewPly = null;
    if (g?.kind === 'computer') saveJson(STORAGE_COMPUTER, null);
    sendPresence(true);
    render();
}

function takeBack(): void {
    const g = S.game;
    if (!g || g.kind !== 'computer' || S.aiThinking || !g.plies.length) return;
    const mine = myColorIn(g)!;
    // Take back to the last position where it was my turn.
    let n = g.turn === mine ? 2 : 1;
    if (g.plies.length < n) n = g.plies.length;
    g.takeBack(n);
    S.aiRequestId++;
    S.viewPly = null;
    saveComputerGame();
    render();
    maybeAiMove();
}

function watchGame(gameId: string): void {
    const g = S.games.get(gameId);
    if (!g) { toast('That game is not known on this device yet.', 'warn'); return; }
    if (myActiveNetworkGame() && myActiveNetworkGame() !== g) { toast('Finish your own game first.', 'warn'); return; }
    S.game = g;
    S.viewPly = null;
    S.flipped = false;
    render();
}

function copyPgn(): void {
    const g = S.game;
    if (!g) return;
    const pgn = g.pgn();
    const fallback = (): void => modals.show({
        id: 'pgn', title: 'PGN', dismissible: true,
        body: `<textarea class="pgn" readonly rows="10">${esc(pgn)}</textarea>`,
        buttons: [{ label: 'Close', kind: 'primary' }]
    });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(pgn).then(() => toast('PGN copied.'), fallback);
    else fallback();
}

function openPgnImport(): void {
    if (myActiveNetworkGame()) { toast('Finish your network game before importing a PGN.', 'warn'); return; }
    modals.show({
        id: 'pgn-import', title: 'Import PGN', dismissible: true,
        body: `<p>Paste one game copied from chat. The game opens for local, read-only review.</p>
            <label for="pgn-input">PGN game</label>
            <textarea id="pgn-input" class="pgn" rows="10" spellcheck="false" aria-describedby="pgn-error" placeholder='[Event "Game vs computer"]'></textarea>
            <p id="pgn-error" role="alert" class="dim small"></p>`,
        buttons: [
            { label: 'Cancel', kind: 'secondary' },
            {
                label: 'Import game', kind: 'primary', action: (dialog) => {
                    const input = dialog.querySelector<HTMLTextAreaElement>('#pgn-input')!;
                    const error = dialog.querySelector<HTMLElement>('#pgn-error')!;
                    if (myActiveNetworkGame()) {
                        error.textContent = 'Finish your network game before importing a PGN.';
                        return false;
                    }
                    let imported: GameRecord;
                    try {
                        imported = importPgn(input.value, randomId('pgn'));
                    } catch (err) {
                        if (!(err instanceof PgnError)) throw err;
                        error.textContent = err.message;
                        input.focus();
                        return false;
                    }
                    S.aiRequestId++;
                    S.aiThinking = false;
                    S.game = imported;
                    S.viewPly = null;
                    S.flipped = false;
                    sendPresence(true);
                    render();
                    toast(`Imported ${imported.plies.length} half-moves. Use the move list or arrows to review.`, 'success');
                }
            }
        ]
    });
}

function openMenu(): void {
    modals.show({
        id: 'menu', title: 'Menu', dismissible: true,
        body: `<div class="menu-list">
            <button class="btn secondary" data-act="flip">Flip board</button>
            <button class="btn secondary" data-act="sound">${sounds.muted ? 'Turn sound on' : 'Turn sound off'}</button>
            ${S.game ? '<button class="btn secondary" data-act="pgn">Copy PGN</button>' : ''}
            <button class="btn secondary" data-act="import-pgn">Import PGN</button>
            ${S.game && (S.game.over || !myColorIn(S.game)) ? '<button class="btn secondary" data-act="leave">Close this game</button>' : ''}
        </div><p class="dim small">Version ${esc(window.APP_VERSION || 'dev')} • ${net.available ? (net.hasRealtime ? 'realtime connected' : 'messenger updates') : 'offline'}</p>`,
        buttons: [{ label: 'Close', kind: 'secondary' }],
        onOpen: (dialog) => dialog.querySelectorAll<HTMLButtonElement>('.menu-list [data-act]').forEach((b) => b.addEventListener('click', () => {
            modals.close('menu');
            const act = b.dataset.act;
            if (act === 'flip') { S.flipped = !S.flipped; render(); }
            if (act === 'sound') toggleSound();
            if (act === 'pgn') copyPgn();
            if (act === 'import-pgn') openPgnImport();
            if (act === 'leave') leaveGame();
        }))
    });
}

function toggleSound(): void {
    sounds.muted = !sounds.muted;
    prefs.muted = sounds.muted;
    savePrefs();
    render();
}

function selectMode(mode: Mode): void {
    if (mode === 'puzzles') { requestPuzzle(); return; }
    if (mode === 'computer') { openComputerSetup(); return; }
    if (!net.available) { toast('Network play needs the app to be shared in a webxdc messenger chat.', 'warn'); return; }
    if (mode === 'network') {
        S.mode = 'network';
        S.tab = 'peers';
        prefs.mode = 'network'; savePrefs();
        if (!isBusy()) toast(onlinePeers().length ? 'Pick a connected peer to challenge.' : 'No peers connected yet. They appear when they open this app.');
        render();
        return;
    }
    S.mode = 'tournament';
    S.tab = 'standings';
    prefs.mode = 'tournament'; savePrefs();
    const t = S.tour;
    if (t && T.isActive(t)) {
        const p = t.players[me.addr];
        if (!p || p.withdrawn) {
            modals.show({
                id: 'tour-join', title: t.name, dismissible: true,
                body: `<p>A ${t.durationMs / 60000}-minute arena tournament is running (${Object.values(t.players).filter((x) => !x.withdrawn).length} players, ${formatDuration(T.endTs(t) - now())} left).</p>`,
                buttons: [{ label: 'Close', kind: 'secondary' }, { label: p ? 'Rejoin' : 'Join tournament', kind: 'primary', action: () => joinTournament() }]
            });
        }
    } else if (isBusy()) {
        toast('Finish your current game before starting a tournament.', 'warn');
    } else {
        modals.show({
            id: 'tour-create', title: 'Start a tournament', dismissible: true,
            body: `<p>Start an arena tournament. All connected peers are invited.</p>
                <label class="field-label" for="tournament-duration">Tournament duration</label>
                <select id="tournament-duration" class="duration-select">${T.DURATION_MINUTES.map(minutes =>
                    `<option value="${minutes}" ${prefs.tournamentMinutes === minutes ? 'selected' : ''}>${minutes} minutes</option>`).join('')}</select>
                <ul class="rules"><li>Each game is 5+0 (5 minutes per side).</li><li>Players are paired again automatically after each game.</li>
                <li>Win = 2 points, draw = 1. After two wins in a row, points are doubled 🔥.</li></ul>`,
            buttons: [{ label: 'Cancel', kind: 'secondary' }, {
                label: 'Start tournament', kind: 'primary', action: (dialog) =>
                    createTournament(Number(dialog.querySelector<HTMLSelectElement>('#tournament-duration')!.value))
            }],
            onOpen: (dialog) => {
                const select = dialog.querySelector<HTMLSelectElement>('#tournament-duration')!;
                select.addEventListener('change', () => {
                    const minutes = Number(select.value);
                    if (!T.validDurationMinutes(minutes)) {
                        toast('Choose a tournament duration of 15, 30, 45, or 60 minutes.', 'warn');
                        return;
                    }
                    prefs.tournamentMinutes = minutes;
                    savePrefs();
                });
            }
        });
    }
    render();
}

// ---------------------------------------------------------------- rendering

const board = new BoardView($('#board'), { onMove: userMove });

function viewPly(g: GameRecord): number { return S.viewPly === null ? g.plies.length : S.viewPly; }

function bottomColor(): Color {
    const g = S.game;
    const base: Color = (g && myColorIn(g)) || 'w';
    return S.flipped ? opposite(base) : base;
}

function renderBoard(): void {
    const g = S.game;
    board.setOrientation(bottomColor());
    const ply = g ? viewPly(g) : 0;
    const pos = new Chess(g ? g.fenAt(ply) : undefined);
    const pieces = new Map<string, { type: PieceType; color: Color }>();
    for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) {
        const p = pos.get(f + r);
        if (p) pieces.set(f + r, p);
    }
    const last = g && ply > 0 ? g.plies[ply - 1] : null;
    const checkSq = pos.inCheck() ? pos.kingSquare(pos.turnColor()) : null;
    const isLive = !!g && ply === g.plies.length;
    const mateSq = isLive && g!.over && g!.reason === 'checkmate' ? checkSq : null;
    const mine = myColorIn(g);
    const movable = g && isLive && !g.over && mine && g.turn === mine && !(g.kind === 'computer' && S.aiThinking) ? mine : null;
    const dests: BoardState['dests'] = new Map();
    if (movable && g) {
        for (const m of g.chess.movesFrom()) {
            const list = dests.get(m.from) || [];
            list.push({ to: m.to, promotion: m.promotion });
            dests.set(m.from, list);
        }
    }
    board.render({ pieces, lastMove: last ? { from: last.from, to: last.to } : null,
        hint: hint?.move ?? null, checkSquare: checkSq, mateSquare: mateSq, movable, dests });
    $('#board-wrap').classList.toggle('history', !!g && !isLive);
}

function modeLabel(g: GameRecord | null): string {
    if (!g) return '';
    if (g.kind === 'imported') return `Read-only • <span class="accent">IMPORTED PGN</span>`;
    if (g.kind === 'puzzle') {
        const themes = g.pgnTags.Themes?.split(/\s+/).map(puzzleThemeLabel).join(' · ');
        return `Lichess random • <span class="accent">PUZZLES</span>${themes ? `<br>${esc(themes)}` : ''}`;
    }
    if (g.kind === 'computer') return `Unlimited • Casual • <span class="accent">VS COMPUTER</span>`;
    if (g.kind === 'tournament') return `5+0 • Arena • <span class="accent">TOURNAMENT</span>`;
    return `5+0 • Casual • <span class="accent">NETWORK</span>`;
}

function gameStatusText(g: GameRecord): string {
    if (g.kind === 'puzzle') return g.over ? 'Puzzle solved!' : 'Find the next move in the puzzle solution';
    if (g.kind === 'imported' && !g.result) return 'Unfinished game • Review only';
    if (g.over) return describeResult(g.result, g.reason);
    const mine = myColorIn(g);
    if (g.kind === 'computer' && S.aiThinking) return 'Computer is thinking…';
    if (mine) return g.turn === mine ? 'Your turn' : `Waiting for ${g.player(g.turn).name}`;
    return `${g.turn === 'w' ? 'White' : 'Black'} to move`;
}

function renderGameInfo(): void {
    const g = S.game;
    const t = S.tour;
    let html = '';
    if (g) {
        const iconKind = g.kind === 'tournament' ? 'trophy' : g.kind === 'computer' ? 'cpu' : 'net';
        html += `<div class="gi-head"><div class="gi-icon ${iconKind}"></div><div>
            <div class="gi-mode">${modeLabel(g)}</div><div class="gi-time">${esc(timeAgo(g.startTs))}</div></div></div>
            <div class="gi-players">
                <div class="gi-player"><span class="side-dot w"></span>${esc(g.white.name)}</div>
                <div class="gi-player"><span class="side-dot b"></span>${esc(g.black.name)}</div>
            </div>
            <div class="gi-status">${esc(gameStatusText(g))}</div>`;
    } else {
        const hint = S.mode === 'computer' ? 'Start a game against the computer.'
            : S.mode === 'puzzles' ? (puzzleRequest ? 'Loading Lichess puzzle from chess coach…' : 'Load a random Lichess puzzle.')
            : S.mode === 'network' ? 'Pick a connected peer to challenge.' : 'Start or join an arena tournament.';
        html += `<div class="gi-head"><div class="gi-icon net"></div><div><div class="gi-mode">Welcome, ${esc(me.name)}</div>
            <div class="gi-time">${esc(hint)}</div></div></div>`;
        if (S.mode === 'computer') html += '<button class="btn primary wide" data-action="computer-setup">Play vs computer</button>';
    }
    if (t && (T.isActive(t) || t.players[me.addr])) {
        const left = t.status === 'running' ? formatDuration(T.endTs(t) - now()) : t.status === 'finishing' ? 'Finishing' : 'Finished';
        html += `<div class="gi-tour"><button class="link" data-action="standings">🏆 ${esc(t.name)}</button>
            <div class="gi-countdown" id="tour-countdown">${left}</div></div>`;
    }
    $('#game-info').innerHTML = html;
}

function pocketHtml(color: Color, g: GameRecord | null): string {
    const counts = g ? g.capturedBy(color, viewPly(g)) : { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    const captured = opposite(color);
    let diff = 0;
    if (g) {
        const pos = new Chess(g.fenAt(viewPly(g)));
        const val: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
        for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) {
            const p = pos.get(f + r);
            if (p) diff += (p.color === color ? 1 : -1) * val[p.type];
        }
    }
    const cells = (['p', 'n', 'b', 'r', 'q'] as PieceType[]).map((t) => `<div class="pocket-piece ${counts[t] ? '' : 'empty'}"
        style="background-image:url('${pieceUrl(t, captured)}')">${counts[t] ? `<span class="count">${counts[t]}</span>` : ''}</div>`).join('');
    return `<div class="pocket">${cells}${diff > 0 ? `<span class="material">+${diff}</span>` : ''}</div>`;
}

function playerMeta(g: GameRecord, ref: PlayerRef): string {
    const t = S.tour;
    if (g.kind === 'tournament' && t && t.id === g.tourId && t.players[ref.addr]) {
        const p = t.players[ref.addr];
        return `${p.streak >= 2 ? '🔥 ' : ''}${p.score} pts`;
    }
    if (g.kind === 'puzzle') return '';
    if (ref.addr === AI_ADDR) return `Level ${g.level}`;
    return '';
}

function renderPlayerBlock(pos: 'top' | 'bottom'): void {
    const g = S.game;
    const color: Color = pos === 'bottom' ? bottomColor() : opposite(bottomColor());
    const node = $(`#player-${pos}`);
    if (!g) {
        node.innerHTML = '';
        node.classList.add('empty');
        return;
    }
    node.classList.remove('empty');
    const ref = g.player(color);
    const online = ref.addr === AI_ADDR || isOnline(ref.addr);
    const running = !g.over && g.turn === color && g.timed;
    node.innerHTML = `${pocketHtml(color, g)}
        ${g.timed ? `<div class="clock ${running ? 'running' : ''}" data-color="${color}"><span class="time">${formatClock(g.remaining(color, now()))}</span></div>` : ''}
        <div class="player-line ${g.turn === color && !g.over ? 'to-move' : ''}">
            <span class="status-dot ${online ? 'online' : ''}"></span>
            <span class="name">${esc(ref.name)}${ref.addr === me.addr ? ' <span class="dim">(you)</span>' : ''}</span>
            <span class="meta">${esc(playerMeta(g, ref))}</span>
        </div>`;
}

function updateClocks(): void {
    const g = S.game;
    if (!g || !g.timed) return;
    document.querySelectorAll<HTMLElement>('.clock[data-color]').forEach((el) => {
        const color = el.dataset.color as Color;
        const ms = g.remaining(color, now());
        el.querySelector('.time')!.textContent = formatClock(ms);
        el.classList.toggle('running', !g.over && g.turn === color);
        el.classList.toggle('low', ms < 30000);
    });
}

function renderMoves(): void {
    const g = S.game;
    const list = $('#moves');
    if (!g) { list.innerHTML = '<div class="moves-empty dim">No game in progress</div>'; return; }
    const cur = viewPly(g);
    let html = '';
    const offset = g.startFen.split(' ')[1] === 'b' ? 1 : 0;
    for (let slot = 0; g.plies.length > 0 && slot < g.plies.length + offset; slot += 2) {
        const i = slot - offset;
        const w = g.plies[i], b = g.plies[i + 1];
        html += `<div class="move-row"><span class="move-no">${g.moveNumberAt(Math.max(0, i))}</span>
            ${w ? `<button class="move ${cur === i + 1 ? 'active' : ''}" data-ply="${i + 1}">${esc(w.san)}</button>` : '<span></span>'}
            ${b ? `<button class="move ${cur === i + 2 ? 'active' : ''}" data-ply="${i + 2}">${esc(b.san)}</button>` : '<span></span>'}</div>`;
    }
    if (g.over) {
        html += `<div class="result-box"><div class="result-score">${esc((g.result || '').replace('1/2-1/2', '½-½'))}</div>
            <div class="result-text">${esc(describeResult(g.result, g.reason))}</div></div>`;
    }
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = html || '<div class="moves-empty dim">No moves yet</div>';
    const active = list.querySelector<HTMLElement>('.move.active');
    if (S.viewPly === null && atBottom) list.scrollTop = list.scrollHeight;
    else if (active) active.scrollIntoView({ block: 'nearest' });
}

function button(label: string, action: string, kind = 'secondary', disabled = false): string {
    return `<button class="btn ${kind}" data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
}

function puzzleTypeSelect(disabled: boolean): string {
    return `<select class="duration-select puzzle-type-select" data-puzzle-type aria-label="Puzzle type" ${disabled ? 'disabled' : ''}>${
        PUZZLE_TYPES.map((t) => `<option value="${esc(t.value)}" ${prefs.puzzleType === t.value ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
}

let lastActionsHtml: string | null = null;

function renderActions(): void {
    const g = S.game;
    const mine = myColorIn(g);
    let html = '';
    if (!g) {
        if (S.mode === 'computer') html = button('New game vs computer', 'computer-setup', 'primary');
        else if (S.mode === 'puzzles') html = puzzleTypeSelect(!!puzzleRequest)
            + button(puzzleRequest ? 'Loading puzzle…' : 'Load puzzle', 'puzzle', 'primary', !!puzzleRequest || !coachAvailable());
        else if (S.mode === 'network') html = `<p class="dim center">Choose a peer in the <b>Peers</b> tab to challenge.</p>`;
        else html = tourActionsHtml();
    } else if (g.kind === 'puzzle') {
        html = `<p class="dim center">${g.over ? 'Puzzle solved!' : 'Play the solution. Incorrect moves leave the position unchanged.'}</p>`
            + puzzleTypeSelect(false) + button('Next puzzle', 'puzzle', 'primary', !coachAvailable()) + button('Close puzzle', 'leave');
        if (puzzleContinuation(g, me.addr)) {
            html += button('CONTINUE PLAYING', 'puzzle-continue', 'primary', S.viewPly !== null || isBusy());
        }
        if (!g.over) {
            html += button(hint && !hint.move ? 'Finding hint…' : 'Hint', 'hint', 'secondary',
                !!hint && !hint.move || !coachAvailable() || !canRequestHint(g, mine, S.viewPly !== null, S.aiThinking));
        }
    } else if (g.kind === 'imported') {
        html = `<p class="dim center">Imported game • Review only</p>${button('Play from here', 'play-from-here', 'primary')}${button('Import another PGN', 'import-pgn')}${button('Close game', 'leave')}`;
    } else if (!mine) {
        html = `<p class="dim center">Spectating</p>${button('Stop watching', 'leave')}`;
    } else if (g.kind === 'computer') {
        html = g.over
            ? button('Play again', 'computer-again', 'primary') + button('New game…', 'computer-setup')
            : button('Takeback', 'takeback', 'secondary', S.aiThinking || !g.plies.length) + button('Resign', 'resign', 'danger') + button('New game…', 'computer-setup');
        if (g.learnerMode && !g.over) {
            html += button(hint && !hint.move ? 'Finding hint…' : 'Hint', 'hint', 'secondary',
                !!hint && !hint.move || !canRequestHint(g, mine, S.viewPly !== null, S.aiThinking));
        }
    } else if (!g.over) {
        if (g.drawOffer && g.drawOffer !== me.addr) {
            html = `<p class="center offer">${esc(g.player(opposite(mine)).name)} offers a draw</p>`
                + button('Accept draw', 'draw', 'primary') + button('Decline', 'decline-draw');
        } else {
            html = button(g.drawOffer === me.addr ? 'Draw offered' : 'Offer draw', 'draw', 'secondary', g.drawOffer === me.addr);
        }
        html += button('Resign', 'resign', 'danger');
    } else if (g.kind === 'network') {
        html = button('Rematch', 'rematch', 'primary', isBusy() || !!S.outgoing) + button('Back to lobby', 'leave');
    } else {
        html = tourActionsHtml();
    }
    // Skip identical re-renders so an open puzzle-type dropdown isn't closed by unrelated updates.
    if (html === lastActionsHtml) return;
    lastActionsHtml = html;
    $('#actions').innerHTML = html;
}

function tourActionsHtml(): string {
    const t = S.tour;
    if (!t || !T.isActive(t)) return button('Start a tournament', 'tour-create', 'primary', isBusy());
    const p = t.players[me.addr];
    if (!p || p.withdrawn) {
        return t.status === 'running' ? button(p ? 'Rejoin tournament' : 'Join tournament', 'tour-join', 'primary', !!myActiveNetworkGame())
            : '<p class="dim center">Tournament is finishing…</p>';
    }
    const myGame = p.currentGame ? S.games.get(p.currentGame) : null;
    if (myGame && !myGame.over) {
        return (S.game === myGame ? '<p class="dim center">Game in progress</p>' : button('Back to my game', `goto-game:${myGame.id}`, 'primary'))
            + button('Withdraw', 'tour-withdraw', 'danger');
    }
    const waiting = t.status === 'running' ? '<p class="center waiting"><span class="spinner"></span>Waiting for the next pairing…</p>'
        : '<p class="dim center">Tournament is finishing — no new pairings.</p>';
    return waiting + button('Standings', 'standings') + button('Withdraw', 'tour-withdraw', 'danger');
}

function statusText(p: Peer): string {
    switch (p.status) {
        case 'playing': return p.opp ? `playing vs ${p.opp}` : 'playing';
        case 'tournament': return 'in tournament';
        case 'computer': return 'playing the computer';
        default: return 'available';
    }
}

function renderPeers(): void {
    const node = $('#tab-peers');
    const peers = onlinePeers();
    $('#peer-count').textContent = peers.length ? String(peers.length) : '';
    if (!net.available) {
        node.innerHTML = '<p class="dim pad">Offline mode. Share this app in a Delta Chat (or other webxdc) chat to play with others.</p>';
        return;
    }
    const busy = isBusy();
    const rows = peers.map((p) => {
        const available = p.status === 'idle' || p.status === 'computer';
        let act = '';
        if (available && !busy && !S.outgoing) act = `<button class="btn small primary" data-challenge="${esc(p.addr)}">Challenge</button>`;
        else if (p.status === 'playing' && p.gameId && S.games.has(p.gameId) && S.game?.id !== p.gameId) act = `<button class="btn small" data-watch="${esc(p.gameId)}">Watch</button>`;
        return `<li class="peer ${available && !busy ? 'clickable' : ''}" ${available && !busy ? `data-challenge="${esc(p.addr)}"` : ''}>
            <span class="status-dot online ${p.status}"></span>
            <div class="peer-main"><div class="peer-name">${esc(p.name)}</div><div class="peer-status">${esc(statusText(p))}</div></div>${act}</li>`;
    }).join('');
    node.innerHTML = `<ul class="peer-list">
        <li class="peer self"><span class="status-dot online"></span><div class="peer-main"><div class="peer-name">${esc(me.name)} <span class="dim">(you)</span></div>
        <div class="peer-status">${esc(statusText({ addr: me.addr, name: me.name, status: myStatus(), gameId: null, tourId: null, opp: null, lastSeen: 0 }))}</div></div></li>
        ${rows}</ul>${peers.length ? '' : '<p class="dim pad">No other peers connected. Peers appear here when they open this app in the same chat.</p>'}`;
}

function renderChat(): void {
    const lines = $('#chat-lines');
    const atBottom = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 30;
    lines.innerHTML = chat.lines.map((c) => `<div class="chat-line ${c.from === me.addr ? 'mine' : ''}">
        <span class="chat-name">${esc(c.name)}</span> <time class="chat-time" datetime="${new Date(c.ts).toISOString()}">${esc(new Date(c.ts).toLocaleString())}</time>
        <span class="chat-text">${esc(c.text)}</span></div>`).join('')
        || '<p class="dim pad">No messages yet.</p>';
    if (atBottom) lines.scrollTop = lines.scrollHeight;
    const badge = $('#chat-unread');
    badge.textContent = S.unreadChat ? String(S.unreadChat) : '';
    ($('#chat-input') as HTMLInputElement).disabled = !net.available;
}

function renderStandings(): void {
    const node = $('#tab-standings');
    const t = S.tour;
    if (!t) {
        node.innerHTML = `<p class="dim pad">No tournament yet.</p><div class="pad">${button('Start a tournament', 'tour-create', 'primary', isBusy() || !net.available)}</div>`;
        return;
    }
    const left = t.status === 'running' ? `${formatDuration(T.endTs(t) - now())} left` : t.status === 'finishing' ? 'finishing' : 'finished';
    const st = T.standings(t);
    const rows = st.map((p) => {
        const results = p.results.slice(-12).map((r) => `<span class="r-${r}">${r === 'W' ? '1' : r === 'D' ? '½' : '0'}</span>`).join('');
        const playing = p.currentGame ? ` <button class="link small" data-watch="${esc(p.currentGame)}" title="Watch">⚔</button>` : '';
        return `<tr class="${p.addr === me.addr ? 'me' : ''} ${p.withdrawn ? 'withdrawn' : ''}">
            <td class="rank">${p.rank}</td>
            <td class="pname">${p.onFire ? '🔥 ' : ''}${esc(p.name)}${p.addr === t.host ? ' <span class="badge">host</span>' : ''}${playing}</td>
            <td class="results">${results}</td><td class="score">${p.score}</td></tr>`;
    }).join('');
    node.innerHTML = `<div class="tour-head"><div><div class="tour-name">🏆 ${esc(t.name)}</div>
        <div class="dim small">${st.length} players • ${left}</div></div></div>
        <table class="standings"><tbody>${rows}</tbody></table>
        <div class="pad">${T.isActive(t) ? tourActionsHtml() : ''}</div>`;
}

function renderCrosstable(): void {
    const g = S.game;
    const node = $('#crosstable');
    if (!g || g.kind === 'computer' || g.kind === 'imported' || g.kind === 'puzzle') { node.innerHTML = ''; node.hidden = true; return; }
    const a = g.white, b = g.black;
    const games = [...S.games.values()].filter((x) => x.over && x.result && x.reason !== 'aborted'
        && ((x.white.addr === a.addr && x.black.addr === b.addr) || (x.white.addr === b.addr && x.black.addr === a.addr)))
        .sort((x, y) => x.startTs - y.startTs).slice(-12);
    if (!games.length) { node.innerHTML = ''; node.hidden = true; return; }
    const pts = (x: GameRecord, addr: string): number => x.result === '1/2-1/2' ? 0.5
        : (x.result === '1-0') === (x.white.addr === addr) ? 1 : 0;
    const fmt = (n: number): string => n === 0.5 ? '½' : String(n).replace('.5', '½');
    const row = (p: PlayerRef): string => {
        const cells = games.map((x) => { const v = pts(x, p.addr); return `<td class="p${v * 2}">${fmt(v)}</td>`; }).join('');
        const total = games.reduce((s, x) => s + pts(x, p.addr), 0);
        return `<tr>${cells}<td class="ct-name">${esc(p.name)}</td><td class="ct-total">${fmt(total)}</td></tr>`;
    };
    node.hidden = false;
    node.innerHTML = `<table>${row(a)}${row(b)}</table>`;
}

function renderModes(): void {
    document.querySelectorAll<HTMLButtonElement>('.modes [data-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === S.mode);
        if (b.dataset.mode === 'puzzles') b.hidden = !coachAvailable();
    });
    const tourBtn = document.querySelector<HTMLElement>('.modes [data-mode=tournament] .mode-badge');
    if (tourBtn) tourBtn.hidden = !(S.tour && T.isActive(S.tour) && !S.tour.players[me.addr]);
    $('#sound-toggle').classList.toggle('muted', sounds.muted);
    $('#sound-toggle').title = sounds.muted ? 'Sound off' : 'Sound on';
    document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    for (const tab of ['peers', 'chat', 'standings'] as Tab[]) $(`#tab-${tab}`).hidden = S.tab !== tab;
}

function renderNav(): void {
    const g = S.game;
    const ply = g ? viewPly(g) : 0;
    const len = g ? g.plies.length : 0;
    document.querySelectorAll<HTMLButtonElement>('.controls [data-nav]').forEach((b) => {
        const nav = b.dataset.nav;
        b.disabled = !g || ((nav === 'first' || nav === 'prev') && ply === 0) || ((nav === 'next' || nav === 'last') && ply === len);
    });
}

function render(): void {
    if (puzzleRequest && (S.mode !== 'puzzles' || S.game)) cancelPuzzleRequest();
    refreshHint();
    renderModes();
    renderGameInfo();
    renderBoard();
    renderPlayerBlock('top');
    renderPlayerBlock('bottom');
    updateClocks();
    renderNav();
    renderMoves();
    renderActions();
    renderPeers();
    renderChat();
    renderStandings();
    renderCrosstable();
}

// ---------------------------------------------------------------- periodic work

function tick(): void {
    const ts = now();
    for (const g of S.games.values()) {
        if (g.over || !g.timed || net.replaying) continue;
        if (g.pending.size) continue;
        const mine = g.colorOf(me.addr);
        if (!mine) continue;
        const side = g.turn;
        const rem = g.remaining(side, ts);
        if (rem <= 0 && (side === mine || rem <= -FLAG_GRACE_MS)) {
            finishGame(g, g.timeoutResult(side), 'time out', { announce: true });
        } else if (g === S.game && side === mine && rem < 10000 && ts - S.lastLowTimeBeep > 1000 && !document.hidden) {
            S.lastLowTimeBeep = ts;
            sounds.play('low');
        }
    }
    updateClocks();
    const cd = document.getElementById('tour-countdown');
    if (cd && S.tour?.status === 'running') cd.textContent = formatDuration(T.endTs(S.tour) - ts);
}

function slowTick(): void {
    if (availableCoach && !coachAvailable()) {
        availableCoach = null;
        scheduleRender();
    }
    sendPresence(false);
    tournamentLoop();
    if (!net.replaying) {
        for (const g of S.games.values()) if (!g.over && (g.pending.size || g.pendingEnd)) requestSync(g);
        pruneCompletedGames(S.games, S.game);
        for (const [addr, peer] of S.peers) {
            if (now() - peer.lastSeen >= peerTimeout()) S.peers.delete(addr);
        }
        for (const [cid, c] of S.challenges) {
            // Keep terminal challenges briefly so late acceptances can still be aborted.
            if (now() - c.ts <= CHALLENGE_TTL_MS * 2) continue;
            S.challenges.delete(cid);
            if (S.outgoing === cid) S.outgoing = null;
            modals.close(`challenge-in-${cid}`);
            modals.close(`challenge-out-${cid}`);
        }
    }
    // Refresh peers list as entries go stale.
    const count = onlinePeers().length;
    if (String(count || '') !== $('#peer-count').textContent) scheduleRender();
}

// ---------------------------------------------------------------- events

function bindEvents(): void {
    document.querySelectorAll<HTMLButtonElement>('.modes [data-mode]').forEach((b) =>
        b.addEventListener('click', () => selectMode(b.dataset.mode as Mode)));
    document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
        S.tab = b.dataset.tab as Tab;
        if (S.tab === 'chat') S.unreadChat = 0;
        render();
        if (S.tab === 'chat') { const l = $('#chat-lines'); l.scrollTop = l.scrollHeight; }
    }));
    $('#sound-toggle').addEventListener('click', toggleSound);
    $('#chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chat-input') as HTMLInputElement;
        const text = input.value.trim().slice(0, 300);
        if (!text || !net.available) return;
        net.send({ type: 'chat', text }, { persist: true });
        input.value = '';
    });
    document.querySelectorAll<HTMLButtonElement>('.controls [data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav!)));
    $('#btn-flip').addEventListener('click', () => { S.flipped = !S.flipped; render(); });
    $('#btn-menu').addEventListener('click', openMenu);
    $('#moves').addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ply]');
        if (!btn || !S.game) return;
        const ply = Number(btn.dataset.ply);
        S.viewPly = ply === S.game.plies.length ? null : ply;
        render();
    });
    $('#actions').addEventListener('change', (e) => {
        const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-puzzle-type]');
        if (!select || !validPuzzleType(select.value)) return;
        prefs.puzzleType = select.value;
        savePrefs();
    });
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
        if (action) { runAction(action); return; }
        const watch = target.closest<HTMLElement>('[data-watch]')?.dataset.watch;
        if (watch) { watchGame(watch); return; }
        const challenge = target.closest<HTMLElement>('[data-challenge]')?.dataset.challenge;
        if (challenge) {
            const peer = S.peers.get(challenge);
            if (peer) openChallengeDialog(peer);
        }
    });
    document.addEventListener('keydown', (e) => {
        if ((e.target as HTMLElement).closest('input, textarea, select') || document.querySelector('.modal')) return;
        if (e.key === 'ArrowLeft') navigate('prev');
        else if (e.key === 'ArrowRight') navigate('next');
        else if (e.key === 'ArrowUp' || e.key === 'Home') navigate('first');
        else if (e.key === 'ArrowDown' || e.key === 'End') navigate('last');
        else if (e.key === 'f') { S.flipped = !S.flipped; render(); }
    });
    window.addEventListener('pagehide', () => {
        cancelPuzzleRequest();
        clearHint();
        const g = myActiveNetworkGame();
        const result = g ? exitForfeitResult(g, me.addr) : null;
        if (g && result && !net.replaying) {
            finishGame(g, result, 'forfeit', { announce: true });
        }
        if (net.available) net.send({ type: 'bye', gameId: g?.id ?? null });
        net.leave();
    });
}

function navigate(nav: string): void {
    const g = S.game;
    if (!g) return;
    const len = g.plies.length;
    let ply = viewPly(g);
    if (nav === 'first') ply = 0;
    else if (nav === 'prev') ply = Math.max(0, ply - 1);
    else if (nav === 'next') ply = Math.min(len, ply + 1);
    else ply = len;
    S.viewPly = ply === len ? null : ply;
    render();
}

function runAction(action: string): void {
    if (action.startsWith('goto-game:')) { watchGame(action.slice('goto-game:'.length)); return; }
    switch (action) {
        case 'puzzle': requestPuzzle(); break;
        case 'puzzle-continue': continuePuzzle(); break;
        case 'hint': requestHint(); break;
        case 'import-pgn': openPgnImport(); break;
        case 'play-from-here': {
            const g = S.game;
            if (g?.kind === 'imported') openComputerSetup(g.fenAt(viewPly(g)));
            break;
        }
        case 'computer-setup': openComputerSetup(); break;
        case 'computer-again': {
            const g = S.game;
            startComputerGame(prefs.color, g?.level || prefs.level);
            break;
        }
        case 'takeback': takeBack(); break;
        case 'resign': confirmResign(); break;
        case 'draw': offerDraw(); break;
        case 'decline-draw': declineDraw(); break;
        case 'rematch': rematch(); break;
        case 'leave': leaveGame(); break;
        case 'standings': S.tab = 'standings'; render(); break;
        case 'tour-create': selectMode('tournament'); break;
        case 'tour-join': joinTournament(); break;
        case 'tour-withdraw': withdrawFromTournament(); break;
    }
}

// ---------------------------------------------------------------- startup

function afterReplay(): void {
    const ts = now();
    const mine = [...S.games.values()].filter((g) => !g.over && g.colorOf(me.addr)).sort((a, b) => b.startTs - a.startTs);
    if (mine[0]) {
        S.game = mine[0];
        S.mode = mine[0].kind === 'tournament' ? 'tournament' : 'network';
    } else {
        const saved = loadJson<SavedComputerGame | null>(STORAGE_COMPUTER, null);
        if (saved && Array.isArray(saved.moves)) startComputerGame(saved.myColor, saved.level, saved);
    }
    if (inActiveTournament()) S.mode = 'tournament';
    for (const c of S.challenges.values()) {
        if (c.state !== 'pending' || ts - c.ts > CHALLENGE_TTL_MS) continue;
        if (c.to === me.addr) presentIncomingChallenge(c);
        else if (c.from === me.addr) net.send({ type: 'challenge-cancel', cid: c.cid }, { persist: true });
    }
    const t = S.tour;
    if (t && t.status === 'running' && (!t.players[me.addr]) && !myActiveNetworkGame()) inviteToTournament(t);
    if (t && t.host === me.addr && S.tourDirty) broadcastTour(true);
}

async function main(): Promise<void> {
    bindEvents();
    $('#version').textContent = window.APP_VERSION ? `v${window.APP_VERSION}` : '';
    render();
    await net.start(handleMessage);
    afterReplay();
    if (net.available) {
        net.send({ type: 'hello' });
        sendPresence(true);
        probeChessCoach(S.game ?? undefined);
        setInterval(() => probeChessCoach(), 15_000);
    }
    render();
    setInterval(tick, 200);
    setInterval(slowTick, 1000);
    setInterval(() => { if (S.game && !document.hidden) renderGameInfo(); }, 30000);
}

void main();
