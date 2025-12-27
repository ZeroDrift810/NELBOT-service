import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, createMessageResponse } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType, ButtonStyle } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, formatRecord } from "../../export/madden_league_types"
import { predictWeek } from "./prediction_engine"
import { TeamGameData } from "./powerrankings_engine"
import PickemDB from "../pickem_db"

async function showPickemForm(
  token: string,
  client: DiscordClient,
  league: string,
  guildId: string,
  userId: string,
  userName: string,
  weekNumber?: number,
  page: number = 0,
  weekIndexDirect?: number  // CRITICAL FIX: For passing 0-based week index directly from interactions
) {
  try {
    console.log(`🎯 showPickemForm called: user=${userName}, league=${league}, week=${weekNumber}, weekIndexDirect=${weekIndexDirect}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# 🎯 NEL PICK'EM\\n\\n⏳ Loading this week's matchups..."
        }
      ]
    })

    const [teams, logos, weeks, standings] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league),
      MaddenDB.getLatestStandings(league)
    ])

    if (weeks.length === 0) {
      throw new Error("No season data available")
    }

    const currentSeasonIndex = weeks[0].seasonIndex
    const currentWeekIndex = weeks[0].weekIndex

    // CRITICAL FIX: Handle three cases:
    // 1. weekIndexDirect provided (from interaction) - use as-is (0-based)
    // 2. weekNumber provided (from command) - convert to 0-based
    // 3. Neither provided - use current week
    const targetWeek = weekIndexDirect !== undefined
      ? weekIndexDirect
      : (weekNumber !== undefined ? weekNumber - 1 : currentWeekIndex)
    const targetSeason = currentSeasonIndex

    console.log(`🎯 Loading pick'em for Week ${targetWeek + 1}, Season ${targetSeason}`)

    // Get schedule and predictions
    const schedule = await MaddenDB.getLatestWeekSchedule(league, targetWeek + 1)

    if (schedule.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\\n\\n⚠️ No games found for Week ${targetWeek + 1}.`
          }
        ]
      })
      return
    }

    // Check if week has already been played
    const hasResults = schedule.some(g => g.homeScore !== null && g.awayScore !== null)
    if (hasResults) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\\n\\n⚠️ Week ${targetWeek + 1} has already been played. Picks are locked.`
          }
        ]
      })
      return
    }

    // Get or create week predictions
    let weekData = await PickemDB.getWeekPredictions(guildId, league, targetSeason, targetWeek)

    if (!weekData) {
      // Generate predictions if they don't exist
      console.log(`🎯 Generating bot predictions for Week ${targetWeek + 1}`)

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

      const predictions = predictWeek(schedule, teamGameDataList, standings)

      // Save predictions
      const botPredictions: any = {}
      predictions.forEach(pred => {
        botPredictions[pred.game.scheduleId] = {
          predictedWinner: pred.predictedWinner,
          predictedWinnerScore: pred.predictedWinnerScore,
          predictedLoserScore: pred.predictedLoserScore,
          confidence: pred.confidence,
          reasoning: pred.reasoning
        }
      })

      await PickemDB.saveWeekPredictions(guildId, league, targetSeason, targetWeek, botPredictions)
      weekData = await PickemDB.getWeekPredictions(guildId, league, targetSeason, targetWeek)
    }

    // Get user's existing picks if any
    const existingPicks = await PickemDB.getUserPicks(guildId, league, targetSeason, targetWeek, userId)
    const userPicksMap = new Map<number, number>()
    if (existingPicks) {
      existingPicks.forEach(pick => {
        userPicksMap.set(pick.scheduleId, pick.predictedWinner)
      })
    }

    // Pagination settings (4 games per page to stay within 5 ActionRow limit)
    const GAMES_PER_PAGE = 4
    const totalPages = Math.ceil(schedule.length / GAMES_PER_PAGE)
    const currentPage = Math.max(0, Math.min(page, totalPages - 1))  // MAJOR FIX: Prevent negative pages
    const startIdx = currentPage * GAMES_PER_PAGE
    const endIdx = Math.min(startIdx + GAMES_PER_PAGE, schedule.length)
    const pageGames = schedule.slice(startIdx, endIdx)

    // Build message with pick form
    let message = `# 🎯 NEL PICK'EM
## Week ${targetWeek + 1} • Season ${MADDEN_SEASON + targetSeason}

`

    if (existingPicks && existingPicks.length > 0) {
      message += `✅ You have submitted picks for ${existingPicks.length}/${schedule.length} games

`
    } else {
      message += `📋 Make your picks for all ${schedule.length} games

`
    }

    if (totalPages > 1) {
      message += `📄 Page ${currentPage + 1} of ${totalPages}

`
    }

    message += `### Matchups

`

    for (const game of pageGames) {
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeStanding = standings.find(s => s.teamId === game.homeTeamId)
      const awayStanding = standings.find(s => s.teamId === game.awayTeamId)

      if (!homeStanding || !awayStanding) {
        console.warn(`Missing standing data for game ${game.scheduleId}`)
        continue
      }

      const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)
      const userPick = userPicksMap.get(game.scheduleId)

      message += `
**${awayEmoji} ${awayTeam.displayName}** (${formatRecord(awayStanding)})${userPick === game.awayTeamId ? ' ✅' : ''}
at
**${homeEmoji} ${homeTeam.displayName}** (${formatRecord(homeStanding)})${userPick === game.homeTeamId ? ' ✅' : ''}
`
    }

    message += `
───────────────────────
💡 Use the dropdowns below to make your picks. You can change them anytime before kickoff!`

    // Build dropdown components (max 5 ActionRows: 4 for games + 1 for navigation)
    const components: any[] = []

    for (const game of pageGames) {
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)
      const userPick = userPicksMap.get(game.scheduleId)

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: JSON.stringify({
              action: 'pickem_select',
              scheduleId: game.scheduleId,
              guildId,
              leagueId: league,
              seasonIndex: targetSeason,
              weekIndex: targetWeek,
              page: currentPage
            }),
            placeholder: `Pick winner: ${awayTeam.abbrName} @ ${homeTeam.abbrName}`,
            options: [
              {
                label: `${awayEmoji} ${awayTeam.displayName} (Away)`,
                value: game.awayTeamId.toString(),
                description: `Pick ${awayTeam.abbrName} to win`,
                default: userPick === game.awayTeamId
              },
              {
                label: `${homeEmoji} ${homeTeam.displayName} (Home)`,
                value: game.homeTeamId.toString(),
                description: `Pick ${homeTeam.abbrName} to win`,
                default: userPick === game.homeTeamId
              }
            ]
          }
        ]
      })
    }

    // Navigation row with pagination and status
    const navButtons: any[] = []

    // Previous page button
    if (currentPage > 0) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: '◀️ Previous',
        custom_id: JSON.stringify({
          action: 'pickem_page',
          page: currentPage - 1,
          guildId,
          leagueId: league,
          seasonIndex: targetSeason,
          weekIndex: targetWeek
        })
      })
    }

    // Status button
    if (userPicksMap.size === schedule.length) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        label: `✅ Complete (${userPicksMap.size}/${schedule.length})`,
        custom_id: 'pickem_submitted',
        disabled: true
      })
    } else {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: `📝 Picks: ${userPicksMap.size}/${schedule.length}`,
        custom_id: 'pickem_progress',
        disabled: true
      })
    }

    // Next page button
    if (currentPage < totalPages - 1) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'Next ▶️',
        custom_id: JSON.stringify({
          action: 'pickem_page',
          page: currentPage + 1,
          guildId,
          leagueId: league,
          seasonIndex: targetSeason,
          weekIndex: targetWeek
        })
      })
    }

    if (navButtons.length > 0) {
      components.push({
        type: ComponentType.ActionRow,
        components: navButtons
      })
    }

    // MAJOR FIX: Check if we have any game dropdowns (not just nav buttons)
    const gameDropdowns = components.filter(c =>
      c.components[0].type === ComponentType.StringSelect
    )

    if (gameDropdowns.length === 0 && pageGames.length > 0) {
      // All games on this page were skipped due to missing data
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\n\n⚠️ Missing game data for Week ${targetWeek + 1}. Please contact an administrator.`
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
          content: message
        },
        ...components
      ]
    })

    console.log(`✅ Pick'em form shown to ${userName}`)

  } catch (e) {
    console.error("❌ Error in showPickemForm:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to load pick'em: ${e}`
        }
      ]
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, member } = command

    // MAJOR FIX: Check if user data exists
    if (!member.user) {
      throw new Error("User information not available")
    }

    const userId = member.user.id
    const userName = member.user.username

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    const weekOption = command.data.options?.[0]
    const weekNumber = weekOption ? (weekOption as any).value : undefined

    respond(ctx, deferMessage())
    showPickemForm(command.token, client, league, guild_id, userId, userName, weekNumber)
  },

  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    try {
      const customId = JSON.parse(interaction.custom_id)

      // MAJOR FIX: Check if user data exists
      const member = (interaction as any).member
      if (!member || !member.user) {
        return {
          type: 4,
          data: {
            content: "User information not available",
            flags: 64
          }
        }
      }

      const userId = member.user.id
      const userName = member.user.username

      if (customId.action === 'pickem_select') {
        const { scheduleId, guildId, leagueId, seasonIndex, weekIndex, page } = customId
        const selectedWinner = parseInt((interaction.data as any).values[0])

        // Save the pick
        const picks = { [scheduleId]: selectedWinner }
        await PickemDB.saveUserPicks(guildId, leagueId, seasonIndex, weekIndex, userId, userName, picks)

        // CRITICAL FIX: Use weekIndexDirect parameter instead of passing weekIndex as weekNumber
        await showPickemForm(interaction.token, client, leagueId, guildId, userId, userName, undefined, page || 0, weekIndex)

        return {
          type: 7,
          data: {}
        }
      }

      if (customId.action === 'pickem_page') {
        const { page, guildId, leagueId, seasonIndex, weekIndex } = customId

        // CRITICAL FIX: Use weekIndexDirect parameter
        await showPickemForm(interaction.token, client, leagueId, guildId, userId, userName, undefined, page, weekIndex)

        return {
          type: 7,
          data: {}
        }
      }

      return {
        type: 7,
        data: {}
      }
    } catch (e) {
      console.error("❌ Error in pickem interaction:", e)
      return {
        type: 4,
        data: {
          content: `Failed to process interaction: ${e}`,
          flags: 64
        }
      }
    }
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "pickem",
      description: "Make your picks for the week's games",
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
