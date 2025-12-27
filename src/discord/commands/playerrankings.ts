import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { PlayerStatType } from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, PassingStats, RushingStats, ReceivingStats, DefensiveStats } from "../../export/madden_league_types"

async function generatePlayerRankings(token: string, client: DiscordClient, league: string) {
  try {
    console.log(`🏅 generatePlayerRankings called: league=${league}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# NEL Player Rankings\n\n⏳ Analyzing player performance across all positions..."
        }
      ]
    })

    const [teams, logos, weeks] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league)
    ])

    console.log(`🏅 Total weeks in database: ${weeks.length}`)

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0
    const currentWeekIndex = weeks[0]?.weekIndex || 0

    // Determine target season
    let targetSeasonIndex = currentSeasonIndex
    const currentSeasonWeeks = weeks.filter(w => w.seasonIndex === currentSeasonIndex)
    if (currentSeasonWeeks.length === 0 || currentWeekIndex === 0) {
      const availableSeasons = [...new Set(weeks.map(w => w.seasonIndex))].sort((a, b) => b - a)
      for (const season of availableSeasons) {
        if (season < currentSeasonIndex) {
          const seasonWeeks = weeks.filter(w => w.seasonIndex === season)
          if (seasonWeeks.length > 0) {
            targetSeasonIndex = season
            break
          }
        }
      }
    }

    // Get weeks for target season (regular season only)
    const seasonWeeks = weeks.filter(w =>
      w.seasonIndex === targetSeasonIndex &&
      w.weekIndex >= 0 && w.weekIndex <= 17
    )

    if (seasonWeeks.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🏅 NEL PLAYER RANKINGS\n\n⚠️ No regular season data found for season ${MADDEN_SEASON + targetSeasonIndex}.`
          }
        ]
      })
      return
    }

    // Aggregate stats across all weeks
    const allPassingStats: PassingStats[] = []
    const allRushingStats: RushingStats[] = []
    const allReceivingStats: ReceivingStats[] = []
    const allDefensiveStats: DefensiveStats[] = []

    for (const week of seasonWeeks) {
      try {
        const weeklyStats = await MaddenDB.getWeeklyStats(league, targetSeasonIndex, week.weekIndex)

        if (weeklyStats[PlayerStatType.PASSING]) {
          allPassingStats.push(...(weeklyStats[PlayerStatType.PASSING] as PassingStats[]))
        }
        if (weeklyStats[PlayerStatType.RUSHING]) {
          allRushingStats.push(...(weeklyStats[PlayerStatType.RUSHING] as RushingStats[]))
        }
        if (weeklyStats[PlayerStatType.RECEIVING]) {
          allReceivingStats.push(...(weeklyStats[PlayerStatType.RECEIVING] as ReceivingStats[]))
        }
        if (weeklyStats[PlayerStatType.DEFENSE]) {
          allDefensiveStats.push(...(weeklyStats[PlayerStatType.DEFENSE] as DefensiveStats[]))
        }
      } catch (e) {
        console.log(`⚠️ Failed to fetch week ${week.weekIndex}: ${e}`)
      }
    }

    // Aggregate by player
    const passingByPlayer = new Map<string, PassingStats>()
    const rushingByPlayer = new Map<string, RushingStats>()
    const receivingByPlayer = new Map<string, ReceivingStats>()
    const defenseByPlayer = new Map<string, DefensiveStats>()

    allPassingStats.forEach(stat => {
      const key = `${stat.rosterId}`
      const existing = passingByPlayer.get(key)
      if (existing) {
        existing.passYds += stat.passYds
        existing.passTDs += stat.passTDs
        existing.passInts += stat.passInts
        existing.passAtt += stat.passAtt
        existing.passComp += stat.passComp
        existing.passCompPct = (existing.passComp / existing.passAtt) * 100
      } else {
        passingByPlayer.set(key, { ...stat })
      }
    })

    allRushingStats.forEach(stat => {
      const key = `${stat.rosterId}`
      const existing = rushingByPlayer.get(key)
      if (existing) {
        existing.rushYds += stat.rushYds
        existing.rushTDs += stat.rushTDs
        existing.rushAtt += stat.rushAtt
        existing.rushYdsPerAtt = existing.rushYds / existing.rushAtt
      } else {
        rushingByPlayer.set(key, { ...stat })
      }
    })

    allReceivingStats.forEach(stat => {
      const key = `${stat.rosterId}`
      const existing = receivingByPlayer.get(key)
      if (existing) {
        existing.recYds += stat.recYds
        existing.recTDs += stat.recTDs
        existing.recCatches += stat.recCatches
        existing.recYdsPerCatch = existing.recYds / existing.recCatches
        existing.recLongest = Math.max(existing.recLongest, stat.recLongest)
      } else {
        receivingByPlayer.set(key, { ...stat })
      }
    })

    allDefensiveStats.forEach(stat => {
      const key = `${stat.rosterId}`
      const existing = defenseByPlayer.get(key)
      if (existing) {
        existing.defTotalTackles += stat.defTotalTackles
        existing.defSacks += stat.defSacks
        existing.defInts += stat.defInts
        existing.defForcedFum += stat.defForcedFum
        existing.defSafeties += stat.defSafeties
        existing.defTDs += stat.defTDs
      } else {
        defenseByPlayer.set(key, { ...stat })
      }
    })

    // Build display message
    const displaySeason = targetSeasonIndex !== currentSeasonIndex ? `${MADDEN_SEASON + targetSeasonIndex} (Final)` : `${MADDEN_SEASON + currentSeasonIndex}`
    let message = `# 🏅 NEL PLAYER RANKINGS\n`
    message += `## Season ${displaySeason}\n\n`

    // QB Rankings
    const topQBs = Array.from(passingByPlayer.values())
      .sort((a, b) => b.passYds - a.passYds)
      .slice(0, 5)

    if (topQBs.length > 0) {
      message += `### 🎯 Quarterback Rankings\n`
      topQBs.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.passYds} YDS, ${stat.passTDs} TD, ${stat.passInts} INT (${stat.passCompPct.toFixed(1)}% Comp)\n`
      })
      message += `\n`
    }

    // RB Rankings
    const topRBs = Array.from(rushingByPlayer.values())
      .filter(s => s.rushAtt >= 50)
      .sort((a, b) => b.rushYds - a.rushYds)
      .slice(0, 5)

    if (topRBs.length > 0) {
      message += `### 🏃 Running Back Rankings\n`
      topRBs.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.rushYds} YDS, ${stat.rushTDs} TD, ${stat.rushAtt} ATT (${stat.rushYdsPerAtt.toFixed(1)} YPC)\n`
      })
      message += `\n`
    }

    // WR/TE Rankings
    const topReceivers = Array.from(receivingByPlayer.values())
      .filter(s => s.recCatches >= 20)
      .sort((a, b) => b.recYds - a.recYds)
      .slice(0, 5)

    if (topReceivers.length > 0) {
      message += `### 🙌 Receiver Rankings\n`
      topReceivers.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.recYds} YDS, ${stat.recTDs} TD, ${stat.recCatches} REC (${stat.recYdsPerCatch.toFixed(1)} YPC)\n`
      })
      message += `\n`
    }

    // Defensive Rankings
    const topTacklers = Array.from(defenseByPlayer.values())
      .sort((a, b) => b.defTotalTackles - a.defTotalTackles)
      .slice(0, 5)

    if (topTacklers.length > 0) {
      message += `### 🛡️ Defensive Leaders (Tackles)\n`
      topTacklers.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.defTotalTackles} TKL, ${stat.defSacks} SK, ${stat.defInts} INT\n`
      })
      message += `\n`
    }

    const topSackers = Array.from(defenseByPlayer.values())
      .filter(s => s.defSacks > 0)
      .sort((a, b) => b.defSacks - a.defSacks)
      .slice(0, 5)

    if (topSackers.length > 0) {
      message += `### 💥 Sack Leaders\n`
      topSackers.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.defSacks} SK, ${stat.defTotalTackles} TKL, ${stat.defForcedFum} FF\n`
      })
      message += `\n`
    }

    const topDBs = Array.from(defenseByPlayer.values())
      .filter(s => s.defInts > 0)
      .sort((a, b) => b.defInts - a.defInts)
      .slice(0, 5)

    if (topDBs.length > 0) {
      message += `### 🦅 Interception Leaders\n`
      topDBs.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
        message += `${idx + 1}. ${teamEmoji} **${stat.fullName}** • ${stat.defInts} INT, ${stat.defTotalTackles} TKL, ${stat.defTDs} TD\n`
      })
    }

    message += `\n───────────────────────\n`
    message += `Season stats aggregated across ${seasonWeeks.length} regular season games`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

  } catch (e) {
    console.error("❌ Error in generatePlayerRankings:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate player rankings: ${e}`
        }
      ]
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id } = command

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    respond(ctx, deferMessage())
    generatePlayerRankings(command.token, client, league)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "playerrankings",
      description: "View top players by position across the season",
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler
