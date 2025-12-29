import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { MaddenEvents } from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { TeamStats, Standing, MADDEN_SEASON } from "../../export/madden_league_types"
import db from "../../db/firebase"

type AggregatedTeamStats = {
  teamId: number
  teamName: string
  teamAbbr: string
  // Offensive stats
  offTotalYds: number
  offPassYds: number
  offRushYds: number
  offPassTDs: number
  offRushTDs: number
  off1stDowns: number
  offPtsPerGame: number
  off3rdDownConvPct: number
  off3rdDownConv: number
  off3rdDownAtt: number
  off4thDownConvPct: number
  off4thDownConv: number
  off4thDownAtt: number
  offRedZonePct: number
  offRedZoneTDs: number
  offRedZones: number
  offRedZoneFGs: number
  // Defensive stats
  defTotalYds: number
  defPassYds: number
  defRushYds: number
  defPtsPerGame: number
  defSacks: number
  defIntsRec: number
  defFumRec: number
  defForcedFum: number
  defRedZonePct: number
  defRedZoneTDs: number
  defRedZones: number
  // Penalties
  penalties: number
  // Turnover differential
  tODiff: number
  tOTakeaways: number
  tOGiveaways: number
  // Record
  totalWins: number
  totalLosses: number
  totalTies: number
  gamesPlayed: number
}

async function getSeasonTeamStats(leagueId: string): Promise<AggregatedTeamStats[]> {
  const leagueRef = db.collection("madden_data26").doc(leagueId)

  // Get all team stats for current season
  const teamStatsSnapshot = await leagueRef
    .collection(MaddenEvents.MADDEN_TEAM_STAT)
    .get()

  const allStats = teamStatsSnapshot.docs.map(d => d.data() as TeamStats)

  if (allStats.length === 0) {
    return []
  }

  // Find latest season
  const latestSeason = Math.max(...allStats.map(s => s.seasonIndex))
  const seasonStats = allStats.filter(s => s.seasonIndex === latestSeason)

  // Get teams and standings
  const [teams, standings] = await Promise.all([
    MaddenDB.getLatestTeams(leagueId),
    MaddenDB.getLatestStandings(leagueId)
  ])

  // Group by team and get most recent stats for each team
  const teamStatsMap = new Map<number, TeamStats>()

  for (const stat of seasonStats) {
    const existing = teamStatsMap.get(stat.teamId)
    if (!existing || stat.weekIndex > existing.weekIndex) {
      teamStatsMap.set(stat.teamId, stat)
    }
  }

  // Create aggregated stats with team info
  const aggregatedStats: AggregatedTeamStats[] = []

  for (const [teamId, stats] of teamStatsMap) {
    try {
      const team = teams.getTeamForId(teamId)
      const standing = standings.find(s => s.teamId === teamId)

      aggregatedStats.push({
        teamId,
        teamName: team.displayName,
        teamAbbr: team.abbrName,
        // Offensive
        offTotalYds: stats.offTotalYds || 0,
        offPassYds: stats.offPassYds || 0,
        offRushYds: stats.offRushYds || 0,
        offPassTDs: stats.offPassTDs || 0,
        offRushTDs: stats.offRushTds || 0,
        off1stDowns: stats.off1stDowns || 0,
        offPtsPerGame: stats.offPtsPerGame || 0,
        off3rdDownConvPct: stats.off3rdDownConvPct || 0,
        off3rdDownConv: stats.off3rdDownConv || 0,
        off3rdDownAtt: stats.off3rdDownAtt || 0,
        off4thDownConvPct: stats.off4thDownConvPct || 0,
        off4thDownConv: stats.off4thDownConv || 0,
        off4thDownAtt: stats.off4thDownAtt || 0,
        offRedZonePct: stats.offRedZonePct || 0,
        offRedZoneTDs: stats.offRedZoneTDs || 0,
        offRedZones: stats.offRedZones || 0,
        offRedZoneFGs: stats.offRedZoneFGs || 0,
        // Defensive
        defTotalYds: stats.defTotalYds || 0,
        defPassYds: stats.defPassYds || 0,
        defRushYds: stats.defRushYds || 0,
        defPtsPerGame: stats.defPtsPerGame || 0,
        defSacks: stats.defSacks || 0,
        defIntsRec: stats.defIntsRec || 0,
        defFumRec: stats.defFumRec || 0,
        defForcedFum: stats.defForcedFum || 0,
        defRedZonePct: stats.defRedZonePct || 0,
        defRedZoneTDs: stats.defRedZoneTDs || 0,
        defRedZones: stats.defRedZones || 0,
        // Penalties
        penalties: stats.penalties || 0,
        // Turnovers
        tODiff: stats.tODiff || 0,
        tOTakeaways: stats.tOTakeaways || 0,
        tOGiveaways: stats.tOGiveaways || 0,
        // Record
        totalWins: standing?.totalWins || stats.totalWins || 0,
        totalLosses: standing?.totalLosses || stats.totalLosses || 0,
        totalTies: standing?.totalTies || stats.totalTies || 0,
        gamesPlayed: (standing?.totalWins || 0) + (standing?.totalLosses || 0) + (standing?.totalTies || 0)
      })
    } catch (e) {
      // Skip teams that can't be found
      console.error(`Could not find team ${teamId}:`, e)
    }
  }

  return aggregatedStats
}

function formatRank(rank: number): string {
  if (rank === 1) return "**#1** 🥇"
  if (rank === 2) return "**#2** 🥈"
  if (rank === 3) return "**#3** 🥉"
  return `**#${rank}**`
}

async function showOffenseStats(token: string, client: DiscordClient, league: string) {
  try {
    const [stats, logos] = await Promise.all([
      getSeasonTeamStats(league),
      leagueLogosView.createView(league)
    ])

    if (stats.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: "# Team Offense Stats\n\nNo team stats found. Stats are recorded after games are played."
        }]
      })
      return
    }

    // Sort by total yards for main ranking
    const byTotalYds = [...stats].sort((a, b) => b.offTotalYds - a.offTotalYds)
    const byPassYds = [...stats].sort((a, b) => b.offPassYds - a.offPassYds)
    const byRushYds = [...stats].sort((a, b) => b.offRushYds - a.offRushYds)
    const byPPG = [...stats].sort((a, b) => b.offPtsPerGame - a.offPtsPerGame)

    let message = `# 🏈 Team Offense Rankings\n**${MADDEN_SEASON} Season**\n\n`

    // Points Per Game
    message += `## 📊 Points Per Game\n`
    byPPG.slice(0, 10).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.offPtsPerGame.toFixed(1)}** ppg\n`
    })

    // Total Yards
    message += `\n## 📏 Total Yards\n`
    byTotalYds.slice(0, 10).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      const ypg = team.gamesPlayed > 0 ? (team.offTotalYds / team.gamesPlayed).toFixed(1) : "0.0"
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.offTotalYds.toLocaleString()}** yds (${ypg}/g)\n`
    })

    // Passing Yards
    message += `\n## 🎯 Passing Yards\n`
    byPassYds.slice(0, 5).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.offPassYds.toLocaleString()}** yds (${team.offPassTDs} TD)\n`
    })

    // Rushing Yards
    message += `\n## 🏃🏿 Rushing Yards\n`
    byRushYds.slice(0, 5).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.offRushYds.toLocaleString()}** yds (${team.offRushTDs} TD)\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showOffenseStats:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show offense stats: ${e}`
      }]
    })
  }
}

async function showDefenseStats(token: string, client: DiscordClient, league: string) {
  try {
    const [stats, logos] = await Promise.all([
      getSeasonTeamStats(league),
      leagueLogosView.createView(league)
    ])

    if (stats.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: "# Team Defense Stats\n\nNo team stats found. Stats are recorded after games are played."
        }]
      })
      return
    }

    // Sort by total yards allowed (ascending = better defense)
    const byTotalYds = [...stats].sort((a, b) => a.defTotalYds - b.defTotalYds)
    const byPassYds = [...stats].sort((a, b) => a.defPassYds - b.defPassYds)
    const byRushYds = [...stats].sort((a, b) => a.defRushYds - b.defRushYds)
    const byPPG = [...stats].sort((a, b) => a.defPtsPerGame - b.defPtsPerGame)
    const bySacks = [...stats].sort((a, b) => b.defSacks - a.defSacks)
    const byTakeaways = [...stats].sort((a, b) => b.tOTakeaways - a.tOTakeaways)

    let message = `# 🛡️ Team Defense Rankings\n**${MADDEN_SEASON} Season**\n\n`

    // Points Allowed Per Game
    message += `## 📊 Points Allowed Per Game\n`
    byPPG.slice(0, 10).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.defPtsPerGame.toFixed(1)}** ppg\n`
    })

    // Total Yards Allowed
    message += `\n## 📏 Yards Allowed\n`
    byTotalYds.slice(0, 10).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      const ypg = team.gamesPlayed > 0 ? (team.defTotalYds / team.gamesPlayed).toFixed(1) : "0.0"
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.defTotalYds.toLocaleString()}** yds (${ypg}/g)\n`
    })

    // Sacks
    message += `\n## 💥 Sacks\n`
    bySacks.slice(0, 5).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.defSacks}** sacks\n`
    })

    // Takeaways
    message += `\n## 🏈 Takeaways\n`
    byTakeaways.slice(0, 5).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.tOTakeaways}** (${team.defIntsRec} INT, ${team.defFumRec} FR)\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showDefenseStats:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show defense stats: ${e}`
      }]
    })
  }
}

async function showOverallRankings(token: string, client: DiscordClient, league: string) {
  try {
    const [stats, logos, standings] = await Promise.all([
      getSeasonTeamStats(league),
      leagueLogosView.createView(league),
      MaddenDB.getLatestStandings(league)
    ])

    if (stats.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: "# Team Rankings\n\nNo team stats found. Stats are recorded after games are played."
        }]
      })
      return
    }

    // Calculate a power score (simple formula: PPG diff + turnover diff + yards diff)
    const rankedTeams = stats.map(team => {
      const ptDiff = team.offPtsPerGame - team.defPtsPerGame
      const ydDiff = ((team.offTotalYds - team.defTotalYds) / Math.max(team.gamesPlayed, 1)) / 10
      const score = ptDiff + team.tODiff + ydDiff
      return { ...team, powerScore: score, ptDiff }
    }).sort((a, b) => b.powerScore - a.powerScore)

    let message = `# 🏆 Team Power Rankings\n**${MADDEN_SEASON} Season**\n\n`

    rankedTeams.forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      const record = team.totalTies > 0
        ? `${team.totalWins}-${team.totalLosses}-${team.totalTies}`
        : `${team.totalWins}-${team.totalLosses}`
      const ptDiffStr = team.ptDiff >= 0 ? `+${team.ptDiff.toFixed(1)}` : team.ptDiff.toFixed(1)
      const toDiffStr = team.tODiff >= 0 ? `+${team.tODiff}` : `${team.tODiff}`

      message += `${formatRank(i + 1)} ${emoji} **${team.teamName}** (${record})\n`
      message += `> Pt Diff: ${ptDiffStr} | TO Diff: ${toDiffStr}\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showOverallRankings:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show rankings: ${e}`
      }]
    })
  }
}

async function showSituationalStats(token: string, client: DiscordClient, league: string) {
  try {
    const [stats, logos] = await Promise.all([
      getSeasonTeamStats(league),
      leagueLogosView.createView(league)
    ])

    if (stats.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: "# Situational Stats\n\nNo team stats found. Stats are recorded after games are played."
        }]
      })
      return
    }

    // Sort by various situational stats
    const by3rdDown = [...stats].sort((a, b) => b.off3rdDownConvPct - a.off3rdDownConvPct)
    const by4thDown = [...stats].filter(t => t.off4thDownAtt > 0).sort((a, b) => b.off4thDownConvPct - a.off4thDownConvPct)
    const byRedZone = [...stats].filter(t => t.offRedZones > 0).sort((a, b) => b.offRedZonePct - a.offRedZonePct)
    const byPenalties = [...stats].sort((a, b) => a.penalties - b.penalties) // ascending = better (fewer penalties)
    const byDefRedZone = [...stats].filter(t => t.defRedZones > 0).sort((a, b) => a.defRedZonePct - b.defRedZonePct) // ascending = better defense

    let message = `# 📋 Situational Stats\n**${MADDEN_SEASON} Season**\n\n`

    // 3rd Down Conversion
    message += `## 🔄 3rd Down Conversion %\n`
    by3rdDown.slice(0, 8).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.off3rdDownConvPct.toFixed(1)}%** (${team.off3rdDownConv}/${team.off3rdDownAtt})\n`
    })

    // 4th Down Conversion
    if (by4thDown.length > 0) {
      message += `\n## 🎲 4th Down Conversion %\n`
      by4thDown.slice(0, 5).forEach((team, i) => {
        const emoji = formatTeamEmoji(logos, team.teamAbbr)
        message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.off4thDownConvPct.toFixed(1)}%** (${team.off4thDownConv}/${team.off4thDownAtt})\n`
      })
    }

    // Red Zone Offense
    if (byRedZone.length > 0) {
      message += `\n## 🔴 Red Zone Efficiency\n`
      byRedZone.slice(0, 8).forEach((team, i) => {
        const emoji = formatTeamEmoji(logos, team.teamAbbr)
        message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.offRedZonePct.toFixed(1)}%** (${team.offRedZoneTDs} TD, ${team.offRedZoneFGs} FG / ${team.offRedZones} trips)\n`
      })
    }

    // Red Zone Defense
    if (byDefRedZone.length > 0) {
      message += `\n## 🛡️ Red Zone Defense\n`
      byDefRedZone.slice(0, 5).forEach((team, i) => {
        const emoji = formatTeamEmoji(logos, team.teamAbbr)
        message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.defRedZonePct.toFixed(1)}%** allowed (${team.defRedZoneTDs} TD / ${team.defRedZones} trips)\n`
      })
    }

    // Fewest Penalties
    message += `\n## ⚠️ Fewest Penalties\n`
    byPenalties.slice(0, 5).forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      const perGame = team.gamesPlayed > 0 ? (team.penalties / team.gamesPlayed).toFixed(1) : '0.0'
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${team.penalties}** penalties (${perGame}/g)\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showSituationalStats:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show situational stats: ${e}`
      }]
    })
  }
}

async function showTurnoverStats(token: string, client: DiscordClient, league: string) {
  try {
    const [stats, logos] = await Promise.all([
      getSeasonTeamStats(league),
      leagueLogosView.createView(league)
    ])

    if (stats.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: "# Turnover Stats\n\nNo team stats found. Stats are recorded after games are played."
        }]
      })
      return
    }

    const byTODiff = [...stats].sort((a, b) => b.tODiff - a.tODiff)
    const byTakeaways = [...stats].sort((a, b) => b.tOTakeaways - a.tOTakeaways)
    const byGiveaways = [...stats].sort((a, b) => a.tOGiveaways - b.tOGiveaways) // ascending = better

    let message = `# 🔄 Turnover Rankings\n**${MADDEN_SEASON} Season**\n\n`

    // Turnover Differential
    message += `## ⚖️ Turnover Differential\n`
    byTODiff.forEach((team, i) => {
      const emoji = formatTeamEmoji(logos, team.teamAbbr)
      const diffStr = team.tODiff >= 0 ? `+${team.tODiff}` : `${team.tODiff}`
      message += `${formatRank(i + 1)} ${emoji} ${team.teamAbbr} — **${diffStr}** (${team.tOTakeaways} TO, ${team.tOGiveaways} GO)\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showTurnoverStats:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show turnover stats: ${e}`
      }]
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

    if (!command.data.options) {
      throw new Error("teamstats command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    respond(ctx, deferMessage())

    if (subCommand.name === "offense") {
      showOffenseStats(command.token, client, league)
    } else if (subCommand.name === "defense") {
      showDefenseStats(command.token, client, league)
    } else if (subCommand.name === "rankings") {
      showOverallRankings(command.token, client, league)
    } else if (subCommand.name === "turnovers") {
      showTurnoverStats(command.token, client, league)
    } else if (subCommand.name === "situational") {
      showSituationalStats(command.token, client, league)
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "teamstats",
      description: "View team statistical rankings",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "offense",
          description: "View offensive team rankings (yards, points, passing, rushing)"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "defense",
          description: "View defensive team rankings (yards allowed, points allowed, sacks, takeaways)"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "rankings",
          description: "View overall team power rankings"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "turnovers",
          description: "View turnover differential rankings"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "situational",
          description: "View 3rd/4th down, red zone, and penalty stats"
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler
