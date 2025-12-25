# Command Error Review Report
**Generated:** 2025-12-25
**Review Scope:** All Discord command handlers

## Summary
- **Critical Issues:** 28
- **Silent Errors:** 6
- **Potential Null Reference Errors:** 22

---

## CRITICAL ISSUES

### 1. commands_handler.ts

#### Line 205: Silent Error - Autocomplete
**Severity:** HIGH
**Issue:** Catch block swallows all errors without logging
```typescript
} catch {
  ctx.status = 200;
  ctx.set("Content-Type", "application/json");
  ctx.body = {
    type: InteractionResponseType.ApplicationCommandAutocompleteResult,
    data: { choices: [] },
  };
}
```
**Impact:** Debugging autocomplete failures is impossible. Users see empty results with no indication why.
**Fix:** Add error logging:
```typescript
} catch (e) {
  console.error(`❌ Autocomplete error for ${commandName}:`, e);
  // ... rest of code
}
```

#### Line 238-239: Missing Error Response Body
**Severity:** MEDIUM
**Issue:** Sets 500 status but doesn't send proper error response to Discord
```typescript
ctx.status = 500;
console.error(error);
```
**Impact:** Discord receives incomplete response, may show "Interaction failed" to users.
**Fix:** Send proper error body with user-friendly message.

#### Line 277-279: Silent Error in Fallback Handler
**Severity:** MEDIUM
**Issue:** Errors logged but 500 status set without response body
```typescript
} catch (e) {
  ctx.status = 500;
  console.error(e);
}
```
**Impact:** Same as above - incomplete Discord responses.

---

### 2. schedule.ts

#### Line 173: Null Reference - Team Lookup
**Severity:** HIGH
**Issue:** `teams.getTeamForId(requestedTeamId).teamId` called without null check
```typescript
const teamId = teams.getTeamForId(requestedTeamId).teamId
```
**Impact:** Crashes if team doesn't exist.
**Fix:** Add validation:
```typescript
const team = teams.getTeamForId(requestedTeamId);
if (!team) {
  throw new Error(`Team with ID ${requestedTeamId} not found`);
}
const teamId = team.teamId;
```

#### Line 216-218: Potential Null References in Loop
**Severity:** HIGH
**Issue:** Multiple `teams.getTeamForId()` calls without null checks inside game loop
```typescript
const isTeamAway = teams.getTeamForId(game.awayTeamId).teamId === teamId
const opponent = teams.getTeamForId(isTeamAway ? game.homeTeamId : game.awayTeamId)
```
**Impact:** Crashes if team data is incomplete.
**Fix:** Validate team exists before accessing properties.

#### Line 375, 394: Silent Errors in Try-Catch
**Severity:** LOW
**Issue:** Empty catch blocks swallow errors
```typescript
} catch (e) {
}
```
**Impact:** Errors go unnoticed, making debugging harder.
**Fix:** Add logging.

#### Line 444: Null Reference - Team Lookup
**Severity:** HIGH
**Issue:** `teams.getTeamForId(foundTeam.id).teamId` without validation
**Impact:** Crashes if team not found.

---

### 3. standings.ts

#### Line 175: Unsafe JSON Parse
**Severity:** MEDIUM
**Issue:** `JSON.parse(customId)` without try-catch
```typescript
const parsedId = JSON.parse(customId)
```
**Impact:** Crashes if customId contains invalid JSON.
**Fix:** Wrap in try-catch:
```typescript
try {
  const parsedId = JSON.parse(customId);
  if (parsedId.f != null) {
    return parsedId as StandingsPaginated;
  }
} catch (e) {
  console.error('Failed to parse standings custom ID:', e);
}
```

#### Line 215: Missing Null Check Before Function Call
**Severity:** MEDIUM
**Issue:** `leagueId` could be undefined before calling `handleCommand`
```typescript
if (leagueId) {
  handleCommand(client, interaction.token, leagueId, standingsFilter.f, standingsFilter.p)
}
```
**Impact:** Function called with undefined if leagueId is missing, but at least it's wrapped in if check.

---

### 4. teams.ts

#### Line 209: Missing Message ID Check
**Severity:** LOW
**Issue:** Attempts to delete message with potentially undefined messageId
```typescript
await client.deleteMessage(oldChannelId, oldMessageId || { id: "", id_type: DiscordIdType.MESSAGE })
```
**Impact:** Fallback handles it, but logs unnecessary errors.

#### Line 394: Missing Await on Async Function
**Severity:** MEDIUM
**Issue:** `handleCustomLogo()` is async but not awaited
```typescript
handleCustomLogo(guild_id, leagueId, client, command.token, url, teamToCustomize)
respond(ctx, deferMessage())
```
**Impact:** Errors in `handleCustomLogo` won't be caught. Function may fail silently.
**Fix:** Add await or properly handle the promise.

---

### 5. leaders.ts

#### Line 24, 38, 52, 66, 81: Null Team References
**Severity:** LOW
**Issue:** `teams.getTeamForId(stat.teamId)` could return undefined
```typescript
const team = teams.getTeamForId(stat.teamId)
message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName}) - ...`
```
**Impact:** Shows `undefined` in message if team doesn't exist. Uses optional chaining so doesn't crash.
**Fix:** Filter out stats with missing teams or show placeholder.

#### Line 39: Division By Zero Risk
**Severity:** MEDIUM
**Issue:** `stat.rushYds / stat.rushAtt` where `rushAtt` could be 0
```typescript
${(stat.rushYds / stat.rushAtt).toFixed(1)} YPC
```
**Impact:** Shows `Infinity` or `NaN` in message.
**Fix:** Check `rushAtt > 0` before dividing.

#### Line 108: Array Access Without Validation
**Severity:** MEDIUM
**Issue:** `schedule[0]?.weekIndex` assumes schedule has elements
```typescript
const currentWeek = schedule[0]?.weekIndex + 1 || 1
const currentSeason = schedule[0]?.seasonIndex || 0
```
**Impact:** Could fail if schedule is empty, but uses optional chaining and fallback, so relatively safe.

---

### 6. gamerecap.ts

#### Line 61-65, 72-73: Null Team References
**Severity:** HIGH
**Issue:** `teams.getTeamForId()` called without null checks
```typescript
const homeTeam = teams.getTeamForId(game.homeTeamId)
const awayTeam = teams.getTeamForId(game.awayTeamId)
const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
```
**Impact:** Crashes if team doesn't exist.
**Fix:** Validate teams exist before accessing properties.

#### Line 218-219: Null Team References
**Severity:** HIGH
**Issue:** Same issue in `generateRecap` function
```typescript
const homeTeamInfo = teams.getTeamForId(game.homeTeamId)
const awayTeamInfo = teams.getTeamForId(game.awayTeamId)
```
**Impact:** Crashes if team doesn't exist.

---

### 7. broadcasts.ts

#### Line 158: Unsafe JSON Parse
**Severity:** MEDIUM
**Issue:** `JSON.parse(customId)` without try-catch
```typescript
const listComponent = JSON.parse(customId) as ComponentId
```
**Impact:** Crashes if customId is invalid JSON.
**Fix:** Wrap in try-catch.

---

### 8. progression.ts

#### Line 96: Unsafe Non-Null Assertion
**Severity:** HIGH
**Issue:** Uses non-null assertion (!) on `find()` result
```typescript
const player = allPlayers.find(p => p.rosterId === perf.rosterId)!
```
**Impact:** Crashes if player not found (though unlikely since we're iterating from same list).
**Fix:** Add validation:
```typescript
const player = allPlayers.find(p => p.rosterId === perf.rosterId);
if (!player) {
  console.warn(`Player ${perf.rosterId} not found in allPlayers`);
  return;
}
```

#### Line 134-135, 147-148: Null Team References
**Severity:** MEDIUM
**Issue:** `teams.getTeamForId()` without null checks
```typescript
const team = teams.getTeamForId(change.player.teamId)
const teamEmoji = formatTeamEmoji(logos, team.abbrName)
```
**Impact:** Crashes if team doesn't exist.

---

### 9. powerrankings.ts

#### Line 137: Array Access Without Validation
**Severity:** LOW
**Issue:** `teamGameDataList[0]` accessed without checking if array is empty
```typescript
console.log(`🏆 Sample team data:`, JSON.stringify(teamGameDataList[0], null, 2))
```
**Impact:** Crashes if no teams (unlikely but possible).

#### Line 151: Unsafe Property Access
**Severity:** MEDIUM
**Issue:** `superBowlGame` could be undefined
```typescript
const isSeasonComplete = superBowlGame && superBowlGame.homeScore !== null
```
**Impact:** Actually safe because of `&&` short-circuit, but could be clearer.

#### Line 155-156, 175-176, 187, 201, 222: Null Team References
**Severity:** HIGH
**Issue:** Multiple `teams.getTeamForId()` calls without null checks
```typescript
const superBowlWinner = ... ? teams.getTeamForId(superBowlGame.homeTeamId) : teams.getTeamForId(superBowlGame.awayTeamId)
```
**Impact:** Crashes if team doesn't exist.

#### Line 185-186: Unsafe Non-Null Assertions
**Severity:** HIGH
**Issue:** Uses `!` on `find()` results
```typescript
const gameData = teamGameDataList.find(t => t.teamId === ranking.teamId)!
const standing = standings.find(s => s.teamId === ranking.teamId)!
```
**Impact:** Crashes if team not found in lists.

---

## RECOMMENDED FIXES

### High Priority (Fix Immediately)

1. **Add null checks for all `teams.getTeamForId()` calls**
   - Create a helper function:
   ```typescript
   function getTeamOrThrow(teams: TeamList, teamId: number) {
     const team = teams.getTeamForId(teamId);
     if (!team) {
       throw new Error(`Team ${teamId} not found`);
     }
     return team;
   }
   ```

2. **Fix all unsafe `JSON.parse()` calls**
   - Wrap in try-catch or use a safe parse helper

3. **Remove non-null assertions (!)**
   - Replace with proper validation

4. **Add error logging to all catch blocks**
   - Never silently swallow errors

### Medium Priority (Fix Soon)

1. **Division by zero checks**
   - Validate divisors before arithmetic operations

2. **Array access validation**
   - Check array length before accessing indices

3. **Await async functions**
   - Properly handle all promises

### Low Priority (Technical Debt)

1. **Improve error messages**
   - Provide more context in error messages for easier debugging

2. **Add input validation**
   - Validate all user inputs before processing

3. **Consistent error handling**
   - Standardize error responses across all commands

---

## TESTING RECOMMENDATIONS

1. **Test with missing/deleted teams**
   - Delete a team from database and try commands

2. **Test with malformed data**
   - Invalid JSON in custom IDs
   - Missing required fields

3. **Test edge cases**
   - Empty schedules
   - Division by zero scenarios
   - First/last weeks of season

4. **Test concurrent operations**
   - Multiple users triggering same command
   - Race conditions in async operations

---

## MONITORING RECOMMENDATIONS

1. **Add structured logging**
   - Log all errors with context (guild_id, command_name, user_id)

2. **Track error rates**
   - Monitor which commands fail most often

3. **Add alerts**
   - Alert on repeated failures or critical errors

---

**End of Report**
