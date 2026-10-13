/* Web Worker entry: {id, startFen, moves:[uci], level} -> {id, uci} */
import { Chess } from './engine.ts';
import { bestMove } from './ai.ts';

export interface AiRequest { id: number; startFen: string; moves: string[]; level: number; }
export interface AiResponse { id: number; uci: string | null; error?: string; }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<AiRequest>) => void) | null; postMessage(msg: AiResponse): void };

ctx.onmessage = (e) => {
    const { id, startFen, moves, level } = e.data;
    try {
        const c = new Chess(startFen);
        for (const uci of moves) c.move(uci);
        const res = bestMove(c, level);
        ctx.postMessage({ id, uci: res ? res.uci : null });
    } catch (err) {
        ctx.postMessage({ id, uci: null, error: String(err instanceof Error ? err.message : err) });
    }
};
