# EA Sports College Football 26 API Investigation Guide

This guide explains how to investigate whether EA Sports College Football 26 has a similar API to Madden NFL 25.

## Current Madden Implementation Overview

### Key Components

1. **Authentication System**
   - Uses EA OAuth 2.0 with refresh tokens
   - Client ID: `MCA_25_COMP_APP`
   - Authentication endpoint: `https://accounts.ea.com/connect/auth`
   - Token endpoint: `https://accounts.ea.com/connect/token`

2. **Blaze API (EA's Internal Service Layer)**
   - Endpoint: `https://wal2.tools.gos.bio-iad.ea.com/wal/`
   - Requires session authentication via Blaze
   - Uses product-specific identifiers

3. **Madden-Specific Identifiers**
   - **Entitlements**: `MADDEN_25XONE`, `MADDEN_25PS4`, `MADDEN_25PC`, `MADDEN_25PS5`, `MADDEN_25XBSX`
   - **Blaze Services**: `madden-2026-xone`, `madden-2026-ps4`, etc.
   - **Product Names**: `madden-2026-xone-mca`, `madden-2026-ps4-mca`, etc.
   - **Application Key**: `MADDEN-MCA`

## Steps to Investigate College Football API

### Step 1: Verify Game Ownership & Entitlements

1. **Check EA Account for Entitlements**

   Use this modified script to check what games you own:

   ```bash
   # Get access token (you'll need to implement OAuth flow or use existing dashboard)
   curl -X GET "https://gateway.ea.com/proxy/identity/pids/me/entitlements" \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     -H "Accept: application/json"
   ```

2. **Look for College Football Entitlements**

   Based on Madden's pattern, College Football entitlements might be:
   - `CFB_26XONE` or `COLLEGE_26XONE`
   - `CFB_26PS4` or `COLLEGE_26PS4`
   - `CFB_26PS5` or `COLLEGE_26PS5`
   - `CFB_26XBSX` or `COLLEGE_26XBSX`
   - `CFB_26PC` or `COLLEGE_26PC`

### Step 2: Discover Blaze Service Names

The Blaze service name follows a pattern. For Madden it's:
- `madden-2026-{console}`

For College Football, try these patterns:
- `cfb-2027-{console}` (following Madden's pattern: CFB 26 → 2027)
- `college-2027-{console}`
- `ncaa-2027-{console}`
- `collegefootball-2027-{console}`
- Also try `2026` variants in case EA uses a different numbering scheme

**Test Script:**

```typescript
async function testBlazeService(serviceName: string, accessToken: string) {
  const res = await fetch(
    `https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login`,
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "X-BLAZE-ID": serviceName,
        "X-Application-Key": "CFB-MCA", // Try different keys
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accessToken: accessToken,
        productName: `${serviceName}-mca`,
      }),
    }
  );

  console.log(`Testing ${serviceName}:`, res.status);
  if (res.ok) {
    console.log("SUCCESS! Response:", await res.json());
  }
}

// Test variations
const consoles = ['xone', 'ps4', 'ps5', 'xbsx', 'pc'];
const prefixes = ['cfb', 'college', 'ncaa', 'collegefootball'];
const years = ['2027', '2026']; // Try both year patterns

for (const prefix of prefixes) {
  for (const year of years) {
    for (const console of consoles) {
      await testBlazeService(`${prefix}-${year}-${console}`, YOUR_ACCESS_TOKEN);
    }
  }
}
```

### Step 3: Identify Application Keys

Madden uses `MADDEN-MCA`. College Football might use:
- `CFB-MCA`
- `COLLEGE-MCA`
- `NCAA-MCA`
- `CFBALL-MCA`

### Step 4: Test League API Endpoints

Once you have valid Blaze authentication, test these command names:

```typescript
const testCommands = [
  // Madden uses these
  "CareerMode_GetMyLeagues",
  "CareerMode_GetLeagueHub",
  "CareerMode_GetLeagueTeamsExport",
  "CareerMode_GetStandingsExport",
  "CareerMode_GetWeeklySchedulesExport",

  // Try College Football variations
  "DynastyMode_GetMyDynasties", // Dynasty = College Football's league mode
  "DynastyMode_GetDynastyHub",
  "DynastyMode_GetDynastyTeamsExport",
  // etc.
];

async function testBlazeCommand(command: string, session: SessionInfo) {
  const blazeRequest = {
    commandName: command,
    componentId: 4001, // Common component ID
    commandId: 1,
    componentName: "CareerMode", // Or "DynastyMode"
    requestPayload: {
      // Add appropriate payload
    }
  };

  // Use your existing sendBlazeRequest function
  const result = await sendBlazeRequest(token, session, blazeRequest);
  console.log(`Command ${command}:`, result);
}
```

### Step 5: Practical Investigation Steps

**Option A: Network Sniffing (Easiest)**

1. Install the EA Sports College Football Companion App on mobile
2. Use a proxy tool like:
   - **mitmproxy** (recommended)
   - **Charles Proxy**
   - **Fiddler**
3. Configure your phone to use the proxy
4. Open the companion app and interact with your dynasty
5. Capture all API calls and analyze:
   - Endpoint URLs
   - Request headers
   - Request payloads
   - Response formats

**Option B: Use Existing Infrastructure**

Create a test script using your existing EA authentication:

```typescript
// src/debug/test_cfb_api.ts
import { createEAClient } from "../dashboard/ea_client";

async function testCollegeFootball() {
  // Use your existing dashboard authentication
  const accessToken = "YOUR_ACCESS_TOKEN_FROM_DASHBOARD";

  // Test entitlements
  const entitlementRes = await fetch(
    "https://gateway.ea.com/proxy/identity/pids/me/entitlements",
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    }
  );

  const entitlements = await entitlementRes.json();
  console.log("Entitlements:", entitlements);

  // Look for CFB entitlements
  const cfbEntitlements = entitlements.entitlements.entitlement.filter(
    (e: any) => e.entitlementTag.includes('CFB') ||
                e.entitlementTag.includes('COLLEGE')
  );

  console.log("College Football Entitlements:", cfbEntitlements);
}

testCollegeFootball();
```

### Step 6: Key Differences to Investigate

College Football (Dynasty Mode) might have different:

1. **Mode Names**
   - Madden: "Career Mode"
   - CFB: Likely "Dynasty Mode"

2. **Team Structure**
   - ~130 FBS teams instead of 32 NFL teams
   - Conference-based instead of division-based

3. **Season Structure**
   - 12-14 game regular season
   - Conference championships
   - Playoff system (12 teams)

4. **Player Data**
   - Generic players (no NIL rights)
   - Different stat categories (redshirt status, eligibility)

## Expected API Endpoints

If College Football follows Madden's pattern:

```typescript
// Likely College Football commands
enum CollegeFootballData {
  TEAMS = "DynastyMode_GetDynastyTeamsExport",
  STANDINGS = "DynastyMode_GetStandingsExport",
  WEEKLY_SCHEDULE = "DynastyMode_GetWeeklySchedulesExport",
  RUSHING_STATS = "DynastyMode_GetWeeklyRushingStatsExport",
  TEAM_STATS = "DynastyMode_GetWeeklyTeamStatsExport",
  PUNTING_STATS = "DynastyMode_GetWeeklyPuntingStatsExport",
  RECEIVING_STATS = "DynastyMode_GetWeeklyReceivingStatsExport",
  DEFENSIVE_STATS = "DynastyMode_GetWeeklyDefensiveStatsExport",
  KICKING_STATS = "DynastyMode_GetWeeklyKickingStatsExport",
  PASSING_STATS = "DynastyMode_GetWeeklyPassingStatsExport",
  TEAM_ROSTER = "DynastyMode_GetTeamRostersExport"
}
```

## Testing Checklist

- [ ] Confirm you own College Football 26
- [ ] Check EA account for CFB entitlements
- [ ] Try different Blaze service name patterns
- [ ] Test various application keys
- [ ] Try "DynastyMode" instead of "CareerMode" commands
- [ ] Use network proxy to capture companion app traffic
- [ ] Document all successful API calls
- [ ] Map response formats to existing Madden types
- [ ] Test with multiple consoles if available

## Expected Challenges

1. **Different API Structure**: Dynasty mode might use completely different endpoints
2. **No Companion App**: If there's no official companion app, there might be no API
3. **Limited Export**: College Football might not support data export at all
4. **Different Authentication**: Might require different OAuth scopes or permissions

## Recommended Approach

1. **Start Simple**: Use network sniffing on the companion app (if it exists)
2. **Document Everything**: Keep detailed notes of all API patterns discovered
3. **Test Incrementally**: Don't assume Madden patterns work - test each variation
4. **Check Official Sources**: Look for EA developer documentation or forums

## Resources

- EA Sports API Gateway: `https://gateway.ea.com`
- EA Blaze Service: `https://wal2.tools.gos.bio-iad.ea.com`
- EA OAuth: `https://accounts.ea.com`
- Current implementation: `src/dashboard/ea_client.ts` and `src/dashboard/ea_constants.ts`

## Next Steps After Discovery

Once you identify the correct API endpoints:

1. Create `src/dashboard/cfb_constants.ts` with College Football-specific identifiers
2. Extend `ea_client.ts` to support both games
3. Add College Football data types to export system
4. Update database schema to support CFB data
5. Create Discord commands for College Football dynasties

---

**Note**: This is reverse engineering EA's private API. Use responsibly and only for personal/educational purposes. EA may change or restrict access at any time.
