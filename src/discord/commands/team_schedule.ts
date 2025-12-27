import { ParameterizedContext } from "koa"
import { CommandHandler, Command, AutocompleteHandler, Autocomplete } from "../commands_handler"
import { respond, createMessageResponse, DiscordClient, deferMessage, NoConnectedLeagueError, formatTeamEmoji } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataStringOption, ApplicationCommandOptionType, ApplicationCommandType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { discordLeagueView, leagueLogosView, teamSearchView } from "../../db/view"
import MaddenDB from "../../db/madden_db"
import { GameResult, MADDEN_SEASON, formatRecord } from "../../export/madden_league_types"
import fuzzysort from "fuzzysort"

async function formatTeamSchedule(client: DiscordClient, token: string, leagueId: string, teamSearch: string, season?: number) {
  const teams = await MaddenDB.getLatestTeams(leagueId)
  const logos = await leagueLogosView.createView(leagueId)

  // Find team
  let teamId = Number(teamSearch)
  if (isNaN(teamId)) {
    const results = await teamSearchView.createView(leagueId)
    if (!results) {
      await client.editOriginalInteraction(token, { content: `No teams found` })
      return
    }
    const searchResults = fuzzysort.go(teamSearch, Object.values(results), { keys: ["displayName", "abbrName", "cityName"], limit: 1 })
    if (searchResults.length === 0) {
      await client.editOriginalInteraction(token, { content: `No team found matching "${teamSearch}"` })
      return
    }
    teamId = searchResults[0].obj.id
  }

  const team = teams.getTeamForId(teamId)
  const teamEmoji = formatTeamEmoji(logos, team.abbrName)
  const standing = await MaddenDB.getStandingForTeam(leagueId, teamId)
  const record = formatRecord(standing)

  // Get all games for the team
  const allGames = await MaddenDB.getTeamSchedule(leagueId, season)
  const teamGames = allGames.filter(g => g.homeTeamId === teamId || g.awayTeamId === teamId)
    .sort((a, b) => a.weekIndex - b.weekIndex)

  let message = `# ${teamEmoji} ${team.displayName} Schedule\n`
  message += `**Record**: ${record} | **Rank**: #${standing.rank}\n\n`

  // Group by season if needed
  const seasonGames = new Map<number, typeof teamGames>()
  teamGames.forEach(game => {
    if (!seasonGames.has(game.seasonIndex)) {
      seasonGames.set(game.seasonIndex, [])
    }
    seasonGames.get(game.seasonIndex)!.push(game)
  })

  for (const [seasonIdx, games] of seasonGames) {
    if (seasonGames.size > 1) {
      message += `## ${seasonIdx + MADDEN_SEASON} Season\n\n`
    }

    for (const game of games) {
      const isHome = game.homeTeamId === teamId
      const opponent = teams.getTeamForId(isHome ? game.awayTeamId : game.homeTeamId)
      const opponentEmoji = formatTeamEmoji(logos, opponent.abbrName)
      const location = isHome ? "vs" : "@"
      const weekText = game.weekIndex >= 18 ? getPlayoffWeekName(game.weekIndex + 1) : `Week ${game.weekIndex + 1}`

      if (game.status === GameResult.NOT_PLAYED) {
        message += `**${weekText}**: ${location} ${opponentEmoji} ${opponent.displayName} - *Not Played*\n`
      } else {
        const teamScore = isHome ? game.homeScore : game.awayScore
        const opponentScore = isHome ? game.awayScore : game.homeScore
        const result = teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "T"
        const resultEmoji = result === "W" ? "✅" : result === "L" ? "❌" : "⚖️"
        message += `**${weekText}**: ${location} ${opponentEmoji} ${opponent.displayName} - ${resultEmoji} ${teamScore}-${opponentScore}\n`
      }
    }
    message += `\n`
  }

  await client.editOriginalInteraction(token, { content: message })
}

function getPlayoffWeekName(week: number): string {
  switch (week) {
    case 19: return "Wild Card"
    case 20: return "Divisional"
    case 21: return "Conference Championship"
    case 23: return "Super Bowl"
    default: return `Week ${week}`
  }
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
    const teamOption = options.find(o => o.name === "team") as APIApplicationCommandInteractionDataStringOption
    const seasonOption = options.find(o => o.name === "season") as APIApplicationCommandInteractionDataIntegerOption | undefined

    if (!teamOption) {
      await client.editOriginalInteraction(token, { content: "Please specify a team" })
      return
    }

    const season = seasonOption ? Number(seasonOption.value) : undefined

    await formatTeamSchedule(client, token, discordLeague.leagueId, teamOption.value, season)
  },
  async choices(query: Autocomplete): Promise<{ name: string; value: string }[]> {
    const leagueId = (await discordLeagueView.createView(query.guild_id))?.leagueId
    if (!leagueId) {
      return []
    }

    const options = query.data.options
    if (!options) {
      return []
    }

    const focused = options.find((o: any) => o.focused)
    if (!focused || focused.name !== "team") {
      return []
    }

    const teamQuery = (focused as any).value as string
    const teamResults = await teamSearchView.createView(leagueId)
    if (!teamResults) {
      return []
    }

    const results = fuzzysort.go(teamQuery, Object.values(teamResults), { keys: ["displayName", "abbrName", "cityName", "nickName"], limit: 10 })

    return results.map(r => ({
      name: `${r.obj.displayName} (${r.obj.abbrName})`,
      value: `${r.obj.id}`
    }))
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "teamschedule",
      description: "View complete schedule for a specific team",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "team",
          description: "Team name or abbreviation",
          required: true,
          autocomplete: true
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: "season",
          description: "Season index (defaults to current season)",
          required: false,
          min_value: 0
        }
      ]
    }
  }
} as CommandHandler & AutocompleteHandler
