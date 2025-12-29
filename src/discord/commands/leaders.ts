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
      const rating = stat.passerRating?.toFixed(1) || '0.0'
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.passYds} YDS, ${stat.passTDs} TD, ${stat.passInts} INT, ${stat.passCompPct.toFixed(1)}%, ${rating} RTG\n`
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
      const bt = stat.rushBrokenTackles || 0
      const explosive = stat.rush20PlusYds || 0
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.rushYds} YDS, ${stat.rushTDs} TD, ${ypc} YPC, ${bt} BT, ${explosive} 20+\n`
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
      const yac = stat.recYdsAfterCatch || 0
      const drops = stat.recDrops || 0
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.recYds} YDS, ${stat.recTDs} TD, ${stat.recCatches} REC, ${yac} YAC, ${drops} DROP\n`
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
      const pd = stat.defDeflections || 0
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.defTotalTackles} TKL, ${stat.defSacks} SCK, ${stat.defInts} INT, ${stat.defForcedFum} FF, ${pd} PD\n`
    })
    message += `\n`
  }

  if (category === "sacks" || category === "all") {
    const defensiveStats = (weeklyStats[PlayerStatType.DEFENSE] || []) as DefensiveStats[]
    const topSackers = defensiveStats
      .filter(s => s.defSacks > 0)
      .sort((a, b) => b.defSacks - a.defSacks)
      .slice(0, 10)

    if (topSackers.length > 0) {
      message += `## 💥 Sack Leaders\n`
      topSackers.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const ff = stat.defForcedFum || 0
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.defSacks} SACKS, ${stat.defTotalTackles} TKL, ${ff} FF\n`
      })
      message += `\n`
    }
  }

  if (category === "interceptions" || category === "all") {
    const defensiveStats = (weeklyStats[PlayerStatType.DEFENSE] || []) as DefensiveStats[]
    const topBallHawks = defensiveStats
      .filter(s => s.defInts > 0)
      .sort((a, b) => b.defInts - a.defInts)
      .slice(0, 10)

    if (topBallHawks.length > 0) {
      message += `## 🦅 Interception Leaders\n`
      topBallHawks.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const retYds = stat.defIntReturnYds || 0
        const pd = stat.defDeflections || 0
        const td = stat.defTDs || 0
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.defInts} INT, ${retYds} RET YDS, ${pd} PD${td > 0 ? `, ${td} TD` : ''}\n`
      })
      message += `\n`
    }
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
      const fg50 = `${stat.fG50PlusMade || 0}/${stat.fG50PlusAtt || 0}`
      message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.fGMade}/${stat.fGAtt} FG (${fgPct}%), 50+: ${fg50}, Long: ${stat.fGLongest}\n`
    })
    message += `\n`
  }

  if (category === "punting" || category === "all") {
    const puntingStats = (weeklyStats[PlayerStatType.PUNTING] || []) as PuntingStats[]
    const topPunters = puntingStats
      .filter(p => p.puntAtt > 0)
      .sort((a, b) => b.puntYdsPerAtt - a.puntYdsPerAtt)
      .slice(0, 5)

    if (topPunters.length > 0) {
      message += `## 🏈 Punting Leaders\n`
      topPunters.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const avg = stat.puntYdsPerAtt?.toFixed(1) || '0.0'
        const netAvg = stat.puntNetYdsPerAtt?.toFixed(1) || '0.0'
        const in20 = stat.puntsIn20 || 0
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.puntAtt} Punts, ${avg} AVG, ${netAvg} NET, ${in20} IN20\n`
      })
      message += `\n`
    }
  }

  // Advanced stats category
  if (category === "advanced") {
    const rushingStats = (weeklyStats[PlayerStatType.RUSHING] || []) as RushingStats[]
    const receivingStats = (weeklyStats[PlayerStatType.RECEIVING] || []) as ReceivingStats[]

    // Broken Tackles leaders
    const btLeaders = rushingStats
      .filter(s => (s.rushBrokenTackles || 0) > 0)
      .sort((a, b) => (b.rushBrokenTackles || 0) - (a.rushBrokenTackles || 0))
      .slice(0, 5)

    if (btLeaders.length > 0) {
      message += `## 💪 Broken Tackles Leaders\n`
      btLeaders.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const yac = stat.rushYdsAfterContact || 0
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.rushBrokenTackles} BT, ${yac} YAC, ${stat.rushYds} YDS\n`
      })
      message += `\n`
    }

    // YAC leaders (receiving)
    const yacLeaders = receivingStats
      .filter(s => (s.recYdsAfterCatch || 0) > 0)
      .sort((a, b) => (b.recYdsAfterCatch || 0) - (a.recYdsAfterCatch || 0))
      .slice(0, 5)

    if (yacLeaders.length > 0) {
      message += `## 🚀 Yards After Catch Leaders\n`
      yacLeaders.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        const yacPerCatch = stat.recCatches > 0 ? ((stat.recYdsAfterCatch || 0) / stat.recCatches).toFixed(1) : '0.0'
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.recYdsAfterCatch} YAC, ${yacPerCatch} YAC/REC, ${stat.recCatches} REC\n`
      })
      message += `\n`
    }

    // Explosive plays (20+ yard rushes)
    const explosiveRushers = rushingStats
      .filter(s => (s.rush20PlusYds || 0) > 0)
      .sort((a, b) => (b.rush20PlusYds || 0) - (a.rush20PlusYds || 0))
      .slice(0, 5)

    if (explosiveRushers.length > 0) {
      message += `## ⚡ Explosive Rushers (20+ YD Runs)\n`
      explosiveRushers.forEach((stat, idx) => {
        const team = teams.getTeamForId(stat.teamId)
        message += `${idx + 1}. **${stat.fullName}** (${team?.abbrName || 'FA'}) - ${stat.rush20PlusYds} runs of 20+, Long: ${stat.rushLongest}\n`
      })
      message += `\n`
    }
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
            { name: "Defense (Tackles)", value: "defense" },
            { name: "Sack Leaders", value: "sacks" },
            { name: "Interception Leaders", value: "interceptions" },
            { name: "Kicking", value: "kicking" },
            { name: "Punting", value: "punting" },
            { name: "Advanced Stats", value: "advanced" }
          ]
        }
      ]
    }
  }
} as CommandHandler
