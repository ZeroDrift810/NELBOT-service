import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, formatRecord } from "../../export/madden_league_types"
import { predictWeek, selectGOTW } from "./prediction_engine"
import { TeamGameData, calculatePowerRankings } from "./powerrankings_engine"
import { generateGOTWPreview, GOTWPreviewData, isAnthropicConfigured } from "../../ai/anthropic_client"

async function generateGOTW(token: string, client: DiscordClient, league: string, weekNumber?: number) {
  try {
    console.log(`🏈 generateGOTW called: league=${league}, week=${weekNumber}`)

    if (!isAnthropicConfigured()) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# ⚠️ Anthropic API Not Configured\n\nTo use AI-generated GOTW previews, add your Anthropic API key to the .env file."
          }
        ]
      })
      return
    }

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# 🏈 GAME OF THE WEEK\n\n⏳ Analyzing matchups and selecting the marquee game..."
        }
      ]
    })

    const [teams, logos, weeks, standings] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league),
      MaddenDB.getLatestStandings(league)
    ])

    // MAJOR FIX: Check if weeks array is empty
    if (weeks.length === 0) {
      throw new Error("No season data available")
    }

    const currentSeasonIndex = weeks[0].seasonIndex
    const currentWeekIndex = weeks[0].weekIndex

    const targetWeek = weekNumber !== undefined ? weekNumber - 1 : currentWeekIndex
    const targetSeason = currentSeasonIndex

    console.log(`🏈 Selecting GOTW for Week ${targetWeek + 1}, Season ${targetSeason}`)

    const schedule = await MaddenDB.getLatestWeekSchedule(league, targetWeek + 1)

    if (schedule.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🏈 GAME OF THE WEEK\n\n⚠️ No games found for Week ${targetWeek + 1}.`
          }
        ]
      })
      return
    }

    // Build team game data
    const teamGameDataList: TeamGameData[] = standings.map(standing => {
      const gamesPlayed = standing.totalWins + standing.totalLosses + standing.totalTies
      return {
        teamId: standing.teamId,
        gamesPlayed,
        wins: standing.totalWins,
        losses: standing.totalLosses,
        ties: standing.totalTies,
        pointsFor: standing.ptsFor || 0,
        pointsAgainst: standing.ptsAgainst || 0,
        totalOffYards: (standing.ptsFor || 0) * 30,
        totalOffPlays: gamesPlayed * 60,
        totalDefYardsAllowed: (standing.ptsAgainst || 0) * 30,
        totalDefPlaysFaced: gamesPlayed * 60,
        takeaways: gamesPlayed,
        giveaways: gamesPlayed,
        opponentTeamIds: []
      }
    })

    const powerRankings = calculatePowerRankings(teamGameDataList)
    const predictions = predictWeek(schedule, teamGameDataList, standings)
    const gotw = selectGOTW(schedule, predictions, powerRankings, standings)

    const homeTeam = teams.getTeamForId(gotw.game.homeTeamId)
    const awayTeam = teams.getTeamForId(gotw.game.awayTeamId)
    const homeStanding = standings.find(s => s.teamId === gotw.game.homeTeamId)
    const awayStanding = standings.find(s => s.teamId === gotw.game.awayTeamId)

    if (!homeStanding || !awayStanding) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🏈 GAME OF THE WEEK\n\n⚠️ Missing standings data for the selected game.`
          }
        ]
      })
      return
    }

    const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
    const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)

    // Generate AI preview
    const previewData: GOTWPreviewData = {
      homeTeam: homeTeam.displayName,
      awayTeam: awayTeam.displayName,
      homeRecord: formatRecord(homeStanding),
      awayRecord: formatRecord(awayStanding),
      homeRank: gotw.prediction.homeTeamPowerRank || 0,
      awayRank: gotw.prediction.awayTeamPowerRank || 0,
      predictedScore: `${teams.getTeamForId(gotw.prediction.predictedWinner).displayName} ${gotw.prediction.predictedWinnerScore}-${gotw.prediction.predictedLoserScore}`,
      confidence: gotw.prediction.confidence,
      keyMatchups: [],
      storylines: gotw.reasoning
    }

    // MAJOR FIX: Add fallback if AI generation fails
    let aiPreview = ""
    try {
      aiPreview = await generateGOTWPreview(previewData)
    } catch (e) {
      console.warn("⚠️ Failed to generate AI preview:", e)
      aiPreview = "*AI preview unavailable - Anthropic API error. Please check your API key configuration.*"
    }

    // Build display message
    let message = `# 🏈 GAME OF THE WEEK\n`
    message += `## Week ${targetWeek + 1} • Season ${MADDEN_SEASON + targetSeason}\n\n`

    message += `### ${awayEmoji} ${awayTeam.displayName} (${formatRecord(awayStanding)}, #${gotw.prediction.awayTeamPowerRank})\n`
    message += `### at\n`
    message += `### ${homeEmoji} ${homeTeam.displayName} (${formatRecord(homeStanding)}, #${gotw.prediction.homeTeamPowerRank})\n\n`

    message += `**GOTW Score: ${gotw.gotwScore.toFixed(1)}/100**\n\n`

    message += `### Why This Game Matters\n`
    gotw.reasoning.forEach(reason => {
      message += `• ${reason}\n`
    })
    message += `\n`

    message += `### The Preview\n`
    message += `${aiPreview}\n\n`

    message += `### The Pick\n`
    const winnerTeam = teams.getTeamForId(gotw.prediction.predictedWinner)
    const winnerEmoji = gotw.prediction.predictedWinner === gotw.game.homeTeamId ? homeEmoji : awayEmoji
    message += `**${winnerEmoji} ${winnerTeam.displayName}** ${gotw.prediction.predictedWinnerScore}-${gotw.prediction.predictedLoserScore}\n`
    message += `Confidence: ${gotw.prediction.confidence}%\n`
    message += `*${gotw.prediction.reasoning}*\n\n`

    message += `───────────────────────\n`
    message += `💡 GOTW selected based on power rankings, records, competitive balance, and playoff implications`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

    console.log(`✅ GOTW generated: ${awayTeam.displayName} at ${homeTeam.displayName}`)

  } catch (e) {
    console.error("❌ Error in generateGOTW:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate GOTW: ${e}`
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

    const weekOption = command.data.options?.[0]
    const weekNumber = weekOption ? (weekOption as any).value : undefined

    respond(ctx, deferMessage())
    generateGOTW(command.token, client, league, weekNumber)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "gotw",
      description: "View the NEL Game of the Week with AI-generated preview",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "week",
          description: "Week number (defaults to current week)",
          required: false,
          min_value: 1,
          max_value: 18
        }
      ]
    }
  }
} as CommandHandler
