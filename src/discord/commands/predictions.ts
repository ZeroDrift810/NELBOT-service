import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { TeamList } from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView, LeagueLogos } from "../../db/view"
import { MADDEN_SEASON, MaddenGame, Standing, formatRecord } from "../../export/madden_league_types"
import { predictWeek, GamePrediction } from "./prediction_engine"
import { TeamGameData } from "./powerrankings_engine"

async function generatePredictions(token: string, client: DiscordClient, league: string, weekNumber?: number) {
  try {
    console.log(`📊 generatePredictions called: league=${league}, week=${weekNumber}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# 📊 NEL PREDICTIONS\n\n⏳ Analyzing matchups and generating predictions..."
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

    // Use provided week or current week
    const targetWeek = weekNumber !== undefined ? weekNumber - 1 : currentWeekIndex // Convert to 0-based
    const targetSeason = currentSeasonIndex

    console.log(`📊 Generating predictions for Week ${targetWeek + 1}, Season ${targetSeason}`)

    // Get schedule for target week
    const schedule = await MaddenDB.getLatestWeekSchedule(league, targetWeek + 1)

    if (schedule.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 📊 NEL PREDICTIONS\n\n⚠️ No games found for Week ${targetWeek + 1}.`
          }
        ]
      })
      return
    }

    // Build team game data from standings
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

    // Generate predictions
    const predictions = predictWeek(schedule, teamGameDataList, standings)

    if (predictions.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 📊 NEL PREDICTIONS\n\n⚠️ Unable to generate predictions for Week ${targetWeek + 1}.`
          }
        ]
      })
      return
    }

    // Build display message
    let message = `# 📊 NEL WEEK ${targetWeek + 1} PREDICTIONS\n`
    message += `## Season ${MADDEN_SEASON + targetSeason}\n\n`

    // Calculate overall confidence
    const avgConfidence = predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length
    message += `*Average Confidence: ${avgConfidence.toFixed(1)}%*\n\n`

    // Sort predictions by confidence (highest first)
    const sortedPredictions = [...predictions].sort((a, b) => b.confidence - a.confidence)

    for (const pred of sortedPredictions) {
      const homeTeam = teams.getTeamForId(pred.game.homeTeamId)
      const awayTeam = teams.getTeamForId(pred.game.awayTeamId)
      const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)

      const winnerTeam = pred.predictedWinner === pred.game.homeTeamId ? homeTeam : awayTeam
      const winnerEmoji = pred.predictedWinner === pred.game.homeTeamId ? homeEmoji : awayEmoji

      // Confidence indicator
      let confidenceEmoji = '🟢' // High confidence
      if (pred.confidence < 70) confidenceEmoji = '🟡' // Medium
      if (pred.confidence < 60) confidenceEmoji = '🔴' // Low (tossup)

      message += `${confidenceEmoji} **${awayEmoji} ${awayTeam.displayName}** at **${homeEmoji} ${homeTeam.displayName}**\n`
      message += `Prediction: **${winnerEmoji} ${winnerTeam.displayName}** ${pred.predictedWinnerScore}-${pred.predictedLoserScore}\n`
      message += `Confidence: ${pred.confidence}% • ${pred.reasoning}\n\n`
    }

    message += `───────────────────────\n`
    message += `🟢 High Confidence (70%+) • 🟡 Medium (60-69%) • 🔴 Tossup (<60%)\n`
    message += `\n💡 Predictions based on power rankings, home field advantage, and matchup analysis`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

    console.log(`✅ Predictions generated for ${predictions.length} games`)

  } catch (e) {
    console.error("❌ Error in generatePredictions:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate predictions: ${e}`
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

    // Check for optional week parameter
    const weekOption = command.data.options?.[0]
    const weekNumber = weekOption ? (weekOption as any).value : undefined

    respond(ctx, deferMessage())
    generatePredictions(command.token, client, league, weekNumber)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "predictions",
      description: "View NEL game predictions for the week",
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
