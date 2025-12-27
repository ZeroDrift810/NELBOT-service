/**
 * Contract Signing Notifier
 * Detects when players sign contracts and posts notifications to Discord
 */

import EventDB, { SnallabotEvent } from "../db/events_db"
import { MaddenEvents } from "../db/madden_db"
import { Player } from "../export/madden_league_types"
import LeagueSettingsDB, { DiscordIdType } from "./settings_db"
import { createProdClient } from "./discord_utils"
import { leagueLogosView } from "../db/view"
import MaddenDB from "../db/madden_db"

// Cache to track previous player contract states
// Key: leagueId_rosterId, Value: contract state
type ContractState = {
  teamId: number
  isFreeAgent: boolean
  contractSalary: number
  contractBonus: number
  contractLength: number
  contractYearsLeft: number
}

const playerContractCache: Map<string, ContractState> = new Map()

function getCacheKey(leagueId: string, rosterId: number): string {
  return `${leagueId}_${rosterId}`
}

function formatMoney(m: number): string {
  if (m >= 1000000) {
    return `$${(m / 1000000).toFixed(2)}M`
  } else if (m >= 1000) {
    return `$${(m / 1000).toFixed(0)}K`
  }
  return `$${m.toLocaleString()}`
}

function getTeamEmoji(teamAbbr: string, logos: { [key: string]: any }): string {
  const customLogo = logos[teamAbbr]
  if (customLogo?.emojiId) {
    return `<:${teamAbbr}:${customLogo.emojiId}>`
  }
  return `**${teamAbbr}**`
}

async function formatSigningNotification(
  player: Player,
  leagueId: string,
  wasResigning: boolean
): Promise<string> {
  const [teams, logos] = await Promise.all([
    MaddenDB.getLatestTeams(leagueId),
    leagueLogosView.createView(leagueId)
  ])

  const team = teams.getTeamForId(player.teamId)
  const teamAbbr = team?.abbrName || "FA"
  const teamEmoji = getTeamEmoji(teamAbbr, logos)
  const teamName = team?.displayName || "Unknown Team"

  const totalValue = (player.contractSalary * player.contractLength) + player.contractBonus
  const signingType = wasResigning ? "RE-SIGNED" : "SIGNED"

  return `## ${teamEmoji} ${signingType}: ${player.position} ${player.firstName} ${player.lastName}

**${player.playerBestOvr} OVR** | Age ${player.age} | ${player.yearsPro} yrs pro

### 📋 Contract Details
> **Team:** ${teamName}
> **Total Value:** ${formatMoney(totalValue)}
> **Length:** ${player.contractLength} years
> **Base Salary:** ${formatMoney(player.contractSalary)}/yr
> **Signing Bonus:** ${formatMoney(player.contractBonus)}
> **Cap Hit:** ${formatMoney(player.capHit)}`
}

async function handlePlayerEvents(events: SnallabotEvent<Player>[]): Promise<void> {
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
      const settingsWithTransactions = allSettings.filter(s => s.commands.transactions?.channel)

      if (settingsWithTransactions.length === 0) {
        // No guilds configured for transaction notifications
        // Still update the cache
        for (const playerEvent of playerEvents) {
          const cacheKey = getCacheKey(leagueId, playerEvent.rosterId)
          playerContractCache.set(cacheKey, {
            teamId: playerEvent.teamId,
            isFreeAgent: playerEvent.isFreeAgent,
            contractSalary: playerEvent.contractSalary,
            contractBonus: playerEvent.contractBonus,
            contractLength: playerEvent.contractLength,
            contractYearsLeft: playerEvent.contractYearsLeft
          })
        }
        continue
      }

      // Check for contract signings
      const signings: { player: Player, wasResigning: boolean }[] = []

      for (const playerEvent of playerEvents) {
        const cacheKey = getCacheKey(leagueId, playerEvent.rosterId)
        const previousState = playerContractCache.get(cacheKey)

        // Detect new signing
        if (previousState) {
          const wasFreeAgent = previousState.isFreeAgent || previousState.teamId === 0
          const isNowSigned = !playerEvent.isFreeAgent && playerEvent.teamId !== 0

          if (wasFreeAgent && isNowSigned && playerEvent.contractLength > 0) {
            // Player was free agent, now signed
            signings.push({ player: playerEvent, wasResigning: false })
          } else if (!wasFreeAgent && isNowSigned) {
            // Check for contract extension/re-signing (same team, new contract)
            const sameTeam = previousState.teamId === playerEvent.teamId
            const newContract = (
              previousState.contractYearsLeft !== playerEvent.contractYearsLeft ||
              previousState.contractSalary !== playerEvent.contractSalary ||
              previousState.contractLength !== playerEvent.contractLength
            )
            // Only notify if contract years went UP (extension) or salary changed significantly
            const isExtension = playerEvent.contractYearsLeft > previousState.contractYearsLeft

            if (sameTeam && newContract && isExtension && playerEvent.contractLength > 0) {
              signings.push({ player: playerEvent, wasResigning: true })
            }
          }
        }

        // Update cache
        playerContractCache.set(cacheKey, {
          teamId: playerEvent.teamId,
          isFreeAgent: playerEvent.isFreeAgent,
          contractSalary: playerEvent.contractSalary,
          contractBonus: playerEvent.contractBonus,
          contractLength: playerEvent.contractLength,
          contractYearsLeft: playerEvent.contractYearsLeft
        })
      }

      // Post notifications for signings
      if (signings.length > 0) {
        const client = createProdClient()

        for (const settings of settingsWithTransactions) {
          const channel = settings.commands.transactions!.channel

          for (const { player, wasResigning } of signings) {
            try {
              const message = await formatSigningNotification(player, leagueId, wasResigning)
              await client.createMessage(channel, message, [])
              console.log(`[CONTRACT] Posted signing notification: ${player.firstName} ${player.lastName} to ${settings.guildId}`)
            } catch (e) {
              console.error(`[CONTRACT] Failed to post signing notification: ${e}`)
            }
          }
        }
      }
    } catch (e) {
      console.error(`[CONTRACT] Error processing league ${leagueId}: ${e}`)
    }
  }
}

// Initialize cache from database for a league
async function initializeCacheForLeague(leagueId: string): Promise<void> {
  try {
    const players = await MaddenDB.getLatestPlayers(leagueId)
    for (const player of players) {
      const cacheKey = getCacheKey(leagueId, player.rosterId)
      playerContractCache.set(cacheKey, {
        teamId: player.teamId,
        isFreeAgent: player.isFreeAgent,
        contractSalary: player.contractSalary,
        contractBonus: player.contractBonus,
        contractLength: player.contractLength,
        contractYearsLeft: player.contractYearsLeft
      })
    }
    console.log(`[CONTRACT] Initialized cache with ${players.length} players for league ${leagueId}`)
  } catch (e) {
    console.error(`[CONTRACT] Failed to initialize cache for league ${leagueId}: ${e}`)
  }
}

// Register the notifier
export function registerContractNotifier(): void {
  EventDB.on<Player>(MaddenEvents.MADDEN_PLAYER, handlePlayerEvents)
  console.log("[CONTRACT] Contract signing notifier registered")
}

// Initialize caches for all configured leagues
export async function initializeContractCaches(): Promise<void> {
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
      await initializeCacheForLeague(leagueId)
    }

    console.log(`[CONTRACT] Initialized caches for ${leagueIds.size} leagues`)
  } catch (e) {
    console.error(`[CONTRACT] Failed to initialize caches: ${e}`)
  }
}
