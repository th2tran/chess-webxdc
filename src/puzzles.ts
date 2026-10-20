import { Chess, type Color } from './engine.ts';
import { GameRecord } from './game.ts';
import type { MessageOf, PlayerRef } from './net.ts';
import { importPgn, PgnError } from './pgn.ts';

const THEME_LABELS: Record<string, string> = {
    mate: 'Checkmate',
    mateIn1: 'Mate in 1',
    mateIn2: 'Mate in 2',
    mateIn3: 'Mate in 3',
    mateIn4: 'Mate in 4',
    mateIn5: 'Mate in 5 or more',
    oneMove: 'One-move puzzle',
    short: 'Short puzzle',
    long: 'Long puzzle',
    veryLong: 'Very long puzzle',
    anastasiaMate: "Anastasia's mate",
    arabianMate: 'Arabian mate',
    backRankMate: 'Back-rank mate',
    bodenMate: "Boden's mate",
    dovetailMate: 'Dovetail mate',
    hookMate: 'Hook mate',
    smotheredMate: 'Smothered mate',
    doubleBishopMate: 'Double-bishop mate',
    kingsideAttack: 'Kingside attack',
    queensideAttack: 'Queenside attack',
    xRayAttack: 'X-ray attack',
    zugzwang: 'Zugzwang (forced-move disadvantage)',
    zwischenzug: 'Intermediate move',
    intermezzo: 'Intermediate move',
    enPassant: 'En passant',
    underPromotion: 'Underpromotion',
    master: 'Master game',
    masterVsMaster: 'Master vs. master',
    superGM: 'Super-GM game',
};

/** Puzzle types the chess coach can filter by; values are Lichess theme tags ('' = any). */
export const PUZZLE_TYPES: readonly { value: string; label: string }[] = [
    { value: '', label: 'Any puzzle' },
    { value: 'mateIn1', label: 'Mate in 1' },
    { value: 'mateIn2', label: 'Mate in 2' },
    { value: 'mateIn3', label: 'Mate in 3' },
    { value: 'mateIn4', label: 'Mate in 4' },
    { value: 'mateIn5', label: 'Mate in 5 or more' },
    { value: 'oneMove', label: 'Find the best move' },
    { value: 'fork', label: 'Fork' },
    { value: 'pin', label: 'Pin' },
    { value: 'skewer', label: 'Skewer' },
    { value: 'discoveredAttack', label: 'Discovered attack' },
    { value: 'sacrifice', label: 'Sacrifice' },
    { value: 'deflection', label: 'Deflection' },
    { value: 'backRankMate', label: 'Back-rank mate' },
    { value: 'endgame', label: 'Endgame' },
];

export function validPuzzleType(value: unknown): value is string {
    return typeof value === 'string' && PUZZLE_TYPES.some((t) => t.value === value);
}

export function puzzleThemeLabel(theme: string): string {
    if (Object.hasOwn(THEME_LABELS, theme)) return THEME_LABELS[theme];
    const words = theme.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

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

export function puzzleContinuation(game: GameRecord, addr: string): { color: Color; startFen: string } | null {
    const color = game.colorOf(addr);
    if (game.kind !== 'puzzle' || !game.over || game.reason !== 'puzzle solved' ||
        !color || game.status().over) return null;
    return { color, startFen: game.chess.fen() };
}

export class Puzzle {
    readonly game: GameRecord;
    private readonly solution: string[];

    constructor(pgn: string, id: string, player: PlayerRef, at = Date.now(), themes?: string[]) {
        if (themes !== undefined && (!Array.isArray(themes) || themes.length > 100 ||
            themes.some(theme => typeof theme !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(theme)))) {
            throw new PgnError('Chess coach returned invalid puzzle themes.');
        }
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
            pgnTags: {
                Event: 'Lichess random puzzle',
                ...(imported.pgnTags.Site ? { Site: imported.pgnTags.Site } : {}),
                ...(themes?.length ? { Themes: [...new Set(themes)].join(' ') } : {})
            }
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
