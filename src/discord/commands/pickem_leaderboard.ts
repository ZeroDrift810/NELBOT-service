import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { MADDEN_SEASON } from "../../export/madden_league_types"
import PickemDB from "../pickem_db"

async function showLeaderboard(
  token: string,
  client: DiscordClient,
  league: string,
  guildId: string,
  seasonNumber?: number
) {
  try {
    console.log(`🏆 showLeaderboard called: league=${league}, season=${seasonNumber}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# 🏆 NEL PICK'EM LEADERBOARD\\n\\n⏳ Loading season standings..."
        }
      ]
    })

    const weeks = await MaddenDB.getAllWeeks(league)

    // MAJOR FIX: Check if weeks array is empty
    if (weeks.length === 0) {
      throw new Error("No season data available")
    }

    const currentSeasonIndex = weeks[0].seasonIndex

    const targetSeason = seasonNumber !== undefined ? seasonNumber - MADDEN_SEASON : currentSeasonIndex

    console.log(`🏆 Loading leaderboard for Season ${MADDEN_SEASON + targetSeason}`)

    // Get leaderboard
    const leaderboard = await PickemDB.getSeasonLeaderboard(guildId, league, targetSeason)

    if (leaderboard.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🏆 NEL PICK'EM LEADERBOARD\\n## Season ${MADDEN_SEASON + targetSeason}\\n\\n⚠️ No picks have been made yet this season.`
          }
        ]
      })
      return
    }

    // Build leaderboard message
    let message = `# 🏆 NEL PICK'EM LEADERBOARD\\n`
    message += `## Season ${MADDEN_SEASON + targetSeason}\\n\\n`

    // Display top users
    for (let i = 0; i < Math.min(leaderboard.length, 15); i++) {
      const user = leaderboard[i]
      const rank = i + 1

      // Rank emoji
      let rankEmoji = `${rank}.`
      if (rank === 1) rankEmoji = '🥇'
      if (rank === 2) rankEmoji = '🥈'
      if (rank === 3) rankEmoji = '🥉'

      // Accuracy indicator
      let accuracyEmoji = '🟢' // High accuracy (70%+)
      if (user.accuracy < 70) accuracyEmoji = '🟡' // Medium (60-69%)
      if (user.accuracy < 60) accuracyEmoji = '🔴' // Low (<60%)

      message += `${rankEmoji} **${user.userName}**\\n`
      message += `${accuracyEmoji} ${user.correctPicks}/${user.totalPicks} correct (${user.accuracy.toFixed(1)}%)\\n`

      // Show weekly breakdown
      // MINOR FIX: Handle undefined weeklyResults
      const weekNumbers = Object.keys(user.weeklyResults || {}).map(w => parseInt(w)).sort((a, b) => a - b)
      if (weekNumbers.length > 0) {
        const recentWeeks = weekNumbers.slice(-3) // Show last 3 weeks
        const weekSummary = recentWeeks.map(w => {
          const weekData = user.weeklyResults[w]
          const weekEmoji = weekData.accuracy >= 70 ? '✅' : weekData.accuracy >= 50 ? '➖' : '❌'
          return `W${w + 1}: ${weekData.correct}/${weekData.picks} ${weekEmoji}`
        }).join(' • ')
        message += `${weekSummary}\\n`
      }
      message += `\\n`
    }

    if (leaderboard.length > 15) {
      message += `*...and ${leaderboard.length - 15} more users*\\n\\n`
    }

    message += `───────────────────────\\n`
    message += `🟢 High Accuracy (70%+) • 🟡 Medium (60-69%) • 🔴 Low (<60%)\\n`
    message += `\\n💡 Keep making picks each week to climb the leaderboard!`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

    console.log(`✅ Leaderboard shown for ${leaderboard.length} users`)

  } catch (e) {
    console.error("❌ Error in showLeaderboard:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to load leaderboard: ${e}`
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

    const seasonOption = command.data.options?.[0]
    const seasonNumber = seasonOption ? (seasonOption as any).value : undefined

    respond(ctx, deferMessage())
    showLeaderboard(command.token, client, league, guild_id, seasonNumber)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "pickem_leaderboard",
      description: "View the pick'em leaderboard",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "season",
          description: "Season year (defaults to current season)",
          required: false,
          min_value: MADDEN_SEASON,
          max_value: MADDEN_SEASON + 10
        }
      ]
    }
  }
} as CommandHandler
