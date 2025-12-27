import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentHandler, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, getTeamOrThrow } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, APIMessageStringSelectInteractionData, SeparatorSpacingSize, InteractionResponseType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, GameResult } from "../../export/madden_league_types"
import { generatePowerRankingNarrative, TeamPowerRankingData, isAnthropicConfigured } from "../../ai/anthropic_client"
import { calculatePowerRankings, TeamGameData } from "./powerrankings_engine"

type RankingRange = "1-6" | "7-12" | "13-18" | "19-24" | "25-32"

async function generatePowerRankings(token: string, client: DiscordClient, league: string, range: RankingRange = "1-6") {
  try {
    console.log(`🏆 generatePowerRankings called: league=${league}`)

    if (!isAnthropicConfigured()) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# ⚠️ Anthropic API Not Configured\n\nTo use AI-generated power rankings, you need to add your Anthropic API key to the .env file:\n\n1. Add this line to your .env file:\n   `ANTHROPIC_API_KEY=your-api-key-here`\n2. Restart the bot\n3. Run this command again\n\nGet your API key at: https://console.anthropic.com/"
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
          content: "# NEL Power Rankings\n\n⏳ Analyzing team performance data... This may take a moment."
        }
      ]
    })

    const [teams, logos, weeks, standings] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league),
      MaddenDB.getLatestStandings(league)
    ])

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0
    const currentWeekIndex = weeks[0]?.weekIndex || 0

    console.log(`🏆 Processing ${standings.length} teams for power rankings`)
    console.log(`🏆 Season ${currentSeasonIndex}, Week ${currentWeekIndex}`)

    // Get ALL games for the current season (all weeks up to current)
    // If in offseason or week 0, use previous season's data
    let targetSeasonIndex = currentSeasonIndex
    let targetWeekIndex = currentWeekIndex

    // If week 0 or no weeks in current season, try to use previous season's data
    const currentSeasonWeeks = weeks.filter(w => w.seasonIndex === currentSeasonIndex)
    if (currentSeasonWeeks.length === 0 || currentWeekIndex === 0) {
      console.log(`🏆 In offseason or week 0, looking for previous season data`)
      console.log(`🏆 Current season: ${currentSeasonIndex}, Current week: ${currentWeekIndex}`)
      console.log(`🏆 Total weeks in database: ${weeks.length}`)

      // Find the most recent season that has weeks with games
      const availableSeasons = [...new Set(weeks.map(w => w.seasonIndex))].sort((a, b) => b - a)
      console.log(`🏆 Available seasons: ${availableSeasons.join(', ')}`)

      let foundPrevSeason = false

      for (const season of availableSeasons) {
        const seasonWeeks = weeks.filter(w => w.seasonIndex === season)
        console.log(`🏆 Season ${season}: ${seasonWeeks.length} weeks (week ${Math.min(...seasonWeeks.map(w => w.weekIndex))} to ${Math.max(...seasonWeeks.map(w => w.weekIndex))})`)

        if (season < currentSeasonIndex) {
          if (seasonWeeks.length > 0) {
            targetSeasonIndex = season
            targetWeekIndex = Math.max(...seasonWeeks.map(w => w.weekIndex))
            console.log(`🏆 ✅ Using season ${targetSeasonIndex} data (${seasonWeeks.length} weeks, up to week ${targetWeekIndex})`)
            foundPrevSeason = true
            break
          }
        }
      }

      if (!foundPrevSeason) {
        console.log(`⚠️ No previous season data found, using current season`)
        // Keep current season, but get all available weeks
        targetWeekIndex = currentSeasonWeeks.length > 0 ? Math.max(...currentSeasonWeeks.map(w => w.weekIndex)) : 0
      }
    }

    // Build team game data using standings (which have accurate totals)
    const teamGameDataList: TeamGameData[] = []
    console.log(`🏆 Using standings data for ${standings.length} teams`)

    for (const standing of standings) {
      // Defensive null checks for win/loss/tie data
      const wins = standing.totalWins ?? 0
      const losses = standing.totalLosses ?? 0
      const ties = standing.totalTies ?? 0
      const gamesPlayed = wins + losses + ties

      // Use standings point totals directly
      const pointsFor = standing.ptsFor || 0
      const pointsAgainst = standing.ptsAgainst || 0

      // Estimate yards based on points (roughly 30 yards per point)
      const totalOffYards = pointsFor * 30
      const totalOffPlays = gamesPlayed * 60  // ~60 plays per game
      const totalDefYardsAllowed = pointsAgainst * 30
      const totalDefPlaysFaced = gamesPlayed * 60

      // Estimate turnovers (average teams: ~1 per game each way)
      const takeaways = gamesPlayed
      const giveaways = gamesPlayed

      // Build simple opponent list (we'll need to get their schedule)
      const opponentTeamIds: number[] = []

      teamGameDataList.push({
        teamId: standing.teamId,
        gamesPlayed,
        wins,
        losses,
        ties,
        pointsFor,
        pointsAgainst,
        totalOffYards,
        totalOffPlays,
        totalDefYardsAllowed,
        totalDefPlaysFaced,
        takeaways,
        giveaways,
        opponentTeamIds
      })
    }

    console.log(`🏆 Calculating power scores for ${teamGameDataList.length} teams`)

    // Calculate power rankings
    const powerRankings = calculatePowerRankings(teamGameDataList)

    // Parse range
    const [rangeStart, rangeEnd] = range.split('-').map(n => parseInt(n))
    const showNarratives = rangeStart === 1 // Only show AI narratives for top 6

    console.log(`🏆 Generating power rankings for teams ${rangeStart}-${rangeEnd}`)

    // Check if playoffs exist to determine if season is complete
    const playoffSchedule = await MaddenDB.getPlayoffSchedule(league)
    const superBowlGame = playoffSchedule.find((g: any) => g.seasonIndex === targetSeasonIndex && g.weekIndex === 22)
    const isSeasonComplete = superBowlGame && superBowlGame.homeScore !== null && superBowlGame.awayScore !== null
    const superBowlWinner = isSeasonComplete && superBowlGame
      ? (superBowlGame.homeScore > superBowlGame.awayScore
          ? getTeamOrThrow(teams, superBowlGame.homeTeamId)
          : getTeamOrThrow(teams, superBowlGame.awayTeamId))
      : null

    // Build display data and generate AI narratives
    const displaySeason = targetSeasonIndex !== currentSeasonIndex ? `${MADDEN_SEASON + targetSeasonIndex} (Final)` : `${MADDEN_SEASON + currentSeasonIndex}`
    let message = `# 🏆 NEL POWER RANKINGS\n`
    message += `## Season ${displaySeason}`
    if (isSeasonComplete && superBowlWinner) {
      message += ` • 🏆 ${superBowlWinner.displayName} Champions`
    }
    message += `\n\n`

    // Sort all teams by offense and defense once
    const sortedByOffense = [...teamGameDataList].sort((a, b) => b.pointsFor - a.pointsFor)
    const sortedByDefense = [...teamGameDataList].sort((a, b) => a.pointsAgainst - b.pointsAgainst)

    // Add league leaders section with better context (only for first page)
    if (rangeStart === 1 && sortedByOffense.length > 0 && sortedByDefense.length > 0) {
      message += `### 📊 Season Stats Leaders\n`
      message += `Most Points: ${getTeamOrThrow(teams, sortedByOffense[0].teamId).displayName} (${sortedByOffense[0].pointsFor} PF) • `
      message += `Best Defense: ${getTeamOrThrow(teams, sortedByDefense[0].teamId).displayName} (${sortedByDefense[0].pointsAgainst} PA)\n\n`
    }

    const startIdx = rangeStart - 1
    const endIdx = Math.min(rangeEnd, powerRankings.length)

    // Show teams in selected range
    for (let i = startIdx; i < endIdx; i++) {
      const ranking = powerRankings[i]
      const gameData = teamGameDataList.find(t => t.teamId === ranking.teamId)
      const standing = standings.find(s => s.teamId === ranking.teamId)

      if (!gameData || !standing) {
        console.warn(`Missing data for team ${ranking.teamId}, skipping`);
        continue;
      }

      const teamInfo = getTeamOrThrow(teams, ranking.teamId)
      const teamEmoji = formatTeamEmoji(logos, teamInfo.abbrName)

      // Get upcoming opponents (for current/target season)
      const schedule = await MaddenDB.getTeamSchedule(league, targetSeasonIndex)
      const teamSchedule = schedule.filter((g: any) =>
        g.homeTeamId === ranking.teamId || g.awayTeamId === ranking.teamId
      )
      const upcomingGames = teamSchedule
        .filter((g: any) => g.seasonIndex === targetSeasonIndex && g.weekIndex > targetWeekIndex && g.weekType === 'reg')
        .slice(0, 3)

      const upcomingOpponents = upcomingGames.map((game: any) => {
        const oppId = game.homeTeamId === ranking.teamId ? game.awayTeamId : game.homeTeamId
        const oppTeam = teams.getTeamForId(oppId)
        return oppTeam ? oppTeam.abbrName : 'TBD'
      })

      const offensiveRank = sortedByOffense.findIndex(t => t.teamId === ranking.teamId) + 1
      const defensiveRank = sortedByDefense.findIndex(t => t.teamId === ranking.teamId) + 1
      const diff = gameData.pointsFor - gameData.pointsAgainst
      const diffStr = diff > 0 ? `+${diff}` : `${diff}`
      const record = `${gameData.wins}-${gameData.losses}${gameData.ties > 0 ? `-${gameData.ties}` : ''}`

      // Rank badge with medal emojis for top 3
      const rankBadge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${ranking.rank}.**`

      if (showNarratives) {
        // Top 6: Full treatment with AI narratives
        const upcomingGames = teamSchedule
          .filter((g: any) => g.seasonIndex === targetSeasonIndex && g.weekIndex > targetWeekIndex && g.weekType === 'reg')
          .slice(0, 3)

        const upcomingOpponents = upcomingGames.map((game: any) => {
          const oppId = game.homeTeamId === ranking.teamId ? game.awayTeamId : game.homeTeamId
          const oppTeam = teams.getTeamForId(oppId)
          return oppTeam ? oppTeam.abbrName : 'TBD'
        })

        const aiData: TeamPowerRankingData = {
          rank: ranking.rank,
          teamName: teamInfo.displayName,
          teamAbbr: teamInfo.abbrName,
          record,
          wins: gameData.wins,
          losses: gameData.losses,
          ties: gameData.ties,
          previousRank: ranking.rank,
          offensiveRank,
          defensiveRank,
          pointsScored: gameData.pointsFor,
          pointsAllowed: gameData.pointsAgainst,
          pointDifferential: diff,
          totalYards: gameData.totalOffYards,
          defensiveYards: gameData.totalDefYardsAllowed,
          upcomingOpponents
        }

        try {
          const narrative = await generatePowerRankingNarrative(aiData)
          message += `${rankBadge} ${teamEmoji} **${teamInfo.displayName}** (${record})\n`
          message += `Score: ${ranking.powerScore} • Off Rank: #${offensiveRank} • Def Rank: #${defensiveRank}\n`
          message += `Points: ${gameData.pointsFor} PF / ${gameData.pointsAgainst} PA (${diffStr} diff)\n`
          message += `*${narrative}*\n\n`
        } catch (e) {
          console.error(`Failed to generate narrative for ${teamInfo.displayName}:`, e)
          message += `${rankBadge} ${teamEmoji} **${teamInfo.displayName}** (${record})\n`
          message += `Score: ${ranking.powerScore} • Off Rank: #${offensiveRank} • Def Rank: #${defensiveRank}\n`
          message += `Points: ${gameData.pointsFor} PF / ${gameData.pointsAgainst} PA (${diffStr} diff)\n\n`
        }

        // Update progress
        if ((i + 1) % 3 === 0) {
          console.log(`🏆 Generated ${i + 1}/${endIdx} narratives`)
        }
      } else {
        // Teams 7+: Condensed format
        message += `${rankBadge} ${teamEmoji} **${teamInfo.displayName}** (${record}) • ${ranking.powerScore} • Off: #${offensiveRank} • Def: #${defensiveRank} • ${diffStr}\n`
      }
    }

    message += `\n💡 Power Score: Weighted metric based on efficiency, win quality, margin of victory, turnover differential, and strength of schedule`

    // Build dropdown options for team ranges
    const rangeOptions = [
      { label: "🏆 Top 6 (Detailed)", value: "1-6", description: "Top 6 teams with AI narratives" },
      { label: "7-12", value: "7-12", description: "Teams ranked 7-12" },
      { label: "13-18", value: "13-18", description: "Teams ranked 13-18" },
      { label: "19-24", value: "19-24", description: "Teams ranked 19-24" },
      { label: "25-32", value: "25-32", description: "Teams ranked 25-32" }
    ]

    const components = [
      {
        type: ComponentType.TextDisplay,
        content: message
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "powerrankings_range",
            placeholder: rangeOptions.find(opt => opt.value === range)?.label || "🏆 Top 6 (Detailed)",
            options: rangeOptions
          }
        ]
      }
    ]

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components
    })

    console.log(`✅ Power rankings generation complete`)

  } catch (e) {
    console.error("❌ Error in generatePowerRankings:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate power rankings: ${e}`
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

    respond(ctx, deferMessage())
    generatePowerRankings(command.token, client, league)
  },
  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    const data = interaction.data as APIMessageStringSelectInteractionData
    if (data.values.length !== 1) {
      throw new Error("Did not receive exactly one selection from power rankings selector")
    }

    const selectedRange = data.values[0] as RankingRange

    // Get league from interaction (we'll need to fetch it from settings using guild_id)
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(interaction.guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league")
    }
    const league = leagueSettings.commands.madden_league.league_id

    // Fire off generation WITHOUT awaiting - return deferred response immediately
    // so Discord doesn't timeout waiting for our response
    generatePowerRankings(interaction.token, client, league, selectedRange)

    return {
      type: InteractionResponseType.DeferredMessageUpdate
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "powerrankings",
      description: "View NEL power rankings for the league",
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler & MessageComponentHandler
