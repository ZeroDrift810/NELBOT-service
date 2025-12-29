import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentHandler, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, NoConnectedLeagueError, getDevTraitEmoji, SnallabotDevEmojis } from "../discord_utils"
import { APIApplicationCommandInteractionDataStringOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { MaddenEvents, PlayerStatType } from "../../db/madden_db"
import { discordLeagueView, leagueLogosView, LeagueLogos } from "../../db/view"
import db from "../../db/firebase"
import { Player, PassingStats, RushingStats, ReceivingStats, DefensiveStats, Standing, MADDEN_SEASON, Team } from "../../export/madden_league_types"
import { isAnthropicConfigured } from "../../ai/anthropic_client"
import Anthropic from "@anthropic-ai/sdk"

const OFF_SCHEMES: { [key: number]: string } = {
  0: "Spread", 1: "West Coast", 2: "Pro Style", 3: "Vertical",
  4: "Run Heavy", 5: "WC Zone Run", 6: "Multiple"
}

const DEF_SCHEMES: { [key: number]: string } = {
  0: "4-3", 1: "3-4", 2: "4-3 Over", 3: "4-3 Under",
  4: "3-4 Odd", 5: "3-4 Bear", 6: "4-3 Cover 3", 7: "Multiple"
}

const DEV_TRAITS: { [key: number]: string } = {
  0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor"
}

function fmt(n: number): string {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`
  return `$${n}`
}

function ord(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function getTeamLogoUrl(logos: LeagueLogos, teamAbbr: string): string | undefined {
  const logo = logos[teamAbbr]
  return logo?.teamLogoPath
}

async function generateTeamNarrative(team: Team, standing: Standing | undefined, players: Player[]): Promise<string | null> {
  if (!isAnthropicConfigured()) return null

  try {
    const client = new Anthropic()
    const xFactors = players.filter(p => p.devTrait === 3)
    const expiring = players.filter(p => p.contractYearsLeft === 1)
    const topPlayer = players.sort((a, b) => b.playerBestOvr - a.playerBestOvr)[0]

    const prompt = `Write a brief 2-sentence team outlook for the ${team.cityName} ${team.nickName} in a fictional Madden video game league.

Team Info:
- Overall: ${team.ovrRating}
- Offense: ${OFF_SCHEMES[team.offScheme] || 'Unknown'}, Defense: ${DEF_SCHEMES[team.defScheme] || 'Unknown'}
${standing ? `- Record: ${standing.totalWins}-${standing.totalLosses}, Rank: ${standing.rank}
- Points For: ${standing.ptsFor} (${ord(standing.ptsForRank)}), Points Against: ${standing.ptsAgainst} (${ord(standing.ptsAgainstRank)})
- Cap Room: ${fmt(standing.capRoom)}` : ''}
- X-Factors: ${xFactors.length}
- Expiring Contracts: ${expiring.length}
- Star Player: ${topPlayer?.firstName} ${topPlayer?.lastName} (${topPlayer?.position}, ${topPlayer?.playerBestOvr} OVR)

Write a brief, insightful outlook focusing on team identity and what to watch. Be concise (max 2 sentences).`

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }]
    })

    const textBlock = response.content.find(b => b.type === 'text')
    return textBlock ? (textBlock as any).text : null
  } catch (e) {
    console.error("Failed to generate team narrative:", e)
    return null
  }
}

async function getTeamPlayers(leagueId: string, teamId: number): Promise<Player[]> {
  const playerSnapshot = await db.collection("madden_data26").doc(leagueId)
    .collection(MaddenEvents.MADDEN_PLAYER)
    .where("teamId", "==", teamId)
    .get()

  const playerMap = new Map<string, Player>()
  for (const doc of playerSnapshot.docs) {
    const player = doc.data() as Player
    const key = `${player.presentationId}-${player.birthYear}-${player.birthMonth}-${player.birthDay}`
    const existing = playerMap.get(key)
    if (!existing || (player as any).timestamp > (existing as any).timestamp) {
      playerMap.set(key, player)
    }
  }
  return Array.from(playerMap.values())
}

async function generateTeamReport(token: string, client: DiscordClient, leagueId: string, teamAbbr: string) {
  try {
    const [teams, logos, standings] = await Promise.all([
      MaddenDB.getLatestTeams(leagueId),
      leagueLogosView.createView(leagueId),
      MaddenDB.getLatestStandings(leagueId)
    ])

    const team = teams.getLatestTeams().find(t =>
      t.abbrName?.toUpperCase() === teamAbbr.toUpperCase() ||
      t.nickName?.toUpperCase() === teamAbbr.toUpperCase()
    )

    if (!team) {
      await client.editOriginalInteraction(token, {
        content: `Team "${teamAbbr}" not found. Use team abbreviations like DAL, NE, KC, etc.`
      })
      return
    }

    // Show loading state
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `# Team Report\n\n⏳ Generating report for ${team.cityName} ${team.nickName}...`
      }]
    })

    const standing = standings.find(s => s.teamId === team.teamId)
    const teamPlayers = await getTeamPlayers(leagueId, team.teamId)
    const emoji = formatTeamEmoji(logos, team.abbrName)
    const logoUrl = getTeamLogoUrl(logos, team.abbrName)

    // Generate AI narrative
    const narrative = await generateTeamNarrative(team, standing, teamPlayers)

    // Build components array - using standard TextDisplay for reliability
    const components: any[] = []

    // Header
    const record = standing
      ? (standing.totalTies > 0
          ? `${standing.totalWins}-${standing.totalLosses}-${standing.totalTies}`
          : `${standing.totalWins}-${standing.totalLosses}`)
      : "N/A"

    const headerContent = `# ${emoji} ${team.cityName} ${team.nickName}\n` +
      `**${record}** | ${ord(standing?.rank || 0)} | OVR: ${team.ovrRating}\n` +
      `${OFF_SCHEMES[team.offScheme] || 'Unknown'} Offense • ${DEF_SCHEMES[team.defScheme] || 'Unknown'} Defense`

    components.push({
      type: ComponentType.TextDisplay,
      content: headerContent
    })

    // AI Narrative (if available)
    if (narrative) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `\n*${narrative}*`
      })
    }

    components.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    })

    // Stats section
    let statsMessage = ""
    if (standing) {
      statsMessage += `## 📊 Season ${MADDEN_SEASON + standing.seasonIndex}\n`

      const streak = standing.winLossStreak > 0 ? `W${standing.winLossStreak}` :
        standing.winLossStreak < 0 ? `L${Math.abs(standing.winLossStreak)}` : "None"
      statsMessage += `**Home:** ${standing.homeWins}-${standing.homeLosses} | **Away:** ${standing.awayWins}-${standing.awayLosses} | **Streak:** ${streak}\n`
      statsMessage += `**Div:** ${standing.divWins}-${standing.divLosses} | **Conf:** ${standing.confWins}-${standing.confLosses}\n\n`

      // Team Stats in compact format
      statsMessage += `## ⚔️ Team Stats\n`
      statsMessage += `\`\`\`\n`
      statsMessage += `OFFENSE                    DEFENSE\n`
      statsMessage += `Points: ${String(standing.ptsFor).padEnd(4)} (${ord(standing.ptsForRank).padEnd(4)})   Points: ${String(standing.ptsAgainst).padEnd(4)} (${ord(standing.ptsAgainstRank)})\n`
      statsMessage += `Total:  ${String(standing.offTotalYds).padEnd(4)} (${ord(standing.offTotalYdsRank).padEnd(4)})   Total:  ${String(standing.defTotalYds).padEnd(4)} (${ord(standing.defTotalYdsRank)})\n`
      statsMessage += `Pass:   ${String(standing.offPassYds).padEnd(4)} (${ord(standing.offPassYdsRank).padEnd(4)})   Pass:   ${String(standing.defPassYds).padEnd(4)} (${ord(standing.defPassYdsRank)})\n`
      statsMessage += `Rush:   ${String(standing.offRushYds).padEnd(4)} (${ord(standing.offRushYdsRank).padEnd(4)})   Rush:   ${String(standing.defRushYds).padEnd(4)} (${ord(standing.defRushYdsRank)})\n`
      statsMessage += `\`\`\`\n`

      const toDiff = standing.tODiff > 0 ? `+${standing.tODiff}` : `${standing.tODiff}`
      const netPts = standing.netPts > 0 ? `+${standing.netPts}` : `${standing.netPts}`
      statsMessage += `**TO Diff:** ${toDiff} | **Net Pts:** ${netPts} | **Cap Room:** ${fmt(standing.capRoom)}\n`
    }

    components.push({
      type: ComponentType.TextDisplay,
      content: statsMessage
    })

    components.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    })

    // Key Players section
    let playersMessage = `## 👥 Key Players\n`
    const posGroups = [
      { name: "QB", filter: (p: Player) => p.position === "QB" },
      { name: "RB", filter: (p: Player) => ["HB", "FB"].includes(p.position) },
      { name: "WR", filter: (p: Player) => p.position === "WR" },
      { name: "TE", filter: (p: Player) => p.position === "TE" },
      { name: "EDGE", filter: (p: Player) => ["LEDGE", "REDGE"].includes(p.position) },
      { name: "CB", filter: (p: Player) => p.position === "CB" },
    ]

    for (const { name, filter } of posGroups) {
      const players = teamPlayers.filter(filter).sort((a, b) => b.playerBestOvr - a.playerBestOvr)
      if (players.length > 0) {
        const top = players[0]
        const devEmoji = getDevTraitEmoji(top.devTrait)
        const contract = top.contractYearsLeft > 0 ? `${top.contractYearsLeft}yr` : "FA"
        playersMessage += `**${name}:** ${top.firstName} ${top.lastName} (${top.playerBestOvr}) ${devEmoji} - ${contract}\n`
      }
    }

    // X-Factors inline
    const xFactors = teamPlayers.filter(p => p.devTrait === 3).sort((a, b) => b.playerBestOvr - a.playerBestOvr)
    if (xFactors.length > 0) {
      playersMessage += `\n**${SnallabotDevEmojis.XFACTOR} X-Factors:** ${xFactors.map(p => `${p.firstName} ${p.lastName}`).join(", ")}\n`
    }

    // Expiring Contracts
    const expiring = teamPlayers.filter(p => p.contractYearsLeft === 1).sort((a, b) => b.playerBestOvr - a.playerBestOvr)
    if (expiring.length > 0) {
      playersMessage += `\n**⚠️ Expiring (${expiring.length}):** ${expiring.slice(0, 4).map(p => `${p.lastName} (${p.position})`).join(", ")}`
      if (expiring.length > 4) playersMessage += ` +${expiring.length - 4} more`
      playersMessage += `\n`
    }

    components.push({
      type: ComponentType.TextDisplay,
      content: playersMessage
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components
    })

  } catch (e) {
    console.error("Error generating team report:", e)
    await client.editOriginalInteraction(token, {
      content: `Failed to generate team report: ${e}`
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token } = command

    const options = command.data.options || []
    const teamOption = options.find(o => o.name === "team") as APIApplicationCommandInteractionDataStringOption | undefined

    if (!teamOption?.value) {
      respond(ctx, { type: 4, data: { content: "Please specify a team abbreviation (e.g., DAL, NE, KC)" } })
      return
    }

    const discordLeague = await discordLeagueView.createView(guild_id)
    if (!discordLeague) {
      throw new NoConnectedLeagueError(guild_id)
    }

    respond(ctx, deferMessage())
    generateTeamReport(token, client, discordLeague.leagueId, teamOption.value)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "teamreport",
      description: "Generate a comprehensive team report with roster, stats, and contracts",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "team",
          description: "Team abbreviation (e.g., DAL, NE, KC)",
          required: true
        }
      ]
    }
  }
} as CommandHandler
