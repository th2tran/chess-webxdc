/* Chess piece SVGs, based on the "cburnett" set by Colin M.L. Burnett (BSD/GPL/GFDL licensed). */
import type { Color, PieceType } from './engine.ts';

function svg(body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">${body}</svg>`;
}

export function pieceSvg(type: PieceType, color: Color): string {
    const fill = color === 'w' ? '#fff' : '#000';
    const detail = color === 'w' ? '#000' : '#fff';
    const base = `fill="${fill}" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;
    switch (type) {
        case 'p':
            return svg(`<path ${base} d="m22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38-1.95 1.12-3.28 3.21-3.28 5.62 0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/>`);
        case 'n':
            return svg(`<g ${base}>
                <path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/>
                <path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.99-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.99 2.5-3c1 0 1 3 1 3"/>
                <path fill="${detail}" stroke="${detail}" d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0z"/>
                <path fill="${detail}" stroke="${detail}" d="M15 15.5a.5 1.5 0 1 1-1 0 .5 1.5 0 1 1 1 0z" transform="matrix(.866 .5 -.5 .866 9.693 -5.173)"/>
                ${color === 'b' ? '<path fill="#fff" stroke="none" d="M24.55 10.4l-.45 1.45.5.15c3.15 1 5.65 2.49 7.9 6.75S35.75 29.06 35.25 39l-.05.5h2.25l.05-.5c.5-10.06-.88-16.85-3.25-21.34-2.37-4.49-5.79-6.64-9.19-7.16l-.51-.1z"/>' : ''}
            </g>`);
        case 'b':
            return svg(`<g ${base}>
                <g stroke-linecap="butt">
                    <path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.46 3-2 3-2z"/>
                    <path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/>
                    <path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/>
                </g>
                <path fill="none" stroke="${detail}" stroke-linejoin="miter" d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5"/>
            </g>`);
        case 'r':
            return svg(`<g ${base}>
                <path stroke-linecap="butt" d="M9 39h27v-3H9v3zm3-3v-4h21v4H12zm-1-22V9h4v2h5V9h5v2h5V9h4v5"/>
                <path d="M34 14l-3 3H14l-3-3"/>
                <path stroke-linecap="butt" stroke-linejoin="miter" d="M31 17v12.5H14V17"/>
                <path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/>
                <path fill="none" stroke="${detail}" stroke-linejoin="miter" d="M11 14h23"/>
                ${color === 'b' ? '<path fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="miter" d="M14 29.5h17M14 17h17M12 35.5h21"/>' : ''}
            </g>`);
        case 'q':
            return svg(`<g ${base}>
                <path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z"/>
                <path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1 2.5-1 2.5-1.5 1.5 0 2.5 0 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/>
                <path fill="none" stroke="${detail}" d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0"/>
                <circle cx="6" cy="12" r="2"/><circle cx="14" cy="9" r="2"/><circle cx="22.5" cy="8" r="2"/>
                <circle cx="31" cy="9" r="2"/><circle cx="39" cy="12" r="2"/>
            </g>`);
        case 'k':
            return svg(`<g ${base}>
                <path fill="none" stroke-linejoin="miter" d="M22.5 11.63V6M20 8h5"/>
                <path stroke-linecap="butt" stroke-linejoin="miter" d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/>
                <path d="M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7"/>
                <path fill="none" stroke="${detail}" d="M12.5 30c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0"/>
            </g>`);
    }
}

const cache = new Map<string, string>();

/** data: URL for a piece image, suitable for CSS background-image or <img src>. */
export function pieceUrl(type: PieceType, color: Color): string {
    const key = color + type;
    let url = cache.get(key);
    if (!url) {
        url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pieceSvg(type, color));
        cache.set(key, url);
    }
    return url;
}
