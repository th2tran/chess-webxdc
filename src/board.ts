/* Interactive chessboard view: renders a position, handles click/drag input and promotion choice. */
import type { Color, Piece, PieceType } from './engine.ts';
import { pieceUrl } from './pieces.ts';

const FILES = 'abcdefgh';

export interface BoardState {
    /** piece lookup by square name */
    pieces: Map<string, Piece>;
    lastMove: { from: string; to: string } | null;
    checkSquare: string | null;
    mateSquare: string | null;
    /** Color that may currently be moved by the user (null = board is read-only). */
    movable: Color | null;
    /** Legal destinations by origin square for the movable color. */
    dests: Map<string, { to: string; promotion: PieceType | null }[]>;
}

export interface BoardCallbacks {
    onMove(from: string, to: string, promotion: PieceType | null): void;
}

export class BoardView {
    private root: HTMLElement;
    private squares = new Map<string, HTMLElement>();
    private orientation: Color = 'w';
    private state: BoardState | null = null;
    private selected: string | null = null;
    private drag: { from: string; ghost: HTMLElement | null; startX: number; startY: number; pointerId: number; wasSelected: boolean } | null = null;
    private promo: HTMLElement | null = null;

    private callbacks: BoardCallbacks;

    constructor(root: HTMLElement, callbacks: BoardCallbacks) {
        this.callbacks = callbacks;
        this.root = root;
        this.root.classList.add('board');
        this.build();
        this.root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        window.addEventListener('pointermove', (e) => this.onPointerMove(e));
        window.addEventListener('pointerup', (e) => this.onPointerUp(e));
        window.addEventListener('pointercancel', () => this.cancelDrag());
        this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    getOrientation(): Color { return this.orientation; }

    setOrientation(color: Color): void {
        if (color === this.orientation) return;
        this.orientation = color;
        this.build();
        if (this.state) this.render(this.state);
    }

    private build(): void {
        this.root.innerHTML = '';
        this.squares.clear();
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const file = this.orientation === 'w' ? col : 7 - col;
                const rank = this.orientation === 'w' ? 7 - row : row;
                const name = FILES[file] + (rank + 1);
                const sq = document.createElement('div');
                sq.className = `sq ${(file + rank) % 2 ? 'light' : 'dark'}`;
                sq.dataset.square = name;
                if (col === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank + 1}</span>`);
                if (row === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[file]}</span>`);
                const piece = document.createElement('div');
                piece.className = 'piece';
                sq.appendChild(piece);
                this.root.appendChild(sq);
                this.squares.set(name, sq);
            }
        }
    }

    render(state: BoardState): void {
        this.state = state;
        if (this.selected && (!state.movable || !state.dests.has(this.selected))) this.selected = null;
        const selDests = new Set((this.selected && state.dests.get(this.selected) || []).map((d) => d.to));
        for (const [name, sq] of this.squares) {
            const p = state.pieces.get(name);
            const pieceEl = sq.querySelector<HTMLElement>('.piece')!;
            const key = p ? p.color + p.type : '';
            if (pieceEl.dataset.key !== key) {
                pieceEl.dataset.key = key;
                pieceEl.style.backgroundImage = p ? `url("${pieceUrl(p.type, p.color)}")` : '';
            }
            pieceEl.classList.toggle('dragging', !!this.drag?.ghost && this.drag.from === name);
            sq.classList.toggle('last-move', !!state.lastMove && (state.lastMove.from === name || state.lastMove.to === name));
            sq.classList.toggle('check', state.checkSquare === name);
            sq.classList.toggle('mate', state.mateSquare === name);
            sq.classList.toggle('selected', this.selected === name);
            sq.classList.toggle('dest', selDests.has(name));
            sq.classList.toggle('occupied', !!p);
            sq.classList.toggle('movable', !!p && p.color === state.movable && state.dests.has(name));
        }
    }

    private squareAt(x: number, y: number): string | null {
        const rect = this.root.getBoundingClientRect();
        if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
        const col = Math.floor((x - rect.left) / (rect.width / 8));
        const row = Math.floor((y - rect.top) / (rect.height / 8));
        const file = this.orientation === 'w' ? col : 7 - col;
        const rank = this.orientation === 'w' ? 7 - row : row;
        return FILES[file] + (rank + 1);
    }

    private canMoveFrom(square: string): boolean {
        const s = this.state;
        return !!s && !!s.movable && s.dests.has(square);
    }

    private select(square: string | null): void {
        this.selected = square;
        if (this.state) this.render(this.state);
    }

    private tryMove(from: string, to: string): boolean {
        const dests = this.state?.dests.get(from) || [];
        const matches = dests.filter((d) => d.to === to);
        if (!matches.length) return false;
        this.selected = null;
        if (matches.some((d) => d.promotion)) this.showPromotion(from, to);
        else this.callbacks.onMove(from, to, null);
        return true;
    }

    private onPointerDown(e: PointerEvent): void {
        if (e.button !== 0 || this.promo) return;
        const square = this.squareAt(e.clientX, e.clientY);
        if (!square) return;
        e.preventDefault();
        if (this.selected && this.selected !== square && this.tryMove(this.selected, square)) return;
        if (this.canMoveFrom(square)) {
            const wasSelected = this.selected === square;
            this.select(square);
            this.drag = { from: square, ghost: null, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, wasSelected };
        } else {
            this.select(null);
        }
    }

    private onPointerMove(e: PointerEvent): void {
        const d = this.drag;
        if (!d || e.pointerId !== d.pointerId) return;
        if (!d.ghost) {
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
            const p = this.state?.pieces.get(d.from);
            if (!p) return;
            const size = this.root.getBoundingClientRect().width / 8;
            const ghost = document.createElement('div');
            ghost.className = 'piece ghost';
            ghost.style.width = ghost.style.height = `${size}px`;
            ghost.style.backgroundImage = `url("${pieceUrl(p.type, p.color)}")`;
            document.body.appendChild(ghost);
            d.ghost = ghost;
            if (this.state) this.render(this.state);
        }
        const size = d.ghost.offsetWidth;
        d.ghost.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
        const over = this.squareAt(e.clientX, e.clientY);
        for (const [name, sq] of this.squares) sq.classList.toggle('drag-over', name === over);
    }

    private onPointerUp(e: PointerEvent): void {
        const d = this.drag;
        if (!d || e.pointerId !== d.pointerId) return;
        const target = this.squareAt(e.clientX, e.clientY);
        const dragged = !!d.ghost;
        this.cancelDrag();
        if (dragged) {
            if (!target || target === d.from || !this.tryMove(d.from, target)) {
                if (this.state) this.render(this.state);
            }
        } else if (d.wasSelected && target === d.from) {
            this.select(null);
        }
    }

    private cancelDrag(): void {
        if (!this.drag) return;
        this.drag.ghost?.remove();
        this.drag = null;
        for (const sq of this.squares.values()) sq.classList.remove('drag-over');
        if (this.state) this.render(this.state);
    }

    private showPromotion(from: string, to: string): void {
        const color = this.state?.pieces.get(from)?.color || 'w';
        const overlay = document.createElement('div');
        overlay.className = 'promotion';
        const fileIdx = FILES.indexOf(to[0]);
        const col = this.orientation === 'w' ? fileIdx : 7 - fileIdx;
        const top = this.squares.get(to)!.offsetTop === 0;
        const choices: PieceType[] = ['q', 'n', 'r', 'b'];
        choices.forEach((type, i) => {
            const btn = document.createElement('button');
            btn.className = 'promo-choice';
            btn.style.left = `${col * 12.5}%`;
            btn.style.top = top ? `${i * 12.5}%` : `${(7 - i) * 12.5}%`;
            btn.style.backgroundImage = `url("${pieceUrl(type, color)}")`;
            btn.title = { q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[type as 'q' | 'n' | 'r' | 'b'];
            btn.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.closePromotion();
                this.callbacks.onMove(from, to, type);
            });
            overlay.appendChild(btn);
        });
        overlay.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closePromotion(); });
        this.root.appendChild(overlay);
        this.promo = overlay;
    }

    private closePromotion(): void {
        this.promo?.remove();
        this.promo = null;
        if (this.state) this.render(this.state);
    }
}
