import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, getTeamOrThrow } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { DevTrait, MADDEN_SEASON } from "../../export/madden_league_types"
import {
  aggregatePlayerPerformance,
  evaluateTraitChange,
  getPositionGroup,
  getTraitName,
  getTraitChangeEmoji,
  TraitChange,
  PlayerPerformanceStats
} from "../../progression/dev_trait_system"

// Analyze season performance and suggest dev trait changes
async function analyzeTraitChanges(token: string, client: DiscordClient, league: string, season?: number) {
  try {
    console.log(`📊 analyzeTraitChanges called: league=${league}, season=${season}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# Dev Trait Analysis\n\n⏳ Analyzing player performance data... This may take a moment."
        }
      ]
    })

    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Get season index - if not provided, use latest season
    const seasonIndex = season !== undefined ? season : allPlayers[0]?.rookieYear || 0

    console.log(`📊 Processing ${allPlayers.length} players for season ${seasonIndex}`)

    // Aggregate performance for all players
    const performances: PlayerPerformanceStats[] = []
    let processed = 0

    for (const player of allPlayers) {
      try {
        const stats = await MaddenDB.getPlayerStats(league, player)
        const performance = aggregatePlayerPerformance(player, stats)

        // Only include players with meaningful playing time
        if (performance.gamesPlayed >= 4) {
          performances.push(performance)
        }

        processed++
        if (processed % 50 === 0) {
          console.log(`📊 Processed ${processed}/${allPlayers.length} players`)
        }
      } catch (e) {
        console.error(`Failed to process player ${player.rosterId}:`, e)
      }
    }

    console.log(`📊 Analyzed ${performances.length} players with sufficient playing time`)

    // Group by position and rank
    const positionGroups = new Map<string, PlayerPerformanceStats[]>()

    performances.forEach(perf => {
      const group = getPositionGroup(perf.position)
      if (!positionGroups.has(group)) {
        positionGroups.set(group, [])
      }
      positionGroups.get(group)!.push(perf)
    })

    // Sort each position group by score (descending)
    positionGroups.forEach((players, position) => {
      players.sort((a, b) => b.score - a.score)
    })

    // Evaluate trait changes
    const upgrades: TraitChange[] = []
    const downgrades: TraitChange[] = []
    const maintained: TraitChange[] = []

    positionGroups.forEach((players, position) => {
      players.forEach((perf, index) => {
        const ranking = index + 1
        const totalInPosition = players.length
        const player = allPlayers.find(p => p.rosterId === perf.rosterId)

        if (!player) {
          console.warn(`Player with rosterId ${perf.rosterId} not found in allPlayers list`);
          return;
        }

        const suggestedTrait = evaluateTraitChange(perf, ranking, totalInPosition)

        if (suggestedTrait !== null) {
          const change: TraitChange = {
            player,
            oldTrait: perf.currentTrait,
            newTrait: suggestedTrait,
            reason: `Ranked ${ranking}/${totalInPosition} in ${position}`,
            stats: perf,
            ranking,
            totalInPosition
          }

          if (suggestedTrait > perf.currentTrait) {
            upgrades.push(change)
          } else if (suggestedTrait < perf.currentTrait) {
            downgrades.push(change)
          } else {
            maintained.push(change)
          }
        }
      })
    })

    console.log(`📊 Found ${upgrades.length} upgrades, ${downgrades.length} downgrades`)

    // Build message
    let message = `# Dev Trait Analysis - Season ${MADDEN_SEASON + seasonIndex}\n\n`
    message += `**Players Analyzed:** ${performances.length}\n`
    message += `**Upgrades:** ${upgrades.length}\n`
    message += `**Downgrades:** ${downgrades.length}\n\n`

    // Show upgrades
    if (upgrades.length > 0) {
      message += `## ⬆️ Suggested Upgrades (${Math.min(upgrades.length, 15)} shown)\n\n`
      upgrades.slice(0, 15).forEach(change => {
        const team = teams.getTeamForId(change.player.teamId)
        const teamEmoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
        const emoji = getTraitChangeEmoji(change.oldTrait, change.newTrait)
        message += `${emoji} **${change.player.position} ${change.player.firstName} ${change.player.lastName}** ${teamEmoji}\n`
        message += `   ${getTraitName(change.oldTrait)} → **${getTraitName(change.newTrait)}**\n`
        message += `   ${change.reason} • ${change.stats.statDetails}\n\n`
      })
    }

    // Show downgrades
    if (downgrades.length > 0) {
      message += `## ⬇️ Suggested Downgrades (${Math.min(downgrades.length, 15)} shown)\n\n`
      downgrades.slice(0, 15).forEach(change => {
        const team = teams.getTeamForId(change.player.teamId)
        const teamEmoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
        const emoji = getTraitChangeEmoji(change.oldTrait, change.newTrait)
        message += `${emoji} **${change.player.position} ${change.player.firstName} ${change.player.lastName}** ${teamEmoji}\n`
        message += `   ${getTraitName(change.oldTrait)} → **${getTraitName(change.newTrait)}**\n`
        message += `   ${change.reason} • ${change.stats.statDetails}\n\n`
      })
    }

    if (upgrades.length === 0 && downgrades.length === 0) {
      message += `\n✅ No trait changes suggested based on current thresholds.\n`
    }

    message += `\n*Note: Changes are suggestions based on statistical performance. Apply manually in Madden or use a companion tool.*`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

    console.log(`✅ Analysis complete`)

  } catch (e) {
    console.error("❌ Error in analyzeTraitChanges:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to analyze trait changes: ${e}`
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
      throw new Error("progression command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    respond(ctx, deferMessage())

    if (subCommand.name === "analyze") {
      const season = (subCommand.options?.find(o => o.name === "season") as APIApplicationCommandInteractionDataIntegerOption)?.value
      analyzeTraitChanges(command.token, client, league, season ? Number(season) : undefined)
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "progression",
      description: "Dev trait progression/regression system based on performance",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "analyze",
          description: "Analyze season performance and suggest dev trait changes",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "season",
              description: "Season to analyze (defaults to current season)",
              required: false,
              min_value: 0,
              max_value: 30
            }
          ]
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler
