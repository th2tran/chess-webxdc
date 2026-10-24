import { Chess, type GameResult } from './engine.ts';
import { GameRecord } from './game.ts';

export const MAX_PGN_LENGTH = 100000;
const MAX_PGN_PLIES = 2048;
const RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];

export class PgnError extends Error {}

function validateFen(fen: string): string {
    const fields = fen.trim().split(/\s+/);
    if (fields.length !== 6 || !/^[prnbqkPRNBQK1-8/]+$/.test(fields[0])
        || !/^[wb]$/.test(fields[1]) || !/^(?:-|K?Q?k?q?)$/.test(fields[2])
        || !/^(?:-|[a-h][36])$/.test(fields[3])
        || !/^\d+$/.test(fields[4]) || !/^[1-9]\d*$/.test(fields[5])
        || !Number.isSafeInteger(Number(fields[4])) || !Number.isSafeInteger(Number(fields[5]))
        || (fields[0].match(/K/g) || []).length !== 1 || (fields[0].match(/k/g) || []).length !== 1
        || /[pP]/.test(fields[0].split('/')[0] + fields[0].split('/')[7])) {
        throw new PgnError('Invalid FEN starting position.');
    }
    try {
        return new Chess(fen).fen();
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new PgnError(`Invalid FEN starting position: ${error.message}`);
    }
}

/** Keep main-line moves and comments, ignoring recursive annotation variations. */
function mainLine(text: string): { kind: 'move' | 'comment'; text: string }[] {
    const tokens: { kind: 'move' | 'comment'; text: string }[] = [];
    let moveText = '';
    let commentText = '';
    let variation = 0;
    let comment = false;
    let lineComment = false;
    const flushMoves = (): void => {
        for (const move of moveText.replace(/\$\d+/g, ' ').trim().split(/\s+/)) {
            if (move) tokens.push({ kind: 'move', text: move });
        }
        moveText = '';
    };
    const flushComment = (): void => {
        const normalized = commentText.replace(/\s+/g, ' ').trim();
        if (!variation && normalized) tokens.push({ kind: 'comment', text: normalized });
        commentText = '';
    };
    for (const ch of text) {
        if (lineComment) {
            if (ch === '\n' || ch === '\r') { lineComment = false; flushComment(); }
            else commentText += ch;
            continue;
        }
        if (comment) {
            if (ch === '}') { comment = false; flushComment(); }
            else commentText += ch;
            continue;
        }
        if (ch === '{') { flushMoves(); comment = true; }
        else if (ch === ';') { flushMoves(); lineComment = true; }
        else if (ch === '(') { flushMoves(); variation++; }
        else if (ch === ')') {
            if (!variation) throw new PgnError('Unexpected closing variation parenthesis.');
            variation--;
        } else if (ch === '}') throw new PgnError('Unexpected closing comment brace.');
        else if (!variation) moveText += ch;
    }
    if (comment || variation) throw new PgnError('A comment or variation is not closed.');
    if (lineComment) flushComment();
    flushMoves();
    return tokens;
}

/** Import one game or FEN position as a local, read-only record. */
export function importPgn(input: string, id: string, at = Date.now()): GameRecord {
    if (input.length > MAX_PGN_LENGTH) throw new PgnError(`PGN is too large (maximum ${MAX_PGN_LENGTH} characters).`);
    let text = input.trim().replace(/^```(?:pgn)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
    if (!text) throw new PgnError('Paste a PGN game first.');
    // Chat selections occasionally omit the first opening bracket.
    if (/^Event\s+"/.test(text)) text = '[' + text;
    const tags: Record<string, string> = {};
    while (text.startsWith('[')) {
        const tag = /^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\["\\])*)"\s*\]/.exec(text);
        if (!tag) throw new PgnError('Invalid PGN header. Use [Tag "value"] format.');
        if (Object.prototype.hasOwnProperty.call(tags, tag[1])) throw new PgnError(`Duplicate PGN header: ${tag[1]}.`);
        tags[tag[1]] = tag[2].replace(/\\(["\\])/g, '$1');
        text = text.slice(tag[0].length).trimStart();
    }
    if (tags.SetUp !== undefined && tags.SetUp !== '0' && tags.SetUp !== '1') throw new PgnError('Invalid SetUp header: use "0" or "1".');
    if (tags.SetUp === '1' && tags.FEN === undefined) throw new PgnError('SetUp "1" requires a FEN header.');
    if (tags.SetUp === '0' && tags.FEN !== undefined) throw new PgnError('A FEN header conflicts with SetUp "0".');
    const startFen = tags.FEN === undefined ? undefined : validateFen(tags.FEN);
    if (tags.Result && !RESULTS.includes(tags.Result)) throw new PgnError('Invalid result in the PGN header.');
    let startTs = at;
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(tags.Date || '')) {
        const [year, month, day] = tags.Date.split('.').map(Number);
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) startTs = date.getTime();
    }
    const g = new GameRecord({
        id, kind: 'imported', white: { addr: `${id}:white`, name: tags.White || 'White' },
        black: { addr: `${id}:black`, name: tags.Black || 'Black' }, tc: 0, startTs, pgnTags: tags, startFen
    });
    let marker: string | null = null;
    const tokens = mainLine(text);
    for (const token of tokens) {
        if (token.kind === 'comment') {
            const comments = g.plies.length ? (g.plies[g.plies.length - 1].comments ??= []) : g.initialComments;
            comments.push(token.text);
            continue;
        }
        const move = token.text.replace(/^\d+\.(?:\.\.)?/, '');
        if (!move || move === '...' || /^[!?]+$/.test(move) || move === 'e.p.') continue;
        if (marker) throw new PgnError('Unexpected text after the result. Import one game at a time.');
        if (RESULTS.includes(move)) { marker = move; continue; }
        if (g.plies.length >= MAX_PGN_PLIES) throw new PgnError(`PGN exceeds ${MAX_PGN_PLIES} half-moves.`);
        if (g.status().over) throw new PgnError(`Move ${g.plies.length + 1} follows a finished position.`);
        if (!g.applyMove(move, null, at)) throw new PgnError(`Invalid or illegal move at half-move ${g.plies.length + 1}: ${move.slice(0, 40)}`);
    }
    if (!g.plies.length && startFen === undefined) throw new PgnError('No moves found in the PGN.');
    if (marker && tags.Result && marker !== tags.Result) throw new PgnError('The header result does not match the movetext result.');
    const declared = marker || tags.Result || '*';
    const status = g.status();
    if (status.over && declared !== '*' && declared !== status.result) throw new PgnError('The result contradicts the final board position.');
    g.result = declared === '*' ? status.result : declared as GameResult;
    g.reason = tags.Termination || (status.over ? status.reason : null);
    g.over = true;
    g.endTs = at;
    return g;
}
