# NELBOTMASTER Technical Summary

## 1. CURRENT STATE

**This is a fully-built, production-ready Discord bot service** - not a scaffold. It's a fork/instance of "snallabot-service" specifically configured for the NEL (National eSports League) Madden football league.

**Production Status:**
- Live deployment at `https://snallabot.me`
- Running via PM2 process manager (multiple `.cmd` scripts for start/stop)
- Uses Cloudflare tunnels for exposure
- Recently had 40+ bug fixes applied (Dec 25, 2025)

---

## 2. PACKAGE.JSON

### Dependencies (Production)
| Package | Version | Purpose |
|---------|---------|---------|
| `koa` | ^2.15.0 | Web framework |
| `@koa/router` | ^12.0.1 | Routing |
| `@koa/bodyparser` | ^5.0.0 | Request parsing |
| `koa-static` | ^5.0.0 | Static file serving |
| `firebase-admin` | ^12.0.0 | Firestore database |
| `@google-cloud/storage` | ^7.15.0 | Cloud storage |
| `discord-api-types` | ^0.38.1 | Discord type definitions |
| `discord-interactions` | ^4.1.1 | Discord interaction handling |
| `oceanic.js` | ^1.11.2 | Discord client library |
| `googleapis` | ^154.1.0 | YouTube API integration |
| `canvas` | ^3.2.0 | Image generation |
| `pug` | ^3.0.3 | Template engine |
| `fuzzysort` | ^3.1.0 | Fuzzy search |
| `node-cache` | ^5.1.2 | In-memory caching |
| `undici` | ^6.6.2 | HTTP client |
| `object-hash` | ^3.0.0 | Object hashing |

### Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.3.3 | TypeScript compiler |
| `ts-node` | ^10.9.2 | TypeScript execution |
| `jest` | ^29.7.0 | Testing |
| `ts-jest` | ^29.1.1 | Jest TypeScript support |
| `nodemon` | ^3.0.3 | Dev auto-reload |
| `firebase-tools` | ^13.9.0 | Firebase CLI |
| `supertest` | ^6.3.4 | HTTP testing |

### NPM Scripts
```json
{
  "test": "npx jest",
  "build": "npx tsc && cp -r src/public dist/ && cp -r emojis dist/ && cp -r src/dashboard/templates dist/dashboard",
  "start": "node dist/index.js",
  "dev": "npx firebase --project dev emulators:start & FIRESTORE_EMULATOR_HOST=localhost:8080 nodemon ...",
  "yt-notifier": "node dist/yt-notifier/index.js",
  "pinger": "node dist/discord/pinger.js",
  "ea-refresher": "node dist/dashboard/ea_refresher.js"
}
```

---

## 3. FOLDER STRUCTURE

```
src/
├── index.ts              # Entry point (starts Koa server)
├── server.ts             # Koa app setup with routers
├── config.ts             # Configuration
├── stats.ts              # Statistics utilities
├── file_handlers.ts      # File handling utilities
├── league_deleter.ts     # League cleanup
├── cleanup.ts            # Data cleanup
├── analyze_player_changes.ts
│
├── db/                   # Database layer
│   ├── firebase.ts       # Firebase/Firestore initialization
│   ├── events.ts         # Event types
│   ├── events_db.ts      # Event database operations
│   ├── madden_db.ts      # Madden data storage
│   ├── madden_hash_storage.ts
│   └── view.ts           # View layer
│
├── discord/              # Discord bot logic
│   ├── routes.ts         # Discord API routes
│   ├── commands_handler.ts # Command router (28+ commands)
│   ├── discord_utils.ts  # Discord utilities
│   ├── settings_db.ts    # Bot settings storage
│   ├── notifier.ts       # Notification system
│   ├── pinger.ts         # Health check
│   ├── logging.ts        # Logging utilities
│   ├── migration.ts      # Data migrations
│   └── commands/         # 22 command handlers
│       ├── bracket.ts        # Playoff brackets
│       ├── broadcasts.ts     # Stream announcements
│       ├── dashboard.ts      # Dashboard links
│       ├── export.ts         # Data export
│       ├── gamerecap.ts      # AI game recaps
│       ├── game_channels.ts  # Game channels
│       ├── game_stats.ts     # Game statistics
│       ├── leaders.ts        # League leaders
│       ├── player.ts         # Player cards (67KB!)
│       ├── powerrankings.ts  # Power rankings
│       ├── progression.ts    # Player progression
│       ├── schedule.ts       # Game schedules
│       ├── sims.ts           # Simulated games
│       ├── standings.ts      # League standings
│       ├── streams.ts        # Stream config
│       ├── teams.ts          # Team management
│       ├── waitlist.ts       # Waitlist system
│       └── ... (more)
│
├── dashboard/            # Web dashboard
│   ├── routes.ts         # Dashboard routes
│   ├── ea_client.ts      # EA/Madden API client
│   ├── ea_constants.ts   # EA API constants
│   ├── ea_refresher.ts   # Token refresh service
│   └── migrate_dashboard.ts
│
├── export/               # Data export system
│   ├── routes.ts
│   ├── exporter.ts
│   ├── madden_league_types.ts
│   ├── emc_roster_dumper.ts
│   └── migration.ts
│
├── twitch-notifier/      # Twitch integration
│   ├── routes.ts
│   ├── twitch_client.ts
│   └── migration.ts
│
├── yt-notifier/          # YouTube integration
│   ├── index.ts
│   ├── routes.ts
│   ├── update-channel-names.ts
│   └── yt-migration.ts
│
├── connections/          # External connections
│   └── routes.ts
│
├── debug/                # Debug tools
│   ├── routes.ts
│   ├── force_scoreboard.ts
│   └── team_list.ts
│
└── public/               # Static assets
```

**Other Important Directories:**
- `emojis/` - Discord emoji assets
- `backgrounds/` - Image backgrounds for cards
- `images/` - Generated images
- `dist/` - Compiled JavaScript output
- `docs/` - Documentation

---

## 4. DATABASE

**Primary Database: Firebase Firestore**

```typescript
// src/db/firebase.ts
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

// Supports:
// 1. Emulator mode (FIRESTORE_EMULATOR_HOST)
// 2. Service account file (SERVICE_ACCOUNT_FILE)
// 3. Service account JSON env var (SERVICE_ACCOUNT)
```

**Configuration Required:**
- `SERVICE_ACCOUNT_FILE` or `SERVICE_ACCOUNT` - Firebase credentials
- `GOOGLE_APPLICATION_CREDENTIALS` - GCP credentials
- `GCLOUD_PROJECT` - GCP project ID

**Storage Options:**
- Google Cloud Storage (`USE_GCS=true`)
- Local file system (default for dev)

---

## 5. EXISTING FEATURES

### Discord Commands (28 slash commands)
| Command | Description |
|---------|-------------|
| `/league_export` | Export league data |
| `/dashboard` | Dashboard links |
| `/game_channels` | Game channel management |
| `/teams` | Team info/management |
| `/streams` | Stream configuration |
| `/broadcasts` | Broadcast announcements |
| `/waitlist` | Waitlist management |
| `/schedule` | Game schedules |
| `/standings` | League standings |
| `/player` | Player cards with stats |
| `/playoffs` | Playoff brackets |
| `/sims` | Simulated games |
| `/leaders` | League leaders |
| `/powerrankings` | AI-generated power rankings |
| `/gamerecap` | AI-generated game recaps |
| `/progression` | Player progression tracking |
| `/pickem` | Pick'em game system |
| `/draft` | Draft information |
| `/gotw` | Game of the Week |
| And more... |

### API Routes
- `POST /discord` - Discord interactions webhook
- `/export/*` - Data export endpoints
- `/twitch/*` - Twitch webhook handlers
- `/dashboard/*` - Web dashboard
- `/debug/*` - Debug endpoints
- `/connections/*` - External connection management

### Integrations
1. **Discord** - Full bot with slash commands, autocomplete, message components
2. **EA/Madden API** - League data sync via dashboard
3. **Twitch** - EventSub webhooks for stream notifications
4. **YouTube** - Channel monitoring for stream detection
5. **Anthropic Claude** - AI-generated game recaps and power rankings

---

## 6. TSCONFIG

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

**Key Settings:**
- **Target**: ESNext (latest JavaScript)
- **Module**: NodeNext (modern Node.js ESM)
- **Strict Mode**: Enabled
- **Output**: `./dist` directory

---

## 7. ENVIRONMENT VARIABLES

**Required:**
- `PUBLIC_KEY` - Discord app public key
- `DISCORD_TOKEN` - Discord bot token
- `APP_ID` - Discord application ID
- `GUILD_ID` - Discord server ID
- `SERVICE_ACCOUNT_FILE` - Firebase credentials

**Optional:**
- `TWITCH_CLIENT_ID/SECRET` - Twitch integration
- `YOUTUBE_API_KEY` - YouTube integration
- `ANTHROPIC_API_KEY` - AI features

---

## 8. DEPLOYMENT

**Current Setup:**
- PM2 process manager (`ecosystem.config.js`)
- Cloudflare tunnel for public access
- Node.js 21.x required
- Multiple `.cmd` scripts for Windows management
