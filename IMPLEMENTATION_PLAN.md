# Feature Implementation Plan

## Priority Order
1. Draft Recap Command
2. Team Stats Command
3. Awards & History System

---

## 1. Draft Recap Command (`/draft`)

### Overview
Show draft results by round with pick order, player names, positions, and teams.

### Data Source
Existing player data in `madden_db.ts` already has:
- `draftPick` - Pick number within round
- `draftRound` - Round number
- `yearsPro` - Can determine draft year

### Implementation
- **File**: `src/discord/commands/draft.ts` (already exists, needs enhancement)
- **Subcommands**:
  - `/draft recap [year]` - Show full draft by round
  - `/draft team <team>` - Show all picks for a team
  - `/draft pick <round> <pick>` - Show specific pick details

### Output Format
```
📋 **2024 NEL Draft Recap**

**Round 1**
1. 🏈 CHI - Marcus Johnson (QB) - 85 OVR
2. 🏈 DET - James Smith (WR) - 84 OVR
...

**Round 2**
33. 🏈 NYG - Mike Williams (CB) - 79 OVR
...
```

### Effort: Low
Uses existing data, straightforward display.

---

## 2. Team Stats Command (`/teamstats`)

### Overview
Show team statistical leaderboards - offense, defense, special teams.

### Data Source
`madden_db.ts` has `getTeamStandings()` which returns team records.
Need to aggregate player stats by team or use team stats from exports.

### Implementation
- **File**: `src/discord/commands/team_stats.ts` (new)
- **Subcommands**:
  - `/teamstats offense` - Passing/rushing/scoring leaders
  - `/teamstats defense` - Points allowed, turnovers, sacks
  - `/teamstats rankings` - Overall power rankings style

### Output Format
```
🏈 **Offensive Team Rankings**

**Total Yards**
1. 🏈 KC - 4,521 yds (325.1 ypg)
2. 🏈 BUF - 4,389 yds (313.5 ypg)
...

**Passing Yards**
1. 🏈 MIA - 3,102 yds
...
```

### Effort: Medium
Need to aggregate stats or find team-level stat source.

---

## 3. Awards & History System

### Overview
Track player awards (MVP, OPOY, DPOY, Pro Bowl, All-Pro) and rating progression over time.

### Data Storage
New Firestore collections:
- `leagues/{guildId}/awards/{seasonYear}` - Award winners by season
- `leagues/{guildId}/playerHistory/{rosterId}` - Rating snapshots over time

### Implementation

#### A. Awards Tracking
- **File**: `src/discord/commands/awards.ts` (new)
- **Admin Commands**:
  - `/awards give <player> <award> [season]` - Grant award
  - `/awards remove <player> <award> [season]` - Remove award
- **View Commands**:
  - `/awards player <player>` - Show player's career awards
  - `/awards season [year]` - Show all awards for a season
  - `/awards history <award>` - Show all winners of an award

#### B. Attribute History
- **Tracking**: Snapshot player ratings on each export
- **Display**: Add to `/player` command or separate `/player history <name>`
- **Storage**: Store weekly/periodic snapshots of OVR and key ratings

### Output Format - Awards
```
🏆 **Patrick Mahomes - Career Awards**

**MVP** (2x)
- 2023, 2024

**Pro Bowl** (4x)
- 2021, 2022, 2023, 2024

**All-Pro 1st Team** (2x)
- 2023, 2024
```

### Output Format - History
```
📈 **Patrick Mahomes - Rating History**

Season 2024:
Week 1: 97 OVR
Week 8: 98 OVR (+1)
Week 17: 99 OVR (+1)

Season 2023:
Week 1: 95 OVR
Week 17: 97 OVR (+2)
```

### Effort: Medium-High
Requires new database collections and snapshot mechanism.

---

## 4. Trade System (Lower Priority)

### Overview
Manual trade entry with voting/approval workflow.

### Implementation Phases

#### Phase 1: Manual Entry
- `/trade propose <team1> <team2>` - Start trade wizard
- Button-based player/pick selection
- Store pending trades in Firestore

#### Phase 2: Voting System
- Configurable approval requirements (commissioner only, league vote, etc.)
- Reaction-based voting (reuse force-win pattern)
- Auto-announce approved trades

#### Phase 3: Web Dashboard
- Trade configuration settings in dashboard
- Pick value charts
- Trade history view

### Effort: High
Complex multi-step flow, voting system, dashboard integration.

---

## Implementation Order

### Week 1: Draft Recap
1. Enhance existing `draft.ts` with recap subcommand
2. Add team draft history view
3. Format output with team emojis and player portraits

### Week 2: Team Stats
1. Create `team_stats.ts` command
2. Aggregate player stats by team
3. Build ranking displays for offense/defense

### Week 3-4: Awards System
1. Design Firestore schema for awards
2. Build admin commands for granting awards
3. Build view commands for displaying awards
4. Integrate awards display into player command

### Week 5-6: History Tracking
1. Add rating snapshot on export
2. Build history display
3. Integrate into player command

---

## Files to Create/Modify

### New Files
- `src/discord/commands/team_stats.ts`
- `src/discord/commands/awards.ts`
- `src/db/awards_db.ts`
- `src/db/player_history_db.ts`

### Modified Files
- `src/discord/commands/draft.ts` - Add recap functionality
- `src/discord/commands/player.ts` - Add awards display, history tab
- `src/discord/routes.ts` - Register new commands
- `src/export/exporter.ts` - Add rating snapshot on export
