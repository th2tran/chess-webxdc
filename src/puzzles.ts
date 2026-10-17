import { Chess } from './engine.ts';
import { GameRecord } from './game.ts';
import type { MessageOf, PlayerRef } from './net.ts';
import { importPgn, PgnError } from './pgn.ts';

export function matchesPuzzleResponse(
    response: MessageOf<'puzzle-response'>,
    pending: { requestId: string; gameId: string; coach: string; sentAt: number },
    addr: string,
    now: number
): boolean {
    return response.to === addr && response.from === pending.coach
        && response.requestId === pending.requestId && response.gameId === pending.gameId
        && now >= pending.sentAt && now - pending.sentAt <= 30_000
        && response.ts >= pending.sentAt - 5000 && response.ts <= now + 5000;
}

export class Puzzle {
    readonly game: GameRecord;
    private readonly solution: string[];

    constructor(pgn: string, id: string, player: PlayerRef, at = Date.now()) {
        const imported = importPgn(pgn, id, at);
        if (!imported.pgnTags.FEN || !imported.plies.length) {
            throw new PgnError('Puzzle requires a starting FEN and a solution.');
        }
        const color = new Chess(imported.startFen).turnColor();
        const computer = { addr: `${id}:computer`, name: 'Puzzle computer' };
        this.solution = imported.plies.map(ply => ply.uci);
        this.game = new GameRecord({
            id, kind: 'puzzle', startFen: imported.startFen, startTs: at, tc: 0,
            white: color === 'w' ? player : computer, black: color === 'b' ? player : computer,
            pgnTags: { Event: 'Chess.com random puzzle' }
        });
    }

    play(uci: string, at = Date.now()): boolean {
        const g = this.game;
        if (g.over || uci !== this.solution[g.plies.length]) return false;
        if (!g.applyMove(uci, null, at)) throw new Error('Puzzle solution contains an illegal player move.');
        const reply = this.solution[g.plies.length];
        if (reply && !g.applyMove(reply, null, at)) throw new Error('Puzzle solution contains an illegal computer move.');
        if (g.plies.length === this.solution.length) {
            g.end(g.plies[0].color === 'w' ? '1-0' : '0-1', 'puzzle solved', at);
        }
        return true;
    }
}
