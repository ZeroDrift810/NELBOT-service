import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, createMessageResponse, DiscordClient, deferMessage, NoConnectedLeagueError } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataStringOption, ApplicationCommandOptionType, ApplicationCommandType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { discordLeagueView } from "../../db/view"
import MaddenDB, { PlayerStatType } from "../../db/madden_db"
import { DefensiveStats, KickingStats, PassingStats, PuntingStats, ReceivingStats, RushingStats } from "../../export/madden_league_types"

async function formatLeaders(client: DiscordClient, token: string, leagueId: string, week: number, season: number, category: string) {
  const weeklyStats = await MaddenDB.getWeeklyStats(leagueId, season, week)
  const teams = await MaddenDB.getLatestTeams(leagueId)

  let message = `# Week ${week} Stat Leaders\n\n`

  if (category === "passing" || category === "all") {
    const passingStats = (weeklyStats[PlayerStatType.PASSING] || []) as PassingStats[]
    const topPassers = passingStats
      .sort((a, b) => b.passYds - a.passYds)
      .slice(0, 10)

    message += `## 🎯 Passing Leaders\n`
    topPassers.forEach((stat, idx) => {
      const team = teams.getTeamForId(stat.teamId)
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.passYds} YDS, ${stat.passTDs} TD, ${stat.passInts} INT, ${stat.passCompPct.toFixed(1)}% Comp\n`
    })
    message += `\n`
  }

  if (category === "rushing" || category === "all") {
    const rushingStats = (weeklyStats[PlayerStatType.RUSHING] || []) as RushingStats[]
    const topRushers = rushingStats
      .sort((a, b) => b.rushYds - a.rushYds)
      .slice(0, 10)

    message += `## 🏃 Rushing Leaders\n`
    topRushers.forEach((stat, idx) => {
      const team = teams.getTeamForId(stat.teamId)
      const ypc = stat.rushAtt > 0 ? (stat.rushYds / stat.rushAtt).toFixed(1) : '0.0'
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.rushYds} YDS, ${stat.rushTDs} TD, ${stat.rushAtt} ATT, ${ypc} YPC\n`
    })
    message += `\n`
  }

  if (category === "receiving" || category === "all") {
    const receivingStats = (weeklyStats[PlayerStatType.RECEIVING] || []) as ReceivingStats[]
    const topReceivers = receivingStats
      .sort((a, b) => b.recYds - a.recYds)
      .slice(0, 10)

    message += `## 🙌 Receiving Leaders\n`
    topReceivers.forEach((stat, idx) => {
      const team = teams.getTeamForId(stat.teamId)
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.recYds} YDS, ${stat.recTDs} TD, ${stat.recCatches} Catches, ${stat.recLongest} Long\n`
    })
    message += `\n`
  }

  if (category === "defense" || category === "all") {
    const defensiveStats = (weeklyStats[PlayerStatType.DEFENSE] || []) as DefensiveStats[]
    const topDefenders = defensiveStats
      .sort((a, b) => b.defTotalTackles - a.defTotalTackles)
      .slice(0, 10)

    message += `## 🛡️ Defensive Leaders (Tackles)\n`
    topDefenders.forEach((stat, idx) => {
      const team = teams.getTeamForId(stat.teamId)
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.defTotalTackles} Total, ${stat.defSacks} Sacks, ${stat.defInts} INT, ${stat.defForcedFum} FF\n`
    })
    message += `\n`
  }

  if (category === "kicking" || category === "all") {
    const kickingStats = (weeklyStats[PlayerStatType.KICKING] || []) as KickingStats[]
    const topKickers = kickingStats
      .filter(k => k.fGAtt > 0)
      .sort((a, b) => (b.fGMade / b.fGAtt) - (a.fGMade / a.fGAtt))
      .slice(0, 5)

    message += `## 🦶 Kicking Leaders\n`
    topKickers.forEach((stat, idx) => {
      const team = teams.getTeamForId(stat.teamId)
      const fgPct = stat.fGAtt > 0 ? ((stat.fGMade / stat.fGAtt) * 100).toFixed(1) : '0.0'
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.fGMade}/${stat.fGAtt} FG (${fgPct}%), Long: ${stat.fGLongest}, XP: ${stat.xPMade}/${stat.xPAtt}\n`
    })
    message += `\n`
  }

  await client.editOriginalInteraction(token, { content: message })
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token } = command
    respond(ctx, deferMessage())

    const discordLeague = await discordLeagueView.createView(guild_id)
    if (!discordLeague) {
      throw new NoConnectedLeagueError(guild_id)
    }

    const options = command.data.options || []
    const weekOption = options.find(o => o.name === "week") as APIApplicationCommandInteractionDataIntegerOption | undefined
    const seasonOption = options.find(o => o.name === "season") as APIApplicationCommandInteractionDataIntegerOption | undefined
    const categoryOption = options.find(o => o.name === "category") as APIApplicationCommandInteractionDataStringOption | undefined

    // Get current week if not specified
    const schedule = await MaddenDB.getLatestSchedule(discordLeague.leagueId)
    const currentWeek = schedule[0]?.weekIndex + 1 || 1
    const currentSeason = schedule[0]?.seasonIndex || 0

    const week = weekOption ? Number(weekOption.value) : currentWeek
    const season = seasonOption ? Number(seasonOption.value) : currentSeason
    const category = categoryOption ? categoryOption.value : "all"

    await formatLeaders(client, token, discordLeague.leagueId, week, season, category)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "leaders",
      description: "View top performers for any week",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "week",
          description: "Week number (defaults to current week)",
          required: false,
          min_value: 1,
          max_value: 23
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: "season",
          description: "Season index (defaults to current season)",
          required: false,
          min_value: 0
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "category",
          description: "Stat category to view (defaults to all)",
          required: false,
          choices: [
            { name: "All Categories", value: "all" },
            { name: "Passing", value: "passing" },
            { name: "Rushing", value: "rushing" },
            { name: "Receiving", value: "receiving" },
            { name: "Defense", value: "defense" },
            { name: "Kicking", value: "kicking" }
          ]
        }
      ]
    }
  }
} as CommandHandler
