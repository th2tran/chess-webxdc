import { Chess, type Color } from './engine.ts';
import type { GameRecord } from './game.ts';

export function canRequestHint(g: GameRecord, player: Color | null, reviewing: boolean, aiThinking: boolean): boolean {
    return g.kind === 'computer' && g.learnerMode && !g.over && player === g.turn && !reviewing && !aiThinking;
}

export function describeHint(fen: string, uci: string): string | null {
    const move = new Chess(fen).move(uci);
    return move ? `${move.san} (${move.from} to ${move.to}${move.promotion ? `, promote to ${move.promotion.toUpperCase()}` : ''})` : null;
}
