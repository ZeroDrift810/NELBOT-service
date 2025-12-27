import { ParameterizedContext } from "koa"
import { CommandHandler, Command, AutocompleteHandler, Autocomplete } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataStringOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { discordLeagueView, leagueLogosView, teamSearchView } from "../../db/view"
import { Player, MADDEN_SEASON } from "../../export/madden_league_types"
import fuzzysort from "fuzzysort"

// Show current season's draft class (rookies)
async function showDraftClass(token: string, client: DiscordClient, league: string) {
  try {
    console.log(`📋 showDraftClass called: league=${league}`)

    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Get all rookies (yearsPro = 0)
    const rookies = allPlayers.filter(p => p.yearsPro === 0)

    if (rookies.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# Draft Class\n\nNo rookies found in the league. The draft may not have occurred yet."
          }
        ]
      })
      return
    }

    // Sort by draft pick (overall)
    const sortedRookies = rookies
      .filter(r => r.draftPick > 0) // Only include actually drafted players
      .sort((a, b) => a.draftPick - b.draftPick)
      .slice(0, 50) // Limit to first 50 picks to avoid message size limits

    // Group by round
    const rounds = new Map<number, Player[]>()
    sortedRookies.forEach(player => {
      if (!rounds.has(player.draftRound)) {
        rounds.set(player.draftRound, [])
      }
      rounds.get(player.draftRound)!.push(player)
    })

    let message = `# ${MADDEN_SEASON} Draft Class\n\n**Total Rookies:** ${rookies.length}\n**Showing:** Top ${sortedRookies.length} picks\n\n`

    // Show first 3 rounds in detail
    for (let round = 1; round <= Math.min(3, Math.max(...rounds.keys())); round++) {
      const roundPicks = rounds.get(round) || []
      if (roundPicks.length === 0) continue

      message += `## Round ${round}\n`
      roundPicks.forEach(player => {
        const team = teams.getTeamForId(player.teamId)
        const teamEmoji = formatTeamEmoji(logos, team.abbrName)
        const pickInRound = player.draftPick - ((round - 1) * 32)
        message += `**${player.draftPick}.** ${teamEmoji} ${team.abbrName} - ${player.position} ${player.firstName} ${player.lastName} (${player.playerBestOvr} OVR)\n`
      })
      message += '\n'
    }

    // Summary of other rounds
    const remainingRounds = Array.from(rounds.keys()).filter(r => r > 3).sort((a, b) => a - b)
    if (remainingRounds.length > 0) {
      message += `**Other Rounds:** ${remainingRounds.join(', ')}\n`
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
    console.error("❌ Error in showDraftClass:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show draft class: ${e}`
        }
      ]
    })
  }
}

// Show draft history with filters
async function showDraftHistory(token: string, client: DiscordClient, league: string, round?: number, position?: string) {
  try {
    console.log(`📋 showDraftHistory called: league=${league}, round=${round}, position=${position}`)

    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Filter drafted players
    let draftedPlayers = allPlayers.filter(p => p.draftPick > 0 && p.draftRound > 0)

    if (round) {
      draftedPlayers = draftedPlayers.filter(p => p.draftRound === round)
    }

    if (position) {
      draftedPlayers = draftedPlayers.filter(p => p.position.toUpperCase() === position.toUpperCase())
    }

    if (draftedPlayers.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# Draft History\n\nNo drafted players found${round ? ` in round ${round}` : ''}${position ? ` at position ${position}` : ''}.`
          }
        ]
      })
      return
    }

    // Sort by draft pick
    const sortedPlayers = draftedPlayers
      .sort((a, b) => a.draftPick - b.draftPick)
      .slice(0, 25) // Limit to 25 for display

    let message = `# Draft History${round ? ` - Round ${round}` : ''}${position ? ` - ${position}` : ''}\n\n**Total:** ${draftedPlayers.length} players\n**Showing:** ${sortedPlayers.length}\n\n`

    sortedPlayers.forEach(player => {
      const team = teams.getTeamForId(player.teamId)
      const teamEmoji = formatTeamEmoji(logos, team.abbrName)
      message += `**Pick ${player.draftPick}** (Rd ${player.draftRound}) - ${teamEmoji} ${team.abbrName} - ${player.position} ${player.firstName} ${player.lastName} (${player.playerBestOvr} OVR, ${player.yearsPro} yrs)\n`
    })

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
    console.error("❌ Error in showDraftHistory:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show draft history: ${e}`
        }
      ]
    })
  }
}

// Show team's draft history
async function showTeamDraft(token: string, client: DiscordClient, league: string, teamSearchPhrase: string) {
  try {
    console.log(`📋 showTeamDraft called: league=${league}, team=${teamSearchPhrase}`)

    const [allPlayers, teams, logos, teamsToSearch] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      teamSearchView.createView(league)
    ])

    // Find team
    if (!teamsToSearch) {
      throw new Error("No teams found in league")
    }

    const results = fuzzysort.go(teamSearchPhrase, Object.values(teamsToSearch), {
      keys: ["cityName", "abbrName", "nickName", "displayName"],
      threshold: 0.9
    })

    if (results.length < 1) {
      throw new Error(`Could not find team for phrase ${teamSearchPhrase}. Enter a team name, city, abbreviation, or nickname. Examples: Buccaneers, TB, Tampa Bay, Bucs`)
    } else if (results.length > 1) {
      throw new Error(`Found more than one team for phrase ${teamSearchPhrase}. Enter a team name, city, abbreviation, or nickname. Examples: Buccaneers, TB, Tampa Bay, Bucs. Found teams: ${results.map(t => t.obj.displayName).join(", ")}`)
    }

    const foundTeam = results[0].obj
    const team = teams.getTeamForId(foundTeam.id)
    const teamEmoji = formatTeamEmoji(logos, team.abbrName)

    // Get team's drafted players
    const teamDraftPicks = allPlayers
      .filter(p => p.teamId === team.teamId && p.draftPick > 0 && p.draftRound > 0)
      .sort((a, b) => a.draftPick - b.draftPick)

    if (teamDraftPicks.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# ${teamEmoji} ${team.displayName} Draft History\n\nNo draft picks found for this team.`
          }
        ]
      })
      return
    }

    // Group by year (using yearsPro to estimate draft year)
    const currentYear = MADDEN_SEASON
    const picksByYear = new Map<number, Player[]>()

    teamDraftPicks.forEach(player => {
      const draftYear = currentYear - player.yearsPro
      if (!picksByYear.has(draftYear)) {
        picksByYear.set(draftYear, [])
      }
      picksByYear.get(draftYear)!.push(player)
    })

    let message = `# ${teamEmoji} ${team.displayName} Draft History\n\n**Total Draft Picks:** ${teamDraftPicks.length}\n\n`

    // Show most recent drafts first
    const years = Array.from(picksByYear.keys()).sort((a, b) => b - a).slice(0, 5)

    years.forEach(year => {
      const picks = picksByYear.get(year)!
      message += `## ${year} Draft (${picks.length} picks)\n`
      picks.forEach(player => {
        message += `**Pick ${player.draftPick}** (Rd ${player.draftRound}) - ${player.position} ${player.firstName} ${player.lastName} (${player.playerBestOvr} OVR)\n`
      })
      message += '\n'
    })

    if (picksByYear.size > 5) {
      message += `*Showing most recent 5 draft years. Total years: ${picksByYear.size}*\n`
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
    console.error("❌ Error in showTeamDraft:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show team draft history: ${e}`
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

    if (!command.data.options) {
      throw new Error("draft command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    respond(ctx, deferMessage())

    if (subCommand.name === "class") {
      showDraftClass(command.token, client, league)
    } else if (subCommand.name === "history") {
      const round = (subCommand.options?.find(o => o.name === "round") as APIApplicationCommandInteractionDataIntegerOption)?.value
      const position = (subCommand.options?.find(o => o.name === "position") as APIApplicationCommandInteractionDataStringOption)?.value
      showDraftHistory(command.token, client, league, round ? Number(round) : undefined, position)
    } else if (subCommand.name === "team") {
      const teamSearchPhrase = (subCommand.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.value
      if (!teamSearchPhrase) {
        throw new Error("Team parameter is required")
      }
      showTeamDraft(command.token, client, league, teamSearchPhrase.toLowerCase())
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "draft",
      description: "View draft information",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "class",
          description: "View current season's draft class (rookies)",
          options: []
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "history",
          description: "View draft history with filters",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "round",
              description: "Filter by draft round (1-7)",
              required: false,
              min_value: 1,
              max_value: 7
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "position",
              description: "Filter by position (QB, RB, WR, etc.)",
              required: false
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "team",
          description: "View a team's draft history",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "team",
              description: "Ex: Buccaneers, TB, Tampa Bay, Bucs",
              required: true,
              autocomplete: true
            }
          ]
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  },
  async choices(command: Autocomplete) {
    const { guild_id } = command
    if (!command.data.options) {
      return []
    }
    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const view = await discordLeagueView.createView(guild_id)
    const leagueId = view?.leagueId
    if (leagueId && subCommand.name === "team" && (subCommand?.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.focused && subCommand?.options?.[0]?.value) {
      const teamSearchPhrase = subCommand.options[0].value as string
      const teamsToSearch = await teamSearchView.createView(leagueId)
      if (teamsToSearch) {
        const results = fuzzysort.go(teamSearchPhrase, Object.values(teamsToSearch), { keys: ["cityName", "abbrName", "nickName", "displayName"], threshold: 0.4, limit: 25 })
        return results.map(r => ({ name: r.obj.displayName, value: r.obj.displayName }))
      }
    }
    return []
  }
} as CommandHandler & AutocompleteHandler
