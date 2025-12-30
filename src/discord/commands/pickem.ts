import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, createMessageResponse } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType, ButtonStyle } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, formatRecord, GameResult } from "../../export/madden_league_types"
import { predictWeek } from "./prediction_engine"
import { TeamGameData } from "./powerrankings_engine"
import PickemDB from "../pickem_db"
import db from "../../db/firebase"

// Admin role ID for lock/unlock commands
const ADMIN_ROLE_ID = "1451132365370818624"

// Helper to check if user has admin role
function hasAdminRole(memberRoles: string[]): boolean {
  return memberRoles.includes(ADMIN_ROLE_ID)
}

// Helper to get schedule for regular season (stageIndex=1) from latest season
async function getWeekScheduleAnyStage(leagueId: string, week: number) {
  // Query for regular season games only (stageIndex=1)
  const weekDocs = await db.collection("madden_data26").doc(leagueId)
    .collection("MADDEN_SCHEDULE")
    .where("weekIndex", "==", week - 1)
    .where("stageIndex", "==", 1)  // Regular season only
    .get()

  const games = weekDocs.docs.map(d => d.data())
    .filter((game: any) => game.awayTeamId != 0 && game.homeTeamId != 0)

  if (games.length === 0) {
    console.log(`🎯 getWeekScheduleAnyStage: Week ${week} - no regular season games found`)
    return []
  }

  // Group by season and get latest (sort in memory instead of query)
  const bySeason: { [key: number]: any[] } = {}
  for (const game of games) {
    const season = game.seasonIndex
    if (!bySeason[season]) bySeason[season] = []
    bySeason[season].push(game)
  }

  const latestSeason = Math.max(...Object.keys(bySeason).map(Number))
  const latestGames = bySeason[latestSeason] || []

  // Check for actual played games using the status field (EA's official indicator)
  // GameResult.NOT_PLAYED = 1, AWAY_WIN = 2, HOME_WIN = 3
  const isGamePlayed = (g: any) => {
    // EA uses status field: 1 = NOT_PLAYED, 2 = AWAY_WIN, 3 = HOME_WIN
    return g.status !== undefined && g.status !== GameResult.NOT_PLAYED
  }

  const gamesWithResults = latestGames.filter(isGamePlayed).length
  const gamesWithoutResults = latestGames.length - gamesWithResults
  console.log(`🎯 getWeekScheduleAnyStage: Week ${week} found seasons: ${Object.keys(bySeason).join(', ')}, using ${latestSeason}, ${latestGames.length} games (${gamesWithResults} played, ${gamesWithoutResults} unplayed)`)

  // Log first game's status field for debugging
  if (latestGames.length > 0) {
    const g = latestGames[0]
    console.log(`🎯 Sample game: status=${g.status} (1=NOT_PLAYED, 2=AWAY_WIN, 3=HOME_WIN), homeScore=${g.homeScore}, awayScore=${g.awayScore}`)
  }

  return latestGames
}

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
          content: "# 🎯 NEL PICK'EM\n\n⏳ Loading this week's matchups..."
        }
      ]
    })

    const [teams, logos, weeks, standings] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league),
      MaddenDB.getLatestStandings(league)
    ])

    // Debug: Log all distinct seasons found
    const distinctSeasons = [...new Set(weeks.map(w => w.seasonIndex))].sort((a, b) => b - a)
    console.log(`🎯 All seasons in schedule: ${distinctSeasons.join(', ')}`)
    console.log(`🎯 First 5 weeks (sorted): ${weeks.slice(0, 5).map(w => `S${w.seasonIndex}W${w.weekIndex}`).join(', ')}`)

    // Get current season - use standings as the source of truth for season
    // Note: standings.seasonIndex should be 0-based (0=S1, 1=S2, etc) but may vary
    const standingSeasonIndex = standings.length > 0 ? standings[0].seasonIndex : 0
    const weeksSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
    const weeksWeekIndex = weeks.length > 0 ? weeks[0].weekIndex : 0

    // Use weeks data for current position - it's more reliable for week tracking
    let currentSeasonIndex = weeksSeasonIndex
    let currentWeekIndex = weeksWeekIndex

    console.log(`🎯 Season detection: standings=${standingSeasonIndex}, weeks=S${weeksSeasonIndex}/W${weeksWeekIndex}`)

    // CRITICAL FIX: Handle three cases:
    // 1. weekIndexDirect provided (from interaction) - use as-is (0-based)
    // 2. weekNumber provided (from command) - convert to 0-based
    // 3. Neither provided - use current week (or Week 1 if no weeks yet)
    let targetWeek = weekIndexDirect !== undefined
      ? weekIndexDirect
      : (weekNumber !== undefined ? weekNumber - 1 : currentWeekIndex)
    let targetSeason = currentSeasonIndex

    console.log(`🎯 Loading pick'em for Week ${targetWeek + 1}, Season ${targetSeason}`)

    // Get schedule for target week
    let schedule: any[] = []
    try {
      schedule = await MaddenDB.getLatestWeekSchedule(league, targetWeek + 1)
      // Check if schedule is from expected season
      if (schedule.length > 0) {
        const scheduleSeasonIndex = schedule[0].seasonIndex
        console.log(`🎯 Schedule returned: ${schedule.length} games from Season ${scheduleSeasonIndex}`)
      }
    } catch (e) {
      console.log(`🎯 No schedule found for Week ${targetWeek + 1}`)
      schedule = []
    }

    // Helper to check if a game has been played using EA's status field
    // GameResult.NOT_PLAYED = 1, AWAY_WIN = 2, HOME_WIN = 3
    const isGamePlayed = (g: any) => {
      return g.status !== undefined && g.status !== GameResult.NOT_PLAYED
    }

    // Check if ALL games in the week have been played (not just "any" game played)
    // We should show pickem if there are ANY unplayed games
    let allGamesPlayed = schedule.length > 0 && schedule.every(isGamePlayed)
    const unplayedGames = schedule.filter(g => !isGamePlayed(g))
    console.log(`🎯 Week ${targetWeek + 1}: ${schedule.length} total, ${unplayedGames.length} unplayed, allPlayed=${allGamesPlayed}`)

    // Auto-advance to next unplayed week if user didn't specify a week
    if ((schedule.length === 0 || allGamesPlayed) && weekNumber === undefined && weekIndexDirect === undefined) {
      console.log(`🎯 Week ${targetWeek + 1} fully played or empty, searching for next available week...`)

      // Try next few weeks to find one that has unplayed games
      for (let tryWeek = targetWeek + 1; tryWeek <= 18; tryWeek++) {
        try {
          const nextSchedule = await MaddenDB.getLatestWeekSchedule(league, tryWeek + 1)
          if (nextSchedule.length > 0) {
            const nextUnplayed = nextSchedule.filter(g => !isGamePlayed(g))
            if (nextUnplayed.length > 0) {
              console.log(`🎯 Found Week ${tryWeek + 1} with ${nextUnplayed.length} unplayed games`)
              targetWeek = tryWeek
              targetSeason = nextSchedule[0].seasonIndex
              schedule = nextSchedule
              allGamesPlayed = false
              break
            }
          }
        } catch (e) {
          // No schedule for this week, continue searching
        }
      }

      // If still no unplayed week found, try Week 1 using ANY stageIndex (new season might be in preseason stage)
      if (schedule.length === 0 || allGamesPlayed) {
        try {
          // Use our custom query that doesn't filter by stageIndex
          const week1Schedule = await getWeekScheduleAnyStage(league, 1)
          if (week1Schedule.length > 0) {
            const week1Season = week1Schedule[0].seasonIndex
            const week1Unplayed = week1Schedule.filter(g => !isGamePlayed(g))
            console.log(`🎯 Week 1 check (any stage): Season ${week1Season}, ${week1Schedule.length} games, ${week1Unplayed.length} unplayed, stageIndex=${week1Schedule[0].stageIndex}`)

            if (week1Unplayed.length > 0) {
              console.log(`🎯 Found Week 1 (Season ${week1Season}) with ${week1Unplayed.length} unplayed games`)
              targetWeek = 0
              targetSeason = week1Season
              schedule = week1Schedule
              allGamesPlayed = false
            }
          }
        } catch (e) {
          console.log(`🎯 Week 1 not found: ${e}`)
        }
      }

      // Still not found? Log final state
      if (allGamesPlayed) {
        console.log(`🎯 No unplayed games found after full search. targetWeek=${targetWeek}, targetSeason=${targetSeason}`)
      }
    }

    if (schedule.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\n\n⚠️ No games found for Week ${targetWeek + 1}.`
          }
        ]
      })
      return
    }

    // Check if ALL games in the week have already been played
    if (allGamesPlayed) {
      // Check if we searched and couldn't find any unplayed weeks
      const searchedAllWeeks = weekNumber === undefined && weekIndexDirect === undefined

      let message = `# 🎯 NEL PICK'EM\n\n⚠️ Week ${targetWeek + 1} has already been played. Picks are locked.`

      if (searchedAllWeeks) {
        // We searched all weeks and couldn't find unplayed games - likely new season not exported
        message += `\n\n📤 **No unplayed games found.** If a new season has started, the schedule needs to be exported from Madden first.`
        message += `\n\n💡 Export the schedule from the Madden Companion App, then try again.`
      } else {
        message += `\n\n💡 Use \`/pickem week:X\` to pick for a specific upcoming week.`
      }

      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: message
          }
        ]
      })
      return
    }

    // Filter out games that have already been played - only show unplayed games
    const unplayedSchedule = schedule.filter(g => !isGamePlayed(g))
    console.log(`🎯 Filtered schedule: ${schedule.length} total games, ${unplayedSchedule.length} unplayed`)

    // If no unplayed games remain, show message
    if (unplayedSchedule.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\n\n⚠️ All games in Week ${targetWeek + 1} have been played. Picks are locked.`
          }
        ]
      })
      return
    }

    // Use the filtered schedule for picks
    schedule = unplayedSchedule

    // Check if picks are locked for this week
    const isLocked = await PickemDB.isWeekLocked(guildId, league, targetSeason, targetWeek)
    if (isLocked) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🎯 NEL PICK'EM\n## Week ${targetWeek + 1} • Season ${MADDEN_SEASON + targetSeason}\n\n🔒 **Picks are locked!**\n\nPicks were locked when a game stream started. You can view your existing picks but cannot make changes.\n\n💡 Check back next week to make new picks!`
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
💾 **Picks save automatically** when you select a team. Change anytime before kickoff!`

    // Build dropdown components (max 5 ActionRows: 4 for games + 1 for navigation)
    const components: any[] = []

    // Helper to parse emoji string like "<:nel_phi:1454300857582747711>" into object { id, name }
    const parseEmoji = (emojiStr: string) => {
      const match = emojiStr.match(/<:(\w+):(\d+)>/)
      if (match) {
        return { name: match[1], id: match[2] }
      }
      return null
    }

    for (const game of pageGames) {
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeEmojiStr = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmojiStr = formatTeamEmoji(logos, awayTeam.abbrName)
      const homeEmoji = parseEmoji(homeEmojiStr)
      const awayEmoji = parseEmoji(awayEmojiStr)
      const userPick = userPicksMap.get(game.scheduleId)

      const awayOption: any = {
        label: `${awayTeam.displayName} (Away)`,
        value: game.awayTeamId.toString(),
        description: `Pick ${awayTeam.abbrName} to win`,
        default: userPick === game.awayTeamId
      }
      if (awayEmoji) awayOption.emoji = awayEmoji

      const homeOption: any = {
        label: `${homeTeam.displayName} (Home)`,
        value: game.homeTeamId.toString(),
        description: `Pick ${homeTeam.abbrName} to win`,
        default: userPick === game.homeTeamId
      }
      if (homeEmoji) homeOption.emoji = homeEmoji

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            // Shortened keys to fit 100 char limit: a=action, s=scheduleId, l=leagueId, i=seasonIndex, w=weekIndex, p=page
            // Note: guildId is obtained from interaction.guild_id to save space
            custom_id: JSON.stringify({
              a: 'ps',  // pickem_select
              s: game.scheduleId,
              l: league,
              i: targetSeason,
              w: targetWeek,
              p: currentPage
            }),
            placeholder: `Pick winner: ${awayTeam.abbrName} @ ${homeTeam.abbrName}`,
            options: [awayOption, homeOption]
          }
        ]
      })
    }

    // Navigation row with pagination and status
    const navButtons: any[] = []

    // Previous page button - always show on page 2+
    if (currentPage > 0) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        label: '◀️ Back',
        custom_id: JSON.stringify({
          a: 'pp',  // pickem_page
          p: currentPage - 1,
          l: league,
          i: targetSeason,
          w: targetWeek
        })
      })
    }

    // Status button showing pick progress
    if (userPicksMap.size === schedule.length) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        label: `✅ All ${schedule.length} Picks Saved!`,
        custom_id: 'pickem_complete',
        disabled: true
      })
    } else {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: `💾 ${userPicksMap.size}/${schedule.length} Saved`,
        custom_id: 'pickem_progress',
        disabled: true
      })
    }

    // Next page button
    if (currentPage < totalPages - 1) {
      navButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        label: 'Next ▶️',
        custom_id: JSON.stringify({
          a: 'pp',  // pickem_page
          p: currentPage + 1,
          l: league,
          i: targetSeason,
          w: targetWeek
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

async function showLeaderboard(
  token: string,
  client: DiscordClient,
  league: string,
  guildId: string
) {
  try {
    // Get current season from standings
    const standings = await MaddenDB.getLatestStandings(league)
    const currentSeason = standings.length > 0 ? standings[0].seasonIndex : 0

    // Get leaderboard
    const leaderboard = await PickemDB.getSeasonLeaderboard(guildId, league, currentSeason)

    let message = `# 🏆 NEL PICK'EM LEADERBOARD
## Season ${MADDEN_SEASON + currentSeason}

`

    if (leaderboard.length === 0) {
      message += `No picks have been scored yet this season.

💡 Make your picks with \`/pickem pick\` and check back after games are played!`
    } else {
      message += `| Rank | Player | Record | Accuracy |
|------|--------|--------|----------|
`
      leaderboard.forEach((stats, index) => {
        const rank = index + 1
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`
        const record = `${stats.correctPicks}-${stats.totalPicks - stats.correctPicks}`
        const accuracy = stats.accuracy.toFixed(1)
        message += `| ${medal} | ${stats.userName} | ${record} | ${accuracy}% |
`
      })

      message += `
───────────────────────
📊 Ranked by accuracy (correct picks / total picks)`
    }

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

    // Handle subcommands
    const subCommand = command.data.options?.[0] as any
    const subCommandName = subCommand?.name || 'pick'  // Default to pick for backwards compatibility

    respond(ctx, deferMessage())

    if (subCommandName === 'leaderboard') {
      showLeaderboard(command.token, client, league, guild_id)
    } else if (subCommandName === 'lock') {
      // Lock picks for a week (commissioners only)
      ;(async () => {
        try {
          // Authorization check - require admin role
          const memberRoles = member.roles || []
          if (!hasAdminRole(memberRoles)) {
            await client.editOriginalInteraction(command.token, {
              flags: 32768,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: `# 🔒 Access Denied\n\nYou need the <@&${ADMIN_ROLE_ID}> role to lock pick'em weeks.`
                }
              ]
            })
            return
          }

          const weekOption = subCommand?.options?.find((o: any) => o.name === 'week')

          // Get current week if not specified
          const weeks = await MaddenDB.getAllWeeks(league)
          const currentWeekIndex = weeks.length > 0 ? weeks[0].weekIndex : 0
          const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0

          const targetWeekIndex = weekOption ? weekOption.value - 1 : currentWeekIndex

          // Check if already locked
          const isLocked = await PickemDB.isWeekLocked(guild_id, league, currentSeasonIndex, targetWeekIndex)
          if (isLocked) {
            await client.editOriginalInteraction(command.token, {
              flags: 32768,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: `# 🔒 Pick'em Already Locked\n\nWeek ${targetWeekIndex + 1} picks are already locked.`
                }
              ]
            })
            return
          }

          // Lock the week
          await PickemDB.lockWeek(guild_id, league, currentSeasonIndex, targetWeekIndex, userId)

          await client.editOriginalInteraction(command.token, {
            flags: 32768,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `# 🔒 Pick'em Locked\n\nWeek ${targetWeekIndex + 1} picks have been **locked**.\n\nUsers can no longer submit or change their picks for this week.`
              }
            ]
          })
        } catch (e) {
          console.error("❌ Error locking picks:", e)
          await client.editOriginalInteraction(command.token, {
            flags: 32768,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `❌ Failed to lock picks: ${e}`
              }
            ]
          })
        }
      })()
    } else if (subCommandName === 'unlock') {
      // Unlock picks for a week (commissioners only)
      ;(async () => {
        try {
          // Authorization check - require admin role
          const memberRoles = member.roles || []
          if (!hasAdminRole(memberRoles)) {
            await client.editOriginalInteraction(command.token, {
              flags: 32768,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: `# 🔓 Access Denied\n\nYou need the <@&${ADMIN_ROLE_ID}> role to unlock pick'em weeks.`
                }
              ]
            })
            return
          }

          const weekOption = subCommand?.options?.find((o: any) => o.name === 'week')

          // Get current week if not specified
          const weeks = await MaddenDB.getAllWeeks(league)
          const currentWeekIndex = weeks.length > 0 ? weeks[0].weekIndex : 0
          const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0

          const targetWeekIndex = weekOption ? weekOption.value - 1 : currentWeekIndex

          // Check if already unlocked
          const isLocked = await PickemDB.isWeekLocked(guild_id, league, currentSeasonIndex, targetWeekIndex)
          if (!isLocked) {
            await client.editOriginalInteraction(command.token, {
              flags: 32768,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: `# 🔓 Pick'em Already Unlocked\n\nWeek ${targetWeekIndex + 1} picks are not locked.`
                }
              ]
            })
            return
          }

          // Unlock the week
          await PickemDB.unlockWeek(guild_id, league, currentSeasonIndex, targetWeekIndex)

          await client.editOriginalInteraction(command.token, {
            flags: 32768,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `# 🔓 Pick'em Unlocked\n\nWeek ${targetWeekIndex + 1} picks have been **unlocked**.\n\nUsers can now submit and change their picks for this week.`
              }
            ]
          })
        } catch (e) {
          console.error("❌ Error unlocking picks:", e)
          await client.editOriginalInteraction(command.token, {
            flags: 32768,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `❌ Failed to unlock picks: ${e}`
              }
            ]
          })
        }
      })()
    } else {
      // 'pick' subcommand or legacy (no subcommand)
      const weekOption = subCommand?.options?.[0]
      const weekNumber = weekOption ? weekOption.value : undefined
      showPickemForm(command.token, client, league, guild_id, userId, userName, weekNumber)
    }
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

      // Handle shortened keys: a=action, s=scheduleId, l=leagueId, i=seasonIndex, w=weekIndex, p=page
      // guildId is obtained from interaction.guild_id to save custom_id space
      const guildId = (interaction as any).guild_id

      if (customId.a === 'ps') {  // pickem_select
        const { s: scheduleId, l: leagueId, i: seasonIndex, w: weekIndex, p: page } = customId
        const selectedWinner = parseInt((interaction.data as any).values[0])

        // Save the pick and update form asynchronously (don't await - let it run in background)
        // We return immediately with DEFERRED_UPDATE_MESSAGE to acknowledge
        ;(async () => {
          try {
            const picks = { [scheduleId]: selectedWinner }
            await PickemDB.saveUserPicks(guildId, leagueId, seasonIndex, weekIndex, userId, userName, picks)
            await showPickemForm(interaction.token, client, leagueId, guildId, userId, userName, undefined, page || 0, weekIndex)
          } catch (e) {
            console.error("❌ Error saving pick:", e)
          }
        })()

        // Return deferred update immediately to acknowledge the interaction
        return {
          type: 6  // DEFERRED_UPDATE_MESSAGE
        }
      }

      if (customId.a === 'pp') {  // pickem_page
        const { p: page, l: leagueId, i: seasonIndex, w: weekIndex } = customId

        // Update form asynchronously
        ;(async () => {
          try {
            await showPickemForm(interaction.token, client, leagueId, guildId, userId, userName, undefined, page, weekIndex)
          } catch (e) {
            console.error("❌ Error loading page:", e)
          }
        })()

        // Return deferred update immediately
        return {
          type: 6  // DEFERRED_UPDATE_MESSAGE
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
      description: "Pick'em - predict game winners and compete on the leaderboard",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "pick",
          description: "Make your picks for the week's games",
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
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "leaderboard",
          description: "View the pick'em leaderboard for the season"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "lock",
          description: "Lock picks for a week (Commissioner only)",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "Week number to lock (defaults to current week)",
              required: false,
              min_value: 1,
              max_value: 18
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "unlock",
          description: "Unlock picks for a week (Commissioner only)",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "Week number to unlock (defaults to current week)",
              required: false,
              min_value: 1,
              max_value: 18
            }
          ]
        }
      ]
    }
  }
} as CommandHandler
