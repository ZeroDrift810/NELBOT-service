import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { Player } from "../../export/madden_league_types"
import db from "../../db/firebase"

const MADDEN_PORTRAIT_CDN = "https://ratings-images-prod.pulse.ea.com/madden-nfl-26/portraits"

interface HistoryEntry {
  timestamp: FirebaseFirestore.Timestamp
  teamId?: { oldValue: number; newValue: number }
  isFreeAgent?: { oldValue: boolean; newValue: boolean }
}

type FASigning = Player & {
  fromTeam: string
  signingDate: Date
}

function getPlayerPortraitUrl(portraitId: number): string {
  return `${MADDEN_PORTRAIT_CDN}/${portraitId}.png`
}

function formatMoney(m: number): string {
  if (m >= 1000000) {
    return `$${(m / 1000000).toFixed(1)}M`
  } else if (m >= 1000) {
    return `$${(m / 1000).toFixed(0)}K`
  }
  return `$${m.toLocaleString()}`
}

function getDevEmoji(devTrait: number): string {
  switch (devTrait) {
    case 0: return '🔵'
    case 1: return '⭐'
    case 2: return '🌟'
    case 3: return '💫'
    default: return '🔵'
  }
}

async function generateFARecap(token: string, client: DiscordClient, leagueId: string, daysBack: number) {
  try {
    console.log(`📋 generateFARecap called: league=${leagueId}, daysBack=${daysBack}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# 📋 FREE AGENCY RECAP\n\n⏳ Analyzing recent signings..."
        }
      ]
    })

    const [teams, logos] = await Promise.all([
      MaddenDB.getLatestTeams(leagueId),
      leagueLogosView.createView(leagueId)
    ])

    // Get all players
    const playersSnap = await db.collection('madden_data26').doc(leagueId).collection('MADDEN_PLAYER').get()
    const players = playersSnap.docs.map(d => ({ doc: d, data: d.data() as Player }))

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysBack)

    // Find FA signings by checking history
    const faSignings: FASigning[] = []

    for (const { doc, data: player } of players) {
      if (player.isFreeAgent || player.teamId === 0) continue

      const historySnap = await doc.ref.collection('history').orderBy('timestamp', 'desc').limit(10).get()

      for (const histDoc of historySnap.docs) {
        const hist = histDoc.data() as HistoryEntry
        if (!hist.timestamp) continue

        const signingDate = hist.timestamp.toDate()
        if (signingDate < cutoffDate) continue

        // Check if signed from FA
        if (hist.teamId && hist.teamId.oldValue === 0 && hist.teamId.newValue !== 0) {
          faSignings.push({ ...player, fromTeam: 'FA', signingDate })
          break
        }
        if (hist.isFreeAgent && hist.isFreeAgent.oldValue === true && hist.isFreeAgent.newValue === false) {
          faSignings.push({ ...player, fromTeam: 'FA', signingDate })
          break
        }
      }
    }

    if (faSignings.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 📋 FREE AGENCY RECAP\n\n⚠️ No FA signings found in the last ${daysBack} day(s).\n\nMake sure to run \`/export all_weeks\` after FA completes to capture signings.`
          }
        ]
      })
      return
    }

    // Sort by OVR descending
    faSignings.sort((a, b) => b.playerBestOvr - a.playerBestOvr)

    // Group by team
    const byTeam: { [key: string]: FASigning[] } = {}
    faSignings.forEach(p => {
      const team = teams.getTeamForId(p.teamId)
      const teamName = team?.abbrName || 'Unknown'
      if (!byTeam[teamName]) byTeam[teamName] = []
      byTeam[teamName].push(p)
    })

    // Get top 5 signings for featured display
    const topSignings = faSignings.slice(0, 5)

    // Build components
    const components: any[] = [
      {
        type: ComponentType.TextDisplay,
        content: `# 📋 FREE AGENCY RECAP\n## ${faSignings.length} Signings | ${Object.keys(byTeam).length} Teams`
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small
      }
    ]

    // Add top signings with portraits
    for (const signing of topSignings) {
      const team = teams.getTeamForId(signing.teamId)
      const teamEmoji = formatTeamEmoji(logos, team?.abbrName || '')
      const totalValue = (signing.contractSalary * signing.contractLength) + signing.contractBonus

      components.push({
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `### ${getDevEmoji(signing.devTrait)} ${signing.position} ${signing.firstName} ${signing.lastName}\n${teamEmoji} **${signing.playerBestOvr} OVR** | Age ${signing.age}\n${signing.contractLength}yr / ${formatMoney(totalValue)}`
          }
        ],
        accessory: signing.portraitId ? {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(signing.portraitId)
          }
        } : undefined
      })
    }

    components.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    })

    // Build team-by-team summary
    let message = "### All Signings by Team\n"

    const sortedTeams = Object.keys(byTeam).sort()
    for (const teamAbbr of sortedTeams) {
      const teamSignings = byTeam[teamAbbr]
      const teamEmoji = formatTeamEmoji(logos, teamAbbr)

      // Sort by OVR
      teamSignings.sort((a, b) => b.playerBestOvr - a.playerBestOvr)

      const signingsList = teamSignings.map(p =>
        `${getDevEmoji(p.devTrait)}${p.position} ${p.lastName} (${p.playerBestOvr})`
      ).join(" • ")

      message += `${teamEmoji} **${teamAbbr}** (${teamSignings.length}): ${signingsList}\n`
    }

    // Calculate totals
    const totalValue = faSignings.reduce((sum, p) => sum + (p.contractSalary * p.contractLength) + p.contractBonus, 0)

    message += `\n───────────────────────\n`
    message += `**Total Contract Value:** ${formatMoney(totalValue)}`

    components.push({
      type: ComponentType.TextDisplay,
      content: message
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components
    })

  } catch (e) {
    console.error("❌ Error in generateFARecap:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate FA recap: ${e}`
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

    // Get days option if provided
    let daysBack = 7 // default
    if (command.data.options && command.data.options.length > 0) {
      const daysOption = command.data.options.find((opt: any) => opt.name === 'days')
      if (daysOption && 'value' in daysOption) {
        daysBack = daysOption.value as number
      }
    }

    respond(ctx, deferMessage())
    generateFARecap(command.token, client, league, daysBack)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "farecap",
      description: "View recent free agency signings",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "days",
          description: "Number of days to look back (default: 7)",
          required: false,
          min_value: 1,
          max_value: 60
        }
      ]
    }
  }
} as CommandHandler
