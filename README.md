# Chess for Web-XDC

A chess game for [webxdc](https://webxdc.org) messengers such as Vector Chat, with a lichess-style layout.

![XDC-Chess showing the tournament screen and a chessboard](screenshots/chess-game.png)

## Play modes

- **vs Computer** – five strength levels (Beginner → Expert). The engine runs in a Web Worker. Games are saved locally and support takeback.
- **Network · 2 players** – the **Peers** tab lists everyone who currently has the app open in the chat. Click a peer to challenge them (choose White, Black or random). If they accept, both of you enter a 5+0 game (5 minutes per side). Draw offers, resignation, rematch and spectating ("Watch") are supported.
- **Network · Tournament** – any peer that is not in a game or tournament can start a 60-minute arena tournament. Connected peers get an invitation; those who accept are added to the roster, which is kept in sync on every device (see **Standings**). Games are 5+0 and players are paired automatically after each game (win 2 points, draw 1, doubled after two wins in a row 🔥). No new games start after 60 minutes; the tournament ends once running games finish.

## How networking works

- Messages go over the webxdc realtime channel (`joinRealtimeChannel`) for presence and fast delivery, and important events (challenges, game starts, moves, results, tournament state) are also sent with `sendUpdate` so they survive restarts and reach peers without realtime support.
- When the app is reopened, it replays the stored updates and resumes any unfinished game.
- The tournament creator's device coordinates the tournament: it pairs players, records results and broadcasts the roster/standings. If it goes offline, the online participant with the lowest address takes over.
- Clocks: each move carries both players' remaining time. A player who runs out of time loses (or draws if the opponent cannot mate). If the opponent's device goes silent, the other side claims the win on time after a short grace period.

## Development

Requires Node.js. Sources are TypeScript (`src/`, bundled with esbuild) and SCSS (`src/styles/`, compiled with sass).

```sh
npm install
npm start          # build assets and run the webxdc-dev simulator (multiple instances)
npm test           # unit tests (rules engine/perft, AI, tournament logic)
npm run typecheck  # tsc
npm run build      # typecheck + tests + bump build number + bundle + package dist/chess-<version>.xdc
```

`npm run build` increments the build number in `package.json`/`package-lock.json` and writes it to `version.js`.

## Credits

Piece graphics are based on the "cburnett" chess pieces by Colin M.L. Burnett (BSD/GPL/GFDL licensed).
