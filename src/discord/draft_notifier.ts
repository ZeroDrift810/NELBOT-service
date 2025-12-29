/**
 * Draft Pick Notifier
 * Detects when new rookies are drafted and posts notifications to Discord
 * Also stores draft pick data for historical tracking
 */

import EventDB, { SnallabotEvent } from "../db/events_db"
import MaddenDB, { MaddenEvents, DraftPick } from "../db/madden_db"
import { Player, MADDEN_SEASON } from "../export/madden_league_types"

// Calculate the calendar year for rookies based on season index
// MADDEN_SEASON is 2025 (Season 0), so Season 2 = 2027
function getRookieYearForSeason(seasonIndex: number): number {
  return MADDEN_SEASON + seasonIndex
}
import LeagueSettingsDB, { DiscordIdType } from "./settings_db"
import { createProdClient } from "./discord_utils"
import { leagueLogosView } from "../db/view"

// Cache to track players we've already processed for draft picks
// Key: leagueId_rosterId, Value: true if already processed
const processedRookiesCache: Map<string, boolean> = new Map()

function getCacheKey(leagueId: string, rosterId: number): string {
  return `${leagueId}_${rosterId}`
}

function getDevTraitDisplay(devTrait: number): string {
  switch (devTrait) {
    case 0: return "Normal"
    case 1: return "⭐ Star"
    case 2: return "⭐⭐ Superstar"
    case 3: return "⭐⭐⭐ X-Factor"
    default: return "Normal"
  }
}

function getDevTraitEmoji(devTrait: number): string {
  switch (devTrait) {
    case 0: return "🔵" // Normal
    case 1: return "⭐" // Star
    case 2: return "🌟" // Superstar
    case 3: return "💫" // X-Factor
    default: return "🔵"
  }
}

function getTeamEmoji(teamAbbr: string, logos: { [key: string]: any }): string {
  const customLogo = logos[teamAbbr]
  if (customLogo?.emojiId) {
    return `<:${teamAbbr}:${customLogo.emojiId}>`
  }
  return `**${teamAbbr}**`
}

function getOvrColor(ovr: number): string {
  if (ovr >= 80) return "🟢"
  if (ovr >= 70) return "🟡"
  if (ovr >= 60) return "🟠"
  return "🔴"
}

async function formatDraftPickNotification(
  pick: DraftPick,
  logos: { [key: string]: any }
): Promise<string> {
  const teamEmoji = getTeamEmoji(pick.teamAbbrName, logos)
  const devDisplay = getDevTraitDisplay(pick.devTrait as unknown as number)
  const devEmoji = getDevTraitEmoji(pick.devTrait as unknown as number)
  const ovrColor = getOvrColor(pick.draftedOvr)

  return `## ${teamEmoji} DRAFT PICK: Round ${pick.round}, Pick ${pick.pick}

**${pick.position} ${pick.firstName} ${pick.lastName}**
> ${ovrColor} **${pick.draftedOvr} OVR** | Age ${pick.age}
> ${devEmoji} **Dev:** ${devDisplay}
> 🎓 **College:** ${pick.college}`
}

async function handlePlayerEventsForDraft(events: SnallabotEvent<Player>[]): Promise<void> {
  // Group events by league
  const eventsByLeague = new Map<string, SnallabotEvent<Player>[]>()

  for (const event of events) {
    const leagueId = event.key
    if (!eventsByLeague.has(leagueId)) {
      eventsByLeague.set(leagueId, [])
    }
    eventsByLeague.get(leagueId)!.push(event)
  }

  // Process each league's events
  for (const [leagueId, playerEvents] of eventsByLeague) {
    try {
      // Get settings for guilds connected to this league
      const allSettings = await LeagueSettingsDB.getLeagueSettingsForLeagueId(leagueId)

      // Find settings with draft channel configured
      const settingsWithDraft = allSettings.filter(s => s.commands.draft?.channel)

      // Get teams for this league
      const teams = await MaddenDB.getLatestTeams(leagueId)
      const logos = await leagueLogosView.createView(leagueId)

      // Track new draft picks found in this batch
      const newDraftPicks: DraftPick[] = []

      for (const playerEvent of playerEvents) {
        // Check if this player has valid draft data
        const hasValidDraftData = playerEvent.draftRound >= 1 && playerEvent.draftRound <= 7 &&
                                   playerEvent.draftPick >= 1 && playerEvent.draftPick <= 32

        // Derive the season index from the player's rookieYear
        // rookieYear is a calendar year (e.g., 2028), so seasonIndex = rookieYear - MADDEN_SEASON
        const playerSeasonIndex = playerEvent.rookieYear - MADDEN_SEASON

        // Only process current/recent rookies (seasonIndex >= 0 means they're from this or future seasons)
        const isValidRookie = playerSeasonIndex >= 0

        if (!isValidRookie || !hasValidDraftData) {
          continue
        }

        // Check cache first (fast)
        const cacheKey = getCacheKey(leagueId, playerEvent.rosterId)
        if (processedRookiesCache.has(cacheKey)) {
          continue
        }

        // Check database to see if we already have this draft pick
        const alreadyStored = await MaddenDB.hasDraftPick(leagueId, playerSeasonIndex, String(playerEvent.rosterId))
        if (alreadyStored) {
          processedRookiesCache.set(cacheKey, true)
          continue
        }

        // Get team info
        const team = playerEvent.teamId !== 0 ? teams.getTeamForId(playerEvent.teamId) : null
        const teamAbbrName = team?.abbrName || "FA"

        // Calculate overall pick number
        const overallPick = (playerEvent.draftRound - 1) * 32 + playerEvent.draftPick

        // Create draft pick record
        const draftPick: DraftPick = {
          leagueId,
          seasonIndex: playerSeasonIndex,
          round: playerEvent.draftRound,
          pick: playerEvent.draftPick,
          overallPick,
          teamId: playerEvent.teamId,
          teamAbbrName,
          rosterId: String(playerEvent.rosterId),
          firstName: playerEvent.firstName,
          lastName: playerEvent.lastName,
          position: playerEvent.position,
          college: playerEvent.college || "Unknown",
          draftedOvr: playerEvent.playerBestOvr,
          devTrait: String(playerEvent.devTrait),
          age: playerEvent.age,
          capturedAt: new Date()
        }

        // Store in database
        await MaddenDB.storeDraftPick(draftPick)
        console.log(`[DRAFT] Stored pick: Rd ${draftPick.round}.${draftPick.pick} ${draftPick.firstName} ${draftPick.lastName} (Season ${playerSeasonIndex})`)

        // Mark as processed
        processedRookiesCache.set(cacheKey, true)

        newDraftPicks.push(draftPick)
      }

      // Post notifications for new draft picks
      if (newDraftPicks.length > 0 && settingsWithDraft.length === 0) {
        console.log(`[DRAFT] Found ${newDraftPicks.length} draft picks but no draft channel configured. Use /draft configure to set one.`)
      }
      if (newDraftPicks.length > 0 && settingsWithDraft.length > 0) {
        // Sort by round and pick
        newDraftPicks.sort((a, b) => a.overallPick - b.overallPick)

        const client = createProdClient()

        for (const settings of settingsWithDraft) {
          const channel = settings.commands.draft!.channel

          for (const pick of newDraftPicks) {
            try {
              const message = await formatDraftPickNotification(pick, logos)
              await client.createMessage(channel, message, [])
              console.log(`[DRAFT] Posted pick notification: Rd ${pick.round} Pick ${pick.pick} - ${pick.firstName} ${pick.lastName} to ${settings.guildId}`)
            } catch (e) {
              console.error(`[DRAFT] Failed to post pick notification: ${e}`)
            }
          }
        }
      }
    } catch (e) {
      console.error(`[DRAFT] Error processing league ${leagueId}: ${e}`)
    }
  }
}

// Initialize cache from database for a league
async function initializeDraftCacheForLeague(leagueId: string): Promise<void> {
  try {
    const weeks = await MaddenDB.getAllWeeks(leagueId)
    if (weeks.length === 0) {
      return
    }
    const currentSeasonIndex = Math.max(...weeks.map(w => w.seasonIndex))

    // Get all draft picks for current season
    const draftPicks = await MaddenDB.getDraftPicks(leagueId, currentSeasonIndex)
    for (const pick of draftPicks) {
      const cacheKey = getCacheKey(leagueId, parseInt(pick.rosterId))
      processedRookiesCache.set(cacheKey, true)
    }
    console.log(`[DRAFT] Initialized cache with ${draftPicks.length} picks for league ${leagueId}`)
  } catch (e) {
    console.error(`[DRAFT] Failed to initialize cache for league ${leagueId}: ${e}`)
  }
}

// Register the notifier
export function registerDraftNotifier(): void {
  EventDB.on<Player>(MaddenEvents.MADDEN_PLAYER, handlePlayerEventsForDraft)
  console.log("[DRAFT] Draft pick notifier registered")
}

// Initialize caches for all configured leagues
export async function initializeDraftCaches(): Promise<void> {
  try {
    const allSettings = await LeagueSettingsDB.getAllLeagueSettings()
    const leagueIds = new Set<string>()

    for (const settings of allSettings) {
      const leagueId = settings.commands.madden_league?.league_id
      if (leagueId) {
        leagueIds.add(leagueId)
      }
    }

    for (const leagueId of leagueIds) {
      await initializeDraftCacheForLeague(leagueId)
    }

    console.log(`[DRAFT] Initialized caches for ${leagueIds.size} leagues`)
  } catch (e) {
    console.error(`[DRAFT] Failed to initialize caches: ${e}`)
  }
}
