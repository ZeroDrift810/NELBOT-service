import { ParameterizedContext } from "koa"
import { CommandHandler, Command, AutocompleteHandler, Autocomplete } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { APIApplicationCommandInteractionDataStringOption, APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView, playerSearchIndex, teamSearchView } from "../../db/view"
import { Player, MADDEN_SEASON } from "../../export/madden_league_types"
import AwardsDB, { Award, AwardType, getAwardLabel, getAwardEmoji, getAllAwardTypes } from "../../db/awards_db"
import fuzzysort from "fuzzysort"

async function giveAward(
  token: string,
  client: DiscordClient,
  league: string,
  grantedBy: string,
  playerName: string,
  awardType: AwardType,
  seasonYear?: number
) {
  try {
    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Find player
    const searchResults = fuzzysort.go(playerName, allPlayers, {
      keys: ["firstName", "lastName"],
      threshold: 0.5
    })

    if (searchResults.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Award Error\n\nCould not find player matching "${playerName}".`
        }]
      })
      return
    }

    const player = searchResults[0].obj
    const team = teams.getTeamForId(player.teamId)
    const year = seasonYear || MADDEN_SEASON

    await AwardsDB.grantAward(league, {
      awardType,
      seasonYear: year,
      rosterId: player.rosterId,
      playerName: `${player.firstName} ${player.lastName}`,
      position: player.position,
      teamId: player.teamId,
      teamAbbr: team.abbrName,
      grantedBy
    })

    const teamEmoji = formatTeamEmoji(logos, team.abbrName)
    const awardEmoji = getAwardEmoji(awardType)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `# ${awardEmoji} Award Granted!\n\n**${getAwardLabel(awardType)}** (${year})\n\n${teamEmoji} ${player.firstName} ${player.lastName} (${player.position})`
      }]
    })
  } catch (e) {
    console.error("Error in giveAward:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to grant award: ${e}`
      }]
    })
  }
}

async function removeAward(
  token: string,
  client: DiscordClient,
  league: string,
  playerName: string,
  awardType: AwardType,
  seasonYear?: number
) {
  try {
    const allPlayers = await MaddenDB.getLatestPlayers(league)

    // Find player
    const searchResults = fuzzysort.go(playerName, allPlayers, {
      keys: ["firstName", "lastName"],
      threshold: 0.5
    })

    if (searchResults.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Award Error\n\nCould not find player matching "${playerName}".`
        }]
      })
      return
    }

    const player = searchResults[0].obj
    const year = seasonYear || MADDEN_SEASON

    const removed = await AwardsDB.removeAward(league, player.rosterId, awardType, year)

    if (removed) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Award Removed\n\n**${getAwardLabel(awardType)}** (${year}) removed from ${player.firstName} ${player.lastName}.`
        }]
      })
    } else {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Award Not Found\n\n${player.firstName} ${player.lastName} does not have **${getAwardLabel(awardType)}** for ${year}.`
        }]
      })
    }
  } catch (e) {
    console.error("Error in removeAward:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to remove award: ${e}`
      }]
    })
  }
}

async function showPlayerAwards(
  token: string,
  client: DiscordClient,
  league: string,
  playerName: string
) {
  try {
    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Find player
    const searchResults = fuzzysort.go(playerName, allPlayers, {
      keys: ["firstName", "lastName"],
      threshold: 0.5
    })

    if (searchResults.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Player Not Found\n\nCould not find player matching "${playerName}".`
        }]
      })
      return
    }

    const player = searchResults[0].obj
    const team = teams.getTeamForId(player.teamId)
    const teamEmoji = formatTeamEmoji(logos, team.abbrName)
    const awards = await AwardsDB.getPlayerAwards(league, player.rosterId)

    if (awards.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# ${teamEmoji} ${player.firstName} ${player.lastName}\n**${player.position}** | ${team.displayName}\n\n*No awards on record.*`
        }]
      })
      return
    }

    // Group by award type
    const awardsByType = new Map<AwardType, number[]>()
    for (const award of awards) {
      if (!awardsByType.has(award.awardType)) {
        awardsByType.set(award.awardType, [])
      }
      awardsByType.get(award.awardType)!.push(award.seasonYear)
    }

    let message = `# ${teamEmoji} ${player.firstName} ${player.lastName}\n**${player.position}** | ${team.displayName}\n\n## Career Awards\n\n`

    // Sort award types by prestige
    const awardOrder: AwardType[] = ["MVP", "SUPER_BOWL_MVP", "OPOY", "DPOY", "OROY", "DROY", "CPOY", "ALL_PRO_1ST", "ALL_PRO_2ND", "PRO_BOWL", "PASSING_LEADER", "RUSHING_LEADER", "RECEIVING_LEADER", "SACK_LEADER", "INT_LEADER"]

    for (const awardType of awardOrder) {
      const years = awardsByType.get(awardType)
      if (years && years.length > 0) {
        const emoji = getAwardEmoji(awardType)
        const label = getAwardLabel(awardType)
        const count = years.length > 1 ? ` (${years.length}x)` : ""
        const yearsList = years.sort((a, b) => b - a).join(", ")
        message += `${emoji} **${label}**${count}\n> ${yearsList}\n\n`
      }
    }

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showPlayerAwards:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show player awards: ${e}`
      }]
    })
  }
}

async function showSeasonAwards(
  token: string,
  client: DiscordClient,
  league: string,
  seasonYear?: number
) {
  try {
    const [logos] = await Promise.all([
      leagueLogosView.createView(league)
    ])

    const year = seasonYear || MADDEN_SEASON
    const awards = await AwardsDB.getSeasonAwards(league, year)

    if (awards.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# ${year} Season Awards\n\n*No awards have been granted for this season yet.*`
        }]
      })
      return
    }

    let message = `# 🏆 ${year} Season Awards\n\n`

    // Sort awards by type
    const awardOrder: AwardType[] = ["MVP", "SUPER_BOWL_MVP", "OPOY", "DPOY", "OROY", "DROY", "CPOY", "ALL_PRO_1ST", "ALL_PRO_2ND", "PRO_BOWL", "PASSING_LEADER", "RUSHING_LEADER", "RECEIVING_LEADER", "SACK_LEADER", "INT_LEADER"]

    const awardsByType = new Map<AwardType, Award[]>()
    for (const award of awards) {
      if (!awardsByType.has(award.awardType)) {
        awardsByType.set(award.awardType, [])
      }
      awardsByType.get(award.awardType)!.push(award)
    }

    for (const awardType of awardOrder) {
      const typeAwards = awardsByType.get(awardType)
      if (typeAwards && typeAwards.length > 0) {
        const emoji = getAwardEmoji(awardType)
        const label = getAwardLabel(awardType)
        message += `## ${emoji} ${label}\n`

        for (const award of typeAwards) {
          const teamEmoji = formatTeamEmoji(logos, award.teamAbbr)
          message += `${teamEmoji} ${award.playerName} (${award.position})\n`
        }
        message += '\n'
      }
    }

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showSeasonAwards:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show season awards: ${e}`
      }]
    })
  }
}

async function showAwardHistory(
  token: string,
  client: DiscordClient,
  league: string,
  awardType: AwardType
) {
  try {
    const [logos] = await Promise.all([
      leagueLogosView.createView(league)
    ])

    const awards = await AwardsDB.getAwardHistory(league, awardType)
    const emoji = getAwardEmoji(awardType)
    const label = getAwardLabel(awardType)

    if (awards.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# ${emoji} ${label} History\n\n*No winners on record.*`
        }]
      })
      return
    }

    let message = `# ${emoji} ${label} History\n\n`

    // Group by season
    const byYear = new Map<number, Award[]>()
    for (const award of awards) {
      if (!byYear.has(award.seasonYear)) {
        byYear.set(award.seasonYear, [])
      }
      byYear.get(award.seasonYear)!.push(award)
    }

    const years = Array.from(byYear.keys()).sort((a, b) => b - a)

    for (const year of years) {
      const yearAwards = byYear.get(year)!
      message += `## ${year}\n`
      for (const award of yearAwards) {
        const teamEmoji = formatTeamEmoji(logos, award.teamAbbr)
        message += `${teamEmoji} ${award.playerName} (${award.position})\n`
      }
      message += '\n'
    }

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    console.error("Error in showAwardHistory:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `Failed to show award history: ${e}`
      }]
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, member } = command

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    if (!command.data.options) {
      throw new Error("awards command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    respond(ctx, deferMessage())

    if (subCommand.name === "give") {
      const player = (subCommand.options?.find(o => o.name === "player") as APIApplicationCommandInteractionDataStringOption)?.value
      const award = (subCommand.options?.find(o => o.name === "award") as APIApplicationCommandInteractionDataStringOption)?.value as AwardType
      const season = (subCommand.options?.find(o => o.name === "season") as APIApplicationCommandInteractionDataIntegerOption)?.value

      if (!player || !award) {
        throw new Error("Player and award are required")
      }

      giveAward(command.token, client, league, member.user.id, player, award, season ? Number(season) : undefined)
    } else if (subCommand.name === "remove") {
      const player = (subCommand.options?.find(o => o.name === "player") as APIApplicationCommandInteractionDataStringOption)?.value
      const award = (subCommand.options?.find(o => o.name === "award") as APIApplicationCommandInteractionDataStringOption)?.value as AwardType
      const season = (subCommand.options?.find(o => o.name === "season") as APIApplicationCommandInteractionDataIntegerOption)?.value

      if (!player || !award) {
        throw new Error("Player and award are required")
      }

      removeAward(command.token, client, league, player, award, season ? Number(season) : undefined)
    } else if (subCommand.name === "player") {
      const player = (subCommand.options?.find(o => o.name === "player") as APIApplicationCommandInteractionDataStringOption)?.value
      if (!player) {
        throw new Error("Player is required")
      }
      showPlayerAwards(command.token, client, league, player)
    } else if (subCommand.name === "season") {
      const season = (subCommand.options?.find(o => o.name === "year") as APIApplicationCommandInteractionDataIntegerOption)?.value
      showSeasonAwards(command.token, client, league, season ? Number(season) : undefined)
    } else if (subCommand.name === "history") {
      const award = (subCommand.options?.find(o => o.name === "award") as APIApplicationCommandInteractionDataStringOption)?.value as AwardType
      if (!award) {
        throw new Error("Award type is required")
      }
      showAwardHistory(command.token, client, league, award)
    }
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    const awardChoices = getAllAwardTypes().map(type => ({
      name: getAwardLabel(type),
      value: type
    }))

    return {
      name: "awards",
      description: "Manage and view player awards",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "give",
          description: "Grant an award to a player (admin)",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "player",
              description: "Player name (e.g., Patrick Mahomes)",
              required: true,
              autocomplete: true
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "award",
              description: "Award type",
              required: true,
              choices: awardChoices
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "season",
              description: "Season year (defaults to current)",
              required: false,
              min_value: 2020,
              max_value: 2030
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "remove",
          description: "Remove an award from a player (admin)",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "player",
              description: "Player name",
              required: true,
              autocomplete: true
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "award",
              description: "Award type",
              required: true,
              choices: awardChoices
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "season",
              description: "Season year (defaults to current)",
              required: false,
              min_value: 2020,
              max_value: 2030
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "player",
          description: "View a player's career awards",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "player",
              description: "Player name",
              required: true,
              autocomplete: true
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "season",
          description: "View all awards for a season",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "year",
              description: "Season year (defaults to current)",
              required: false,
              min_value: 2020,
              max_value: 2030
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "history",
          description: "View all winners of a specific award",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "award",
              description: "Award type",
              required: true,
              choices: awardChoices
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

    // Find the player option
    const playerOption = subCommand.options?.find(o => o.name === "player") as APIApplicationCommandInteractionDataStringOption | undefined

    if (playerOption?.focused && playerOption.value) {
      const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
      const leagueId = leagueSettings.commands.madden_league?.league_id
      if (leagueId) {
        const [playersToSearch, teamsToSearch] = await Promise.all([
          playerSearchIndex.createView(leagueId),
          teamSearchView.createView(leagueId)
        ])
        if (playersToSearch && teamsToSearch) {
          const playerArray = Object.values(playersToSearch)
          const results = fuzzysort.go(playerOption.value, playerArray, {
            keys: ["firstName", "lastName"],
            threshold: 0.4,
            limit: 25
          })
          return results.map(r => {
            const team = teamsToSearch[r.obj.teamId]
            const teamAbbr = team?.abbrName || "FA"
            return {
              name: `${r.obj.firstName} ${r.obj.lastName} (${r.obj.position} - ${teamAbbr})`,
              value: `${r.obj.firstName} ${r.obj.lastName}`
            }
          })
        }
      }
    }
    return []
  }
} as CommandHandler & AutocompleteHandler
