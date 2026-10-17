import { Chess, type Color } from './engine.ts';
import type { GameRecord } from './game.ts';
import type { MessageOf } from './net.ts';

export function matchesCoachAvailability(
    response: MessageOf<'coach-available'>,
    pending: { requestId: string; sentAt: number },
    addr: string,
    now: number
): boolean {
    return response.to === addr && response.requestId === pending.requestId
        && now >= pending.sentAt && now - pending.sentAt <= 10_000
        && response.ts >= pending.sentAt - 5000 && response.ts <= now + 5000;
}

export function waitForCoachHint(retry: () => void, fallback: () => void): () => void {
    const interval = setInterval(retry, 2000);
    const timeout = setTimeout(() => {
        cancel();
        fallback();
    }, 30_000);
    function cancel(): void {
        clearInterval(interval);
        clearTimeout(timeout);
    }
    return cancel;
}

export function matchesHintResponse(
    response: MessageOf<'hint-response'>,
    pending: { requestId: string; gameId: string; fen: string },
    addr: string
): boolean {
    return response.to === addr && response.requestId === pending.requestId
        && response.gameId === pending.gameId && response.fen === pending.fen;
}

export function canRequestHint(g: GameRecord, player: Color | null, reviewing: boolean, aiThinking: boolean): boolean {
    return (g.kind === 'puzzle' || g.kind === 'computer' && g.learnerMode)
        && !g.over && player === g.turn && !reviewing && !aiThinking;
}

export function describeHint(fen: string, uci: string): string | null {
    const move = new Chess(fen).move(uci);
    return move ? `${move.san} (${move.from} to ${move.to}${move.promotion ? `, promote to ${move.promotion.toUpperCase()}` : ''})` : null;
}
