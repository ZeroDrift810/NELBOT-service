import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentInteraction, MessageComponentHandler } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, getTeamOrThrow } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView, discordLeagueView } from "../../db/view"
import { generateGameRecap, GameRecapData, isAnthropicConfigured } from "../../ai/anthropic_client"
import { GameResult, MADDEN_SEASON, PassingStats, RushingStats, ReceivingStats, DefensiveStats } from "../../export/madden_league_types"
import { PlayerStatType } from "../../db/madden_db"

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

    // Get games for the week - try to find completed games
    let allGames: any[] = []
    let targetWeekIndex = currentWeekIndex
    let targetSeasonIndex = currentSeasonIndex

    try {
      // getWeekScheduleForSeason expects 1-based week number
      allGames = await MaddenDB.getWeekScheduleForSeason(league, currentWeekIndex + 1, currentSeasonIndex)
    } catch (e) {
      console.warn(`No schedule for week ${currentWeekIndex + 1}, season ${currentSeasonIndex}. Trying to find recent games...`)

      // Fallback: Get latest schedule AND playoff schedule, find most recent completed games
      const [fullSchedule, playoffSchedule] = await Promise.all([
        MaddenDB.getLatestSchedule(league),
        MaddenDB.getPlayoffSchedule(league)
      ])

      // Combine regular and playoff games
      const allSchedule = [...fullSchedule, ...playoffSchedule]
      const completedFromSchedule = allSchedule
        .filter((g: any) => g.status !== GameResult.NOT_PLAYED)
        .sort((a: any, b: any) => {
          // Sort by season desc, then week desc to get most recent first
          if (a.seasonIndex !== b.seasonIndex) return b.seasonIndex - a.seasonIndex
          return b.weekIndex - a.weekIndex
        })

      if (completedFromSchedule.length > 0) {
        // Find the most recent week with completed games
        const latestGame = completedFromSchedule[0]
        targetWeekIndex = latestGame.weekIndex
        targetSeasonIndex = latestGame.seasonIndex
        allGames = completedFromSchedule.filter((g: any) =>
          g.weekIndex === targetWeekIndex && g.seasonIndex === targetSeasonIndex
        )
      }
    }

    const completedGames = allGames.filter((g: any) => g.status !== GameResult.NOT_PLAYED)

    if (completedGames.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# No Completed Games\n\nNo completed games found for Week ${currentWeekIndex + 1}. Games must be played before generating recaps.\n\nTry selecting a specific week from the dropdown below.`
          }
        ]
      })
      return
    }

    // Use the target week for display
    const displayWeekIndex = targetWeekIndex

    // Build game list display
    let message = `# 📰 AI Game Recap - Week ${displayWeekIndex + 1}\n\n**Select a game below to generate an AI-powered recap:**\n\n`

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

    // Get player stats
    const passingStats = (gameStats.playerStats[PlayerStatType.PASSING] || []) as PassingStats[]
    const rushingStats = (gameStats.playerStats[PlayerStatType.RUSHING] || []) as RushingStats[]
    const receivingStats = (gameStats.playerStats[PlayerStatType.RECEIVING] || []) as ReceivingStats[]
    const defensiveStats = (gameStats.playerStats[PlayerStatType.DEFENSE] || []) as DefensiveStats[]

    const topPerformers: { name: string; team: string; stat: string; category: 'passing' | 'rushing' | 'receiving' | 'defense' }[] = []
    const explosivePlays: { player: string; team: string; description: string }[] = []
    const keyDefensivePlays: { player: string; team: string; stat: string }[] = []

    // Get passing leaders (actual player names)
    const topPassers = passingStats
      .filter(p => p.passYds > 150)
      .sort((a, b) => b.passYds - a.passYds)
      .slice(0, 2)

    topPassers.forEach(passer => {
      const team = teams.getTeamForId(passer.teamId)
      const rating = passer.passerRating?.toFixed(1) || '0.0'
      topPerformers.push({
        name: passer.fullName,
        team: team?.abbrName || 'FA',
        stat: `${passer.passYds} yds, ${passer.passTDs} TD, ${passer.passInts} INT, ${rating} RTG`,
        category: 'passing'
      })
    })

    // Get rushing leaders (actual player names)
    const topRushers = rushingStats
      .filter(p => p.rushYds > 30)
      .sort((a, b) => b.rushYds - a.rushYds)
      .slice(0, 3)

    topRushers.forEach(rusher => {
      const team = teams.getTeamForId(rusher.teamId)
      const ypc = rusher.rushAtt > 0 ? (rusher.rushYds / rusher.rushAtt).toFixed(1) : '0.0'
      topPerformers.push({
        name: rusher.fullName,
        team: team?.abbrName || 'FA',
        stat: `${rusher.rushYds} rush yds, ${rusher.rushTDs} TD, ${ypc} YPC`,
        category: 'rushing'
      })

      // Track explosive runs (20+ yards)
      if ((rusher.rush20PlusYds || 0) > 0) {
        explosivePlays.push({
          player: rusher.fullName,
          team: team?.abbrName || 'FA',
          description: `${rusher.rush20PlusYds} runs of 20+ yds (long: ${rusher.rushLongest})`
        })
      }
    })

    // Get receiving leaders (actual player names)
    const topReceivers = receivingStats
      .filter(p => p.recYds > 30)
      .sort((a, b) => b.recYds - a.recYds)
      .slice(0, 3)

    topReceivers.forEach(receiver => {
      const team = teams.getTeamForId(receiver.teamId)
      const yac = receiver.recYdsAfterCatch || 0
      topPerformers.push({
        name: receiver.fullName,
        team: team?.abbrName || 'FA',
        stat: `${receiver.recCatches} rec, ${receiver.recYds} yds, ${receiver.recTDs} TD, ${yac} YAC`,
        category: 'receiving'
      })

      // Track explosive catches
      if ((receiver.recLongest || 0) >= 25) {
        explosivePlays.push({
          player: receiver.fullName,
          team: team?.abbrName || 'FA',
          description: `${receiver.recLongest} yd reception`
        })
      }
    })

    // Get defensive standouts
    const topDefenders = defensiveStats
      .filter(p => p.defTotalTackles > 3 || p.defSacks > 0 || p.defInts > 0 || p.defForcedFum > 0)
      .sort((a, b) => {
        // Prioritize by big plays (sacks, ints, FF) then tackles
        const aScore = (a.defSacks * 3) + (a.defInts * 4) + (a.defForcedFum * 3) + a.defTotalTackles
        const bScore = (b.defSacks * 3) + (b.defInts * 4) + (b.defForcedFum * 3) + b.defTotalTackles
        return bScore - aScore
      })
      .slice(0, 3)

    topDefenders.forEach(defender => {
      const team = teams.getTeamForId(defender.teamId)
      const statParts = []
      if (defender.defTotalTackles > 0) statParts.push(`${defender.defTotalTackles} TKL`)
      if (defender.defSacks > 0) statParts.push(`${defender.defSacks} SCK`)
      if (defender.defInts > 0) statParts.push(`${defender.defInts} INT`)
      if (defender.defForcedFum > 0) statParts.push(`${defender.defForcedFum} FF`)
      if (defender.defDeflections > 0) statParts.push(`${defender.defDeflections} PD`)

      topPerformers.push({
        name: defender.fullName,
        team: team?.abbrName || 'FA',
        stat: statParts.join(', '),
        category: 'defense'
      })

      // Key defensive plays
      if (defender.defSacks > 0 || defender.defInts > 0 || defender.defForcedFum > 0) {
        const plays = []
        if (defender.defSacks > 0) plays.push(`${defender.defSacks} sack${defender.defSacks > 1 ? 's' : ''}`)
        if (defender.defInts > 0) {
          const retYds = defender.defIntReturnYds || 0
          plays.push(`${defender.defInts} INT${retYds > 0 ? ` (${retYds} ret yds)` : ''}`)
        }
        if (defender.defForcedFum > 0) plays.push(`${defender.defForcedFum} forced fumble${defender.defForcedFum > 1 ? 's' : ''}`)
        if (defender.defTDs > 0) plays.push(`${defender.defTDs} DEF TD`)

        keyDefensivePlays.push({
          player: defender.fullName,
          team: team?.abbrName || 'FA',
          stat: plays.join(', ')
        })
      }
    })

    // Build GameRecapData with enhanced stats
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
        thirdDownAtt: homeTeamStats?.off3rdDownAtt || 0,
        sacks: homeTeamStats?.defSacks || 0,
        interceptions: homeTeamStats?.defIntsRec || 0,
        fumbles: homeTeamStats?.defFumRec || 0,
        redZoneAtt: homeTeamStats?.offRedZones || 0,
        redZoneTD: homeTeamStats?.offRedZoneTDs || 0,
        fourthDownConv: homeTeamStats?.off4thDownConv || 0,
        fourthDownAtt: homeTeamStats?.off4thDownAtt || 0
      },
      awayStats: {
        passYards: awayTeamStats?.offPassYds || 0,
        rushYards: awayTeamStats?.offRushYds || 0,
        totalYards: awayTeamStats?.offTotalYds || 0,
        turnovers: awayTeamStats?.tOGiveaways || 0,
        penalties: awayTeamStats?.penalties || 0,
        penaltyYards: awayTeamStats?.penaltyYds || 0,
        thirdDownConv: awayTeamStats?.off3rdDownConv || 0,
        thirdDownAtt: awayTeamStats?.off3rdDownAtt || 0,
        sacks: awayTeamStats?.defSacks || 0,
        interceptions: awayTeamStats?.defIntsRec || 0,
        fumbles: awayTeamStats?.defFumRec || 0,
        redZoneAtt: awayTeamStats?.offRedZones || 0,
        redZoneTD: awayTeamStats?.offRedZoneTDs || 0,
        fourthDownConv: awayTeamStats?.off4thDownConv || 0,
        fourthDownAtt: awayTeamStats?.off4thDownAtt || 0
      },
      topPerformers,
      explosivePlays,
      keyDefensivePlays
    }

    console.log(`📰 Generating AI recap with ${analyst} - ${topPerformers.length} performers, ${explosivePlays.length} explosive plays`)

    const recap = await generateGameRecap(recapData, analyst as Analyst)

    const homeEmoji = formatTeamEmoji(logos, homeTeamInfo.abbrName)
    const awayEmoji = formatTeamEmoji(logos, awayTeamInfo.abbrName)

    // Build enhanced box score
    let message = `# 📰 Game Recap - Week ${weekIndex + 1}\n\n`
    message += `## ${awayEmoji} ${awayTeamInfo.displayName} ${game.awayScore}, ${homeEmoji} ${homeTeamInfo.displayName} ${game.homeScore}\n\n`
    message += `**${analyst}'s Analysis:**\n\n`
    message += `${recap}\n\n`
    message += `---\n\n`

    // Enhanced box score
    message += `**📊 Box Score:**\n`
    message += `\`\`\`\n`
    message += `           ${awayTeamInfo.abbrName.padEnd(6)} ${homeTeamInfo.abbrName}\n`
    message += `Total     ${String(recapData.awayStats.totalYards).padStart(4)}    ${String(recapData.homeStats.totalYards).padStart(4)}\n`
    message += `Pass      ${String(recapData.awayStats.passYards).padStart(4)}    ${String(recapData.homeStats.passYards).padStart(4)}\n`
    message += `Rush      ${String(recapData.awayStats.rushYards).padStart(4)}    ${String(recapData.homeStats.rushYards).padStart(4)}\n`
    message += `TO        ${String(recapData.awayStats.turnovers).padStart(4)}    ${String(recapData.homeStats.turnovers).padStart(4)}\n`
    message += `3rd Dn  ${recapData.awayStats.thirdDownConv}/${recapData.awayStats.thirdDownAtt}    ${recapData.homeStats.thirdDownConv}/${recapData.homeStats.thirdDownAtt}\n`
    if (recapData.awayStats.redZoneAtt > 0 || recapData.homeStats.redZoneAtt > 0) {
      message += `Red Zn  ${recapData.awayStats.redZoneTD}/${recapData.awayStats.redZoneAtt}    ${recapData.homeStats.redZoneTD}/${recapData.homeStats.redZoneAtt}\n`
    }
    message += `\`\`\`\n\n`

    // Top performers summary
    if (topPerformers.length > 0) {
      message += `**⭐ Top Performers:**\n`
      topPerformers.slice(0, 5).forEach(p => {
        message += `• **${p.name}** (${p.team}): ${p.stat}\n`
      })
      message += `\n`
    }

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
    // Convert 1-based week number from user to 0-based weekIndex
    showWeekGames(command.token, client, league, weekOption !== undefined ? Number(weekOption) - 1 : undefined)
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
          min_value: 1,
          max_value: 22
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
