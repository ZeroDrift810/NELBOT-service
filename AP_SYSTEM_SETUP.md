# AP SYSTEM - SETUP & USAGE GUIDE

## 📦 INSTALLATION

### Step 1: Copy Files to Your Bot

Copy these files to your NELBOTMASTER directory:

```
C:\LeagueHQ\NELBOTMASTER\src\commands\ap.ts
C:\LeagueHQ\NELBOTMASTER\src\ap_system\prices.ts
```

### Step 2: Register the Command Handler

Edit `src/commands_handler.ts`:

**Add import at the top:**
```typescript
import apHandler from "./commands/ap";
```

**Add to SlashCommands object (around line 85):**
```typescript
const SlashCommands: CommandsHandler = {
  league_export: leagueExportHandler,
  dashboard: dashboardHandler,
  game_channels: gameChannelHandler,
  teams: teamsHandler,
  streams: streamsHandler,
  broadcasts: broadcastsHandler,
  waitlist: waitlistHandler,
  schedule: schedulesHandler,
  logger: loggerHandler,
  export: exportHandler,
  test: testHandler,
  standings: standingsHandler,
  player: playerHandler,
  playoffs: bracketHandler,
  sims: simsHandler,
  ap: apHandler,  // ← ADD THIS LINE
};
```

### Step 3: Rebuild

```powershell
cd C:\LeagueHQ\NELBOTMASTER
npm run build
```

### Step 4: Restart Bot

Close the bot window and restart:
```powershell
C:\LeagueHQ\NELBOTMASTER\Launch-NELBOT.cmd
```

### Step 5: Register Commands

Wait for bot to fully start, then:

```powershell
$body = @{
    mode = "INSTALL"
    commandNames = @("ap")
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8787/discord/webhook/commandsHandler" -Method POST -Body $body -ContentType "application/json"
```

Wait 1-5 minutes for Discord to register the command globally.

---

## 🎮 COMMAND REFERENCE

### Admin Commands

#### `/ap grant`
**Purpose:** Give AP to a user
**Usage:** `/ap grant user:@JohnDoe amount:5 reason:"GOTW Winner Week 5"`
**Required:** Administrator permission

#### `/ap deduct`
**Purpose:** Remove AP from a user
**Usage:** `/ap deduct user:@JohnDoe amount:15 reason:"Speed +1 for Mahomes"`
**Required:** Administrator permission
**Note:** Will fail if user doesn't have enough AP

#### `/ap set`
**Purpose:** Set exact AP balance
**Usage:** `/ap set user:@JohnDoe amount:50`
**Required:** Administrator permission
**Use case:** Season resets, corrections, importing existing balances

---

### User Commands

#### `/ap balance`
**Purpose:** Check AP balance
**Usage:** 
- `/ap balance` - Check your own
- `/ap balance user:@JohnDoe` - Check someone else's

**Shows:**
- Current balance
- Total earned (lifetime)
- Total spent (lifetime)

#### `/ap history`
**Purpose:** View transaction log
**Usage:**
- `/ap history` - Your last 10 transactions
- `/ap history user:@JohnDoe` - Someone else's history
- `/ap history limit:20` - Show 20 transactions

#### `/ap leaderboard`
**Purpose:** Show top AP holders
**Usage:**
- `/ap leaderboard` - Top 10
- `/ap leaderboard limit:20` - Top 20

#### `/ap prices`
**Purpose:** View shop prices
**Usage:**
- `/ap prices` - Full price list
- `/ap prices category:physical` - Elite Physical only
- `/ap prices category:offensive` - Offensive Skills only
- `/ap prices category:defensive` - Defensive Skills only
- `/ap prices category:blocking` - Blocking & Utility only

---

## 📋 WEEKLY WORKFLOW EXAMPLES

### Example 1: Game of the Week Results

**Scenario:** Week 5 GOTW
- Winner: @JohnDoe
- Loser: @JaneSmith (lost by 6, close game)
- Prediction winner: @MikeJones

**Commands:**
```
/ap grant user:@JohnDoe amount:5 reason:"GOTW Winner Week 5"
/ap grant user:@JaneSmith amount:2 reason:"GOTW Close Loss Week 5 (within 7pts)"
/ap grant user:@MikeJones amount:2 reason:"Correct GOTW Prediction Week 5"
```

### Example 2: Game Recap Posted

**Scenario:** @Player posts a recap screenshot

**Command:**
```
/ap grant user:@Player amount:1 reason:"Game recap posted - Week 5"
```

### Example 3: Streaming Reward

**Scenario:** @Player completed streaming 8 home games

**Command:**
```
/ap grant user:@Player amount:10 reason:"Streamed 8 required home games"
```

### Example 4: Player Buys Upgrade

**Scenario:** @JohnDoe wants to buy +1 Speed for Patrick Mahomes

**Workflow:**
1. Player asks: "Can I buy Speed for Mahomes?"
2. Admin checks: `/ap balance user:@JohnDoe` → Shows 47 AP
3. Admin checks price: `/ap prices category:physical` → Speed = 15 AP
4. Player has enough, so deduct: `/ap deduct user:@JohnDoe amount:15 reason:"Speed +1 - Patrick Mahomes"`
5. Admin manually applies upgrade in Madden

### Example 5: Season Reset

**Scenario:** New season starts, reset everyone to 0

**Commands:**
```
/ap set user:@Player1 amount:0
/ap set user:@Player2 amount:0
/ap set user:@Player3 amount:0
... (repeat for all players)
```

**Or give everyone a starting amount:**
```
/ap set user:@Player1 amount:10
/ap set user:@Player2 amount:10
... (everyone starts with 10 AP)
```

---

## 🔍 TROUBLESHOOTING

### Commands don't appear in Discord
- Wait 1-5 minutes after registration
- Try registering to your guild specifically for instant testing:
  ```powershell
  $body = @{
      mode = "INSTALL"
      commandNames = @("ap")
      guildId = "YOUR_GUILD_ID"
  } | ConvertTo-Json
  ```

### "You must be an administrator" error
- User doesn't have Administrator permission
- Grant them Administrator role in Discord server settings

### "Insufficient AP" error when deducting
- User doesn't have enough AP
- Check their balance: `/ap balance user:@User`
- Either grant more AP first, or reduce the deduction amount

### Balance seems wrong
- Check history: `/ap history user:@User limit:50`
- Review all transactions
- Use `/ap set` to correct if needed

### Bot not responding
- Check bot console for errors
- Verify bot is running: `Get-Process -Name node`
- Check tunnel is running: `Get-Process -Name cloudflared`
- Test webhook: `Invoke-WebRequest -Uri "https://nelbot.itsyamsayin.com/discord/webhook/slashCommand"`

---

## 📊 FIRESTORE STRUCTURE

The AP system creates two collections:

### `ap_balances`
Document ID format: `{guild_id}_{user_id}`

```json
{
  "user_id": "123456789",
  "guild_id": "987654321",
  "balance": 47,
  "total_earned": 120,
  "total_spent": 73,
  "last_updated": 1699564800000
}
```

### `ap_transactions`
Auto-generated document IDs

```json
{
  "guild_id": "987654321",
  "user_id": "123456789",
  "amount": 5,
  "type": "grant",
  "reason": "GOTW Winner Week 5",
  "admin_id": "111222333",
  "timestamp": 1699564800000
}
```

---

## 🎯 TESTING CHECKLIST

After installation, test these commands:

- [ ] `/ap prices` - Shows full price list
- [ ] `/ap grant user:@TestUser amount:10 reason:"Test"` - Grants AP
- [ ] `/ap balance user:@TestUser` - Shows 10 AP
- [ ] `/ap history user:@TestUser` - Shows the grant transaction
- [ ] `/ap deduct user:@TestUser amount:5 reason:"Test purchase"` - Deducts AP
- [ ] `/ap balance user:@TestUser` - Shows 5 AP remaining
- [ ] `/ap leaderboard` - Shows @TestUser in list
- [ ] `/ap set user:@TestUser amount:0` - Resets to 0
- [ ] Try grant as non-admin - Should get "must be administrator" error

---

## 📝 CUSTOMIZATION

### Change Prices

Edit `src/ap_system/prices.ts`:

```typescript
export const AP_PRICES = {
  physical: {
    speed: 20,  // Change from 15 to 20
    // ... rest
  }
}
```

Rebuild and restart bot.

### Add New Attributes

1. Add to `AP_PRICES` object in `prices.ts`
2. Add friendly name to `FRIENDLY_NAMES` object
3. Rebuild and restart

---

## ✅ SUPPORT

If you encounter issues:

1. Check bot console for errors
2. Verify Firestore connection
3. Test commands in order from testing checklist
4. Check Discord permissions (Administrator role)

All transactions are logged, so you can always review history to debug issues.
