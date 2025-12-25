import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentInteraction, MessageComponentHandler } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, getTeamOrThrow } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView, discordLeagueView } from "../../db/view"
import { generateGameRecap, GameRecapData, isAnthropicConfigured } from "../../ai/anthropic_client"
import { GameResult, MADDEN_SEASON } from "../../export/madden_league_types"

type Analyst = 'Tom Brady' | 'Greg Olsen' | 'Stephen A. Smith' | 'Tony Romo' | 'Al Michaels'

async function showWeekGames(token: string, client: DiscordClient, league: string, weekIndex?: number) {
  try {
    console.log(`📰 showWeekGames called: league=${league}, weekIndex=${weekIndex}`)

    if (!isAnthropicConfigured()) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# ⚠️ Anthropic API Not Configured\n\nTo use AI-generated game recaps, you need to add your Anthropic API key to the .env file:\n\n1. Add this line to your .env file:\n   `ANTHROPIC_API_KEY=your-api-key-here`\n2. Restart the bot\n3. Run this command again\n\nGet your API key at: https://console.anthropic.com/"
          }
        ]
      })
      return
    }

    const [teams, logos, weeks] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league)
    ])

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0
    const currentWeekIndex = weekIndex !== undefined ? weekIndex : weeks[0]?.weekIndex || 0

    // Get games for the week
    const allGames = await MaddenDB.getWeekScheduleForSeason(league, currentWeekIndex, currentSeasonIndex)
    const completedGames = allGames.filter((g: any) => g.status !== GameResult.NOT_PLAYED)

    if (completedGames.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# No Completed Games\n\nNo completed games found for Week ${currentWeekIndex + 1}. Games must be played before generating recaps.`
          }
        ]
      })
      return
    }

    // Build game list display
    let message = `# 📰 AI Game Recap - Week ${currentWeekIndex + 1}\n\n**Select a game below to generate an AI-powered recap:**\n\n`

    completedGames.forEach((game: any) => {
      const homeTeam = getTeamOrThrow(teams, game.homeTeamId)
      const awayTeam = getTeamOrThrow(teams, game.awayTeamId)
      const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)
      message += `${awayEmoji} ${awayTeam.abbrName} ${game.awayScore} @ ${homeEmoji} ${homeTeam.abbrName} ${game.homeScore}\n`
    })

    message += `\n*Choose an analyst personality to generate the recap in their voice.*`

    // Create game select options
    const gameOptions = completedGames.map((game: any) => {
      const homeTeam = getTeamOrThrow(teams, game.homeTeamId)
      const awayTeam = getTeamOrThrow(teams, game.awayTeamId)
      return {
        label: `${awayTeam.abbrName} ${game.awayScore} @ ${homeTeam.abbrName} ${game.homeScore}`,
        value: JSON.stringify({
          w: game.weekIndex,
          s: game.seasonIndex,
          sid: game.scheduleId,
          h: homeTeam.abbrName,
          a: awayTeam.abbrName
        })
      }
    }).slice(0, 25) // Discord limit

    // Week selector for navigation
    const weekOptions = weeks
      .filter((w: any) => w.seasonIndex === currentSeasonIndex && w.weekType === 'reg')
      .map((w: any) => ({
        label: `Week ${w.weekIndex + 1}`,
        value: JSON.stringify({ w: w.weekIndex }),
        default: w.weekIndex === currentWeekIndex
      }))
      .slice(0, 25)

    const components: any[] = []

    if (gameOptions.length > 0) {
      components.push(
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "gamerecap_game_selector",
              placeholder: "Select a game",
              options: gameOptions
            }
          ]
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Large
        }
      )
    }

    if (weekOptions.length > 1) {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "gamerecap_week_selector",
            placeholder: "Change week",
            options: weekOptions
          }
        ]
      })
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

  } catch (e) {
    console.error("❌ Error in showWeekGames:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show games: ${e}`
        }
      ]
    })
  }
}

async function showAnalystSelector(token: string, client: DiscordClient, gameData: any) {
  try {
    const message = `# Select Analyst\n\n**Game:** ${gameData.a} @ ${gameData.h}\n\nChoose which analyst will provide the game recap:`

    const analystOptions = [
      { label: "Tony Romo - Strategic breakdown", value: JSON.stringify({ ...gameData, analyst: 'Tony Romo' }) },
      { label: "Tom Brady - QB-focused analysis", value: JSON.stringify({ ...gameData, analyst: 'Tom Brady' }) },
      { label: "Greg Olsen - Detailed matchup insights", value: JSON.stringify({ ...gameData, analyst: 'Greg Olsen' }) },
      { label: "Stephen A. Smith - Passionate commentary", value: JSON.stringify({ ...gameData, analyst: 'Stephen A. Smith' }) },
      { label: "Al Michaels - Legendary storytelling", value: JSON.stringify({ ...gameData, analyst: 'Al Michaels' }) }
    ]

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "gamerecap_analyst_selector",
              placeholder: "Select analyst",
              options: analystOptions
            }
          ]
        }
      ]
    })
  } catch (e) {
    console.error("❌ Error in showAnalystSelector:", e)
  }
}

async function generateRecap(token: string, client: DiscordClient, league: string, gameData: any) {
  try {
    const { w: weekIndex, s: seasonIndex, sid: scheduleId, analyst } = gameData

    console.log(`📰 generateRecap called: league=${league}, week=${weekIndex}, scheduleId=${scheduleId}, analyst=${analyst}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `# AI Game Recap\n\n⏳ ${analyst} is analyzing the game... This may take a moment.`
        }
      ]
    })

    const [teams, logos] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Get the game (convert 0-based weekIndex to 1-based week number)
    const game = await MaddenDB.getGameForSchedule(league, scheduleId, weekIndex + 1, seasonIndex)
    const homeTeamInfo = getTeamOrThrow(teams, game.homeTeamId)
    const awayTeamInfo = getTeamOrThrow(teams, game.awayTeamId)

    // Get game stats (convert 0-based weekIndex to 1-based week number)
    const gameStats = await MaddenDB.getStatsForGame(league, seasonIndex, weekIndex + 1, scheduleId)

    // Get team-specific stats
    const homeTeamStats = gameStats.teamStats.find(ts => ts.teamId === game.homeTeamId)
    const awayTeamStats = gameStats.teamStats.find(ts => ts.teamId === game.awayTeamId)

    const topPerformers: { name: string; team: string; stat: string }[] = []

    // Get passing leaders from game stats
    if (homeTeamStats?.offPassYds || awayTeamStats?.offPassYds) {
      const homePassYds = homeTeamStats?.offPassYds || 0
      const awayPassYds = awayTeamStats?.offPassYds || 0

      if (homePassYds > 200) {
        topPerformers.push({
          name: "QB",
          team: homeTeamInfo.abbrName,
          stat: `${homePassYds} pass yds`
        })
      }
      if (awayPassYds > 200) {
        topPerformers.push({
          name: "QB",
          team: awayTeamInfo.abbrName,
          stat: `${awayPassYds} pass yds`
        })
      }
    }

    // Get rushing leaders
    if (homeTeamStats?.offRushYds || awayTeamStats?.offRushYds) {
      const homeRushYds = homeTeamStats?.offRushYds || 0
      const awayRushYds = awayTeamStats?.offRushYds || 0

      if (homeRushYds > 100) {
        topPerformers.push({
          name: "RB",
          team: homeTeamInfo.abbrName,
          stat: `${homeRushYds} rush yds`
        })
      }
      if (awayRushYds > 100) {
        topPerformers.push({
          name: "RB",
          team: awayTeamInfo.abbrName,
          stat: `${awayRushYds} rush yds`
        })
      }
    }

    // Build GameRecapData
    const recapData: GameRecapData = {
      weekIndex,
      seasonIndex,
      homeTeam: homeTeamInfo.displayName,
      awayTeam: awayTeamInfo.displayName,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      winnerName: game.homeScore > game.awayScore ? homeTeamInfo.displayName : awayTeamInfo.displayName,
      loserName: game.homeScore > game.awayScore ? awayTeamInfo.displayName : homeTeamInfo.displayName,
      homeStats: {
        passYards: homeTeamStats?.offPassYds || 0,
        rushYards: homeTeamStats?.offRushYds || 0,
        totalYards: homeTeamStats?.offTotalYds || 0,
        turnovers: homeTeamStats?.tOGiveaways || 0,
        penalties: homeTeamStats?.penalties || 0,
        penaltyYards: homeTeamStats?.penaltyYds || 0,
        thirdDownConv: homeTeamStats?.off3rdDownConv || 0,
        thirdDownAtt: homeTeamStats?.off3rdDownAtt || 0
      },
      awayStats: {
        passYards: awayTeamStats?.offPassYds || 0,
        rushYards: awayTeamStats?.offRushYds || 0,
        totalYards: awayTeamStats?.offTotalYds || 0,
        turnovers: awayTeamStats?.tOGiveaways || 0,
        penalties: awayTeamStats?.penalties || 0,
        penaltyYards: awayTeamStats?.penaltyYds || 0,
        thirdDownConv: awayTeamStats?.off3rdDownConv || 0,
        thirdDownAtt: awayTeamStats?.off3rdDownAtt || 0
      },
      topPerformers
    }

    console.log(`📰 Generating AI recap with ${analyst}`)

    const recap = await generateGameRecap(recapData, analyst as Analyst)

    const homeEmoji = formatTeamEmoji(logos, homeTeamInfo.abbrName)
    const awayEmoji = formatTeamEmoji(logos, awayTeamInfo.abbrName)

    let message = `# 📰 Game Recap - Week ${weekIndex + 1}\n\n`
    message += `## ${awayEmoji} ${awayTeamInfo.displayName} ${game.awayScore}, ${homeEmoji} ${homeTeamInfo.displayName} ${game.homeScore}\n\n`
    message += `**${analyst}'s Analysis:**\n\n`
    message += `${recap}\n\n`
    message += `---\n\n`
    message += `**Final Stats:**\n`
    message += `${awayTeamInfo.abbrName}: ${recapData.awayStats.totalYards} yds, ${recapData.awayStats.turnovers} TO\n`
    message += `${homeTeamInfo.abbrName}: ${recapData.homeStats.totalYards} yds, ${recapData.homeStats.turnovers} TO\n\n`
    message += `*🤖 Powered by Claude AI*`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })

    console.log(`✅ Game recap generation complete`)

  } catch (e) {
    console.error("❌ Error in generateRecap:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate game recap: ${e}`
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

    const options = command.data.options || []
    const weekOption = (options.find(o => o.name === "week") as APIApplicationCommandInteractionDataIntegerOption)?.value

    respond(ctx, deferMessage())
    showWeekGames(command.token, client, league, weekOption !== undefined ? Number(weekOption) : undefined)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "gamerecap",
      description: "Generate AI-powered game recap with analyst personality",
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "week",
          description: "Week number (defaults to current week)",
          required: false,
          min_value: 0,
          max_value: 21
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  },
  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    const { custom_id, token, guild_id } = interaction

    const view = await discordLeagueView.createView(guild_id)
    const leagueId = view?.leagueId
    if (!leagueId) {
      throw new Error("Could not find a linked Madden league")
    }

    if (custom_id === "gamerecap_week_selector") {
      const data = interaction.data as any
      const selectedValue = data.values?.[0]
      if (!selectedValue) {
        throw new Error("No week selected")
      }
      const { w: weekIndex } = JSON.parse(selectedValue)

      // Update message to show loading, then show games for selected week
      showWeekGames(token, client, leagueId, weekIndex)
      return { type: 6 } // DEFERRED_UPDATE_MESSAGE
    }

    if (custom_id === "gamerecap_game_selector") {
      const data = interaction.data as any
      const selectedValue = data.values?.[0]
      if (!selectedValue) {
        throw new Error("No game selected")
      }
      const gameData = JSON.parse(selectedValue)
      showAnalystSelector(token, client, gameData)
      return { type: 6 }
    }

    if (custom_id === "gamerecap_analyst_selector") {
      const data = interaction.data as any
      const selectedValue = data.values?.[0]
      if (!selectedValue) {
        throw new Error("No analyst selected")
      }
      const gameData = JSON.parse(selectedValue)
      generateRecap(token, client, leagueId, gameData)
      return { type: 6 }
    }

    throw new Error("Invalid gamerecap interaction")
  }
} as CommandHandler & MessageComponentHandler
