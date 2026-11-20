# Pludo

**Make 3D games on your phone and play them with friends.**

Pludo is a mobile game-creation platform. Build a world in a touch-first 3D editor, script it in Lua, and jump straight into real-time multiplayer.

## Features

- **Mobile 3D editor**: place models, sculpt terrain, and set the sky and lighting. Includes undo/redo, autosave, and a camera that remembers where you left it.
- **Lua scripting**: game logic runs server-side in a sandboxed Lua runtime, with triggers, scoring and per-player events.
- **Real-time multiplayer**: server-authoritative physics, a kinematic character controller with jump and terrain-following, remote players with nametags, and in-game chat.
- **Model Studio**: build your own 3D models in the app and export them as GLB.
- **Avatars and wardrobe**: customize your character and show it off in the lobby.
- **iPhone and iPad**: a native React Native shell embeds Unity, with landscape layouts built for tablets.
- **UGC moderation**: a word list plus AI checks, and a strike system for player-made content.

## Architecture

```
┌─────────────────────────┐      ┌──────────────────────────┐
│  native-shell (Expo)    │      │  api-server (Node.js)    │
│  lobby, profile, auth   │      │  REST + WebSocket rooms  │
│  ┌───────────────────┐  │ HTTP │  Lua runtime (wasmoon)   │
│  │ Unity as a Library│◄─┼──WS──┤  physics + world state   │
│  │  editor + game    │  │      │  moderation              │
│  │  ReactUnity UI    │  │      └───────────┬──────────────┘
│  └───────────────────┘  │                  │
└─────────────────────────┘        Supabase (auth, Postgres)
                                   Cloudflare R2 (assets)
```

| Path | What it is |
| --- | --- |
| `Assets/` | Unity client (Unity 6000.4): editor, gameplay renderer, avatars, Model Studio |
| `react/` | In-Unity UI written in React via [ReactUnity](https://reactunity.github.io/) |
| `native-shell/` | Expo / React Native app that embeds the Unity build |
| `api-server/` | Node.js + TypeScript server: game rooms, Lua runtime, physics, moderation |
| `supabase/migrations/` | Postgres schema (users, friends, games, inventory, moderation) |

## Getting started

### Prerequisites

- Unity **6000.4.3f1**
- Node.js 20+
- Xcode (for the iOS shell)
- Git LFS (3D models are stored in LFS): `git lfs install`
- A Supabase project and a Cloudflare R2 bucket

### API server

```bash
cd api-server
cp .env.example .env   # fill in Supabase, R2 and other keys
npm install
npm run dev            # http://localhost:4000
```

Run the tests with `npm test`.

### Database

Apply the SQL files in `supabase/migrations/` in order, using the Supabase CLI or the SQL editor.

### Unity client

1. **Install Photon Fusion 2.0.12 first.** The SDK isn't included in this repo because Photon's license doesn't allow redistributing it. The project won't compile without it: `Assets/Scripts/Services/Multiplayer/` uses Fusion directly.
   - Download Fusion 2.0.12 from the [Photon SDK downloads page](https://doc.photonengine.com/fusion/current/getting-started/sdk-download) (or the Unity Asset Store) and import it so it lands in `Assets/Photon/`.
   - Create a Fusion app in the [Photon dashboard](https://dashboard.photonengine.com/) and paste its App ID into `Assets/Photon/Fusion/Resources/PhotonAppSettings.asset` (or use **Tools ▸ Fusion ▸ Realtime Settings**).
   - `Assets/Photon/` is gitignored, so your SDK and App ID stay local.
2. Open the project root in Unity 6000.4.3f1.
3. Copy `Assets/Resources/Config/CloudflareR2Secrets.example.json` to `CloudflareR2Secrets.json` in the same folder and fill it in (it's gitignored).
4. Set the Supabase URL and anon key in `Assets/Resources/Config/SupabaseConfig_Dev.asset`.
5. Press Play.

### React UI (inside Unity)

```bash
cd react
npm install
npm start      # live-reloads into the running Unity editor
npm run build  # bundles into Assets/Resources/react
```

### Native iOS shell

First export from Unity: **Pludo ▸ Native Shell ▸ Export iOS (Simulator)** and/or **(Device)**. Then:

```bash
cd native-shell
npm install
npm run unity:framework   # build UnityFramework from the Unity iOS export
npm run ios
```

## Secrets

Never commit real keys. Server secrets go in `api-server/.env`, and the Unity client's R2 credentials go in `Assets/Resources/Config/CloudflareR2Secrets.json`. Both are gitignored. The only key that ships in the client is the Supabase **anon** key, which is meant to be public; access control is enforced by row-level security.
