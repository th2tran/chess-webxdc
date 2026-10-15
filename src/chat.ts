export interface ChatLine { id: string; from: string; name: string; text: string; ts: number; }

export const MAX_CHAT_MESSAGES = 100;
export const STORAGE_CHAT = 'chess-xdc:chat';

function isChatLine(value: unknown): value is ChatLine {
    if (!value || typeof value !== 'object') return false;
    const line = value as Partial<ChatLine>;
    return typeof line.id === 'string' && typeof line.from === 'string'
        && typeof line.name === 'string' && typeof line.text === 'string'
        && !!line.text.trim() && typeof line.ts === 'number'
        && Number.isFinite(new Date(line.ts).getTime());
}

function latest(lines: ChatLine[]): ChatLine[] {
    return [...new Map(lines.map((line) => [line.id, line])).values()]
        .sort((a, b) => a.ts - b.ts).slice(-MAX_CHAT_MESSAGES);
}

export class ChatHistory {
    private messages: ChatLine[] = [];

    constructor() {
        try {
            const raw = localStorage.getItem(STORAGE_CHAT);
            if (raw === null) return;
            const saved: unknown = JSON.parse(raw);
            if (!Array.isArray(saved) || !saved.every(isChatLine)) {
                throw new Error('Invalid saved chat history');
            }
            this.messages = latest(saved);
            this.save();
        } catch (err) {
            console.warn('chess: could not restore chat history', err);
        }
    }

    get lines(): readonly ChatLine[] { return this.messages; }

    add(line: ChatLine): boolean {
        if (!isChatLine(line)) {
            console.warn('chess: ignoring invalid chat message');
            return false;
        }
        if (this.messages.some((message) => message.id === line.id)) return false;
        const messages = latest([...this.messages, line]);
        if (!messages.includes(line)) return false;
        this.messages = messages;
        this.save();
        return true;
    }

    private save(): void {
        try {
            localStorage.setItem(STORAGE_CHAT, JSON.stringify(this.messages));
        } catch (err) {
            console.warn('chess: could not save chat history', err);
        }
    }
}
