import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentHandler, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, getTeamOrThrow, createMessageResponse } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, APIMessageStringSelectInteractionData, SeparatorSpacingSize, InteractionResponseType, ApplicationCommandOptionType, ChannelType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB, { DiscordIdType, ChannelId, RoleId } from "../settings_db"
import { leagueLogosView } from "../../db/view"
import { MADDEN_SEASON, Player } from "../../export/madden_league_types"
import { generateRosterRankingNarrative, TeamRosterRankingData, isAnthropicConfigured } from "../../ai/anthropic_client"
import { calculateRosterRankings, TeamRosterData } from "./rosterrankings_engine"

type RankingRange = "1-6" | "7-12" | "13-18" | "19-24" | "25-32"

type PostTarget = {
  type: "interaction"
  token: string
} | {
  type: "channel"
  channelId: string
  roleId?: string
  token: string  // Still need token to update the original interaction
}

async function generateRosterRankings(client: DiscordClient, league: string, target: PostTarget, range: RankingRange = "1-6") {
  try {
    console.log(`📊 generateRosterRankings called: league=${league}`)

    if (!isAnthropicConfigured()) {
      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# ⚠️ Anthropic API Not Configured\n\nTo use AI-generated roster rankings, you need to add your Anthropic API key to the .env file:\n\n1. Add this line to your .env file:\n   `ANTHROPIC_API_KEY=your-api-key-here`\n2. Restart the bot\n3. Run this command again\n\nGet your API key at: https://console.anthropic.com/"
          }
        ]
      })
      return
    }

    // Show loading message
    if (target.type === "interaction") {
      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# NEL Roster Rankings\n\n⏳ Analyzing team rosters... This may take a moment."
          }
        ]
      })
    }
    // For channel post, we don't show loading - just process and confirm at end

    const [teams, logos, weeks, allPlayers] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league),
      MaddenDB.getLatestPlayers(league)
    ])

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0
    const displaySeason = `${MADDEN_SEASON + currentSeasonIndex}`

    console.log(`📊 Processing teams for roster rankings`)

    // Group players by team
    const playersByTeam = new Map<number, Player[]>()
    for (const player of allPlayers) {
      if (player.teamId === 0) continue // Skip free agents
      if (!playersByTeam.has(player.teamId)) {
        playersByTeam.set(player.teamId, [])
      }
      playersByTeam.get(player.teamId)!.push(player)
    }

    // Build team roster data
    const teamRosterData: TeamRosterData[] = []
    for (const [teamId, players] of playersByTeam) {
      try {
        const team = teams.getTeamForId(teamId)
        teamRosterData.push({
          teamId,
          teamName: team.displayName,
          players
        })
      } catch (e) {
        // Team not found, skip
      }
    }

    console.log(`📊 Calculating roster scores for ${teamRosterData.length} teams`)

    // Calculate roster rankings
    const rosterRankings = calculateRosterRankings(teamRosterData)

    // Parse range - for channel posts, show top 16 teams (condensed) to fit Discord's 4000 char limit
    const isChannelPost = target.type === "channel"
    const [rangeStart, rangeEnd] = isChannelPost ? [1, 16] : range.split('-').map(n => parseInt(n))
    const showNarratives = rangeStart === 1 && !isChannelPost // Only show AI narratives for top 6 in interactive mode

    console.log(`📊 Generating roster rankings for teams ${rangeStart}-${rangeEnd}${isChannelPost ? ' (channel post)' : ''}`)

    // Find league-wide stats for header
    const highestRosterOvr = rosterRankings.length > 0 ? rosterRankings[0] : null
    const mostXFactors = [...rosterRankings].sort((a, b) => b.xFactorCount - a.xFactorCount)[0]
    const mostElite = [...rosterRankings].sort((a, b) => b.eliteCount - a.eliteCount)[0]

    // Build display
    let message = `# 📊 NEL ROSTER POWER RANKINGS\n`
    message += `## Season ${displaySeason} - Preseason\n\n`

    // Add league leaders section (only for first page)
    if (rangeStart === 1 && highestRosterOvr && mostXFactors) {
      message += `### 🏆 League Overview\n`
      message += `Highest Rated: ${highestRosterOvr.teamName} (${highestRosterOvr.starterOvr} Starter OVR) • `
      message += `Most X-Factors: ${mostXFactors.teamName} (${mostXFactors.xFactorCount})\n\n`
    }

    const startIdx = rangeStart - 1
    const endIdx = Math.min(rangeEnd, rosterRankings.length)

    // Show teams in selected range
    for (let i = startIdx; i < endIdx; i++) {
      const ranking = rosterRankings[i]
      const teamInfo = getTeamOrThrow(teams, ranking.teamId)
      const teamEmoji = formatTeamEmoji(logos, teamInfo.abbrName)

      // Rank badge with medal emojis for top 3
      const rankBadge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${ranking.rank}.**`

      // Show narratives for top 6 only
      const showNarrativeForThisTeam = showNarratives && i < 6

      if (showNarrativeForThisTeam) {
        // Top 6: Full treatment with AI narratives
        const aiData: TeamRosterRankingData = {
          rank: ranking.rank,
          teamName: ranking.teamName,
          rosterScore: ranking.rosterScore,
          avgOvr: ranking.avgOvr,
          starterOvr: ranking.starterOvr,
          eliteCount: ranking.eliteCount,
          superEliteCount: ranking.superEliteCount,
          xFactorCount: ranking.xFactorCount,
          superstarCount: ranking.superstarCount,
          strongestGroup: ranking.strongestGroup,
          weakestGroup: ranking.weakestGroup,
          topPlayerNames: ranking.topPlayers.map(p => `${p.firstName} ${p.lastName}`)
        }

        try {
          const narrative = await generateRosterRankingNarrative(aiData)
          message += `${rankBadge} ${teamEmoji} **${ranking.teamName}**\n`
          message += `Score: ${ranking.rosterScore} • Starters: ${ranking.starterOvr} OVR • Elite: ${ranking.eliteCount} (90+: ${ranking.superEliteCount})\n`
          message += `X-Factors: ${ranking.xFactorCount} • Superstars: ${ranking.superstarCount} • Strong: ${ranking.strongestGroup} • Weak: ${ranking.weakestGroup}\n`
          message += `*${narrative}*\n\n`
        } catch (e) {
          console.error(`Failed to generate narrative for ${ranking.teamName}:`, e)
          message += `${rankBadge} ${teamEmoji} **${ranking.teamName}**\n`
          message += `Score: ${ranking.rosterScore} • Starters: ${ranking.starterOvr} OVR • Elite: ${ranking.eliteCount} (90+: ${ranking.superEliteCount})\n`
          message += `X-Factors: ${ranking.xFactorCount} • Superstars: ${ranking.superstarCount} • Strong: ${ranking.strongestGroup} • Weak: ${ranking.weakestGroup}\n\n`
        }

        // Update progress
        if ((i + 1) % 3 === 0 && i < 6) {
          console.log(`📊 Generated ${i + 1}/6 narratives`)
        }
      } else {
        // Teams 7+: Condensed format
        message += `${rankBadge} ${teamEmoji} **${ranking.teamName}** • ${ranking.rosterScore} • ${ranking.starterOvr} OVR • Elite: ${ranking.eliteCount} • XF: ${ranking.xFactorCount}\n`
      }
    }

    message += `\n💡 Roster Score: Weighted metric based on starter OVR, elite player count, X-Factors, depth, and position balance`

    // Add note for channel posts about viewing full rankings
    if (isChannelPost && rosterRankings.length > 16) {
      message += `\n\n📋 *Showing top 16 teams. Use \`/rosterrankings view\` to see all ${rosterRankings.length} teams with detailed analysis.*`
    }

    // Build dropdown options for team ranges
    const rangeOptions = [
      { label: "📊 Top 6 (Detailed)", value: "1-6", description: "Top 6 rosters with AI analysis" },
      { label: "7-12", value: "7-12", description: "Teams ranked 7-12" },
      { label: "13-18", value: "13-18", description: "Teams ranked 13-18" },
      { label: "19-24", value: "19-24", description: "Teams ranked 19-24" },
      { label: "25-32", value: "25-32", description: "Teams ranked 25-32" }
    ]

    if (target.type === "channel") {
      // Post to configured channel - condensed format (top 16 teams) to fit Discord's 4000 char limit
      const rolePing = target.roleId ? `<@&${target.roleId}>\n\n` : ""
      const channelIdObj = { id: target.channelId, id_type: DiscordIdType.CHANNEL as const }

      await client.createMessageWithComponents(channelIdObj, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: rolePing + message
          }
        ],
        allowed_mentions: target.roleId ? { roles: [target.roleId] } : { parse: [] }
      })

      // Update original interaction to confirm
      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `✅ Roster rankings posted to <#${target.channelId}>!`
          }
        ]
      })
    } else {
      // Post to interaction (ephemeral)
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
              custom_id: "rosterrankings_range",
              placeholder: rangeOptions.find(opt => opt.value === range)?.label || "📊 Top 6 (Detailed)",
              options: rangeOptions
            }
          ]
        }
      ]

      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components
      })
    }

    console.log(`✅ Roster rankings generation complete`)

  } catch (e) {
    console.error("❌ Error in generateRosterRankings:", e)
    await client.editOriginalInteraction(target.token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate roster rankings: ${e}`
        }
      ]
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, data } = command

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    // Check for subcommand
    const subcommand = data.options?.[0]

    if (subcommand?.name === "configure") {
      // Configure channel and role
      const options = (subcommand as any).options || []
      const channelOption = options.find((o: any) => o.name === "channel")
      const roleOption = options.find((o: any) => o.name === "role")

      if (!channelOption) {
        respond(ctx, createMessageResponse("Please provide a channel to post roster rankings to."))
        return
      }

      const channelId: ChannelId = { id: channelOption.value, id_type: DiscordIdType.CHANNEL }
      const roleId: RoleId | undefined = roleOption ? { id: roleOption.value, id_type: DiscordIdType.ROLE } : undefined

      await LeagueSettingsDB.configureRosterRankings(guild_id, {
        channel: channelId,
        role: roleId
      })

      const roleText = roleId ? ` and will ping <@&${roleId.id}>` : ""
      respond(ctx, createMessageResponse(`✅ Roster rankings configured! Will post to <#${channelId.id}>${roleText} when you use \`/rosterrankings post\`.`))
      return
    }

    if (subcommand?.name === "post") {
      // Post to configured channel
      const config = leagueSettings.commands.rosterrankings
      if (!config?.channel) {
        respond(ctx, createMessageResponse("❌ No channel configured. Use `/rosterrankings configure` first to set a channel."))
        return
      }

      respond(ctx, deferMessage())
      generateRosterRankings(client, league, {
        type: "channel",
        channelId: config.channel.id,
        roleId: config.role?.id,
        token: command.token
      })
      return
    }

    // Default: view rankings (ephemeral to user)
    respond(ctx, deferMessage())
    generateRosterRankings(client, league, {
      type: "interaction",
      token: command.token
    })
  },
  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    const data = interaction.data as APIMessageStringSelectInteractionData
    if (data.values.length !== 1) {
      throw new Error("Did not receive exactly one selection from roster rankings selector")
    }

    const selectedRange = data.values[0] as RankingRange

    // Get league from interaction
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(interaction.guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league")
    }
    const league = leagueSettings.commands.madden_league.league_id

    // Fire off generation WITHOUT awaiting
    generateRosterRankings(client, league, {
      type: "interaction",
      token: interaction.token
    }, selectedRange)

    return {
      type: InteractionResponseType.DeferredMessageUpdate
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "rosterrankings",
      description: "View NEL roster power rankings based on team roster strength",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: "configure",
          description: "Configure the channel and role to ping for roster rankings",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "channel",
              description: "The channel to post roster rankings to",
              type: ApplicationCommandOptionType.Channel,
              channel_types: [ChannelType.GuildText],
              required: true
            },
            {
              name: "role",
              description: "The role to ping when posting (optional)",
              type: ApplicationCommandOptionType.Role,
              required: false
            }
          ]
        },
        {
          name: "post",
          description: "Post roster rankings to the configured channel",
          type: ApplicationCommandOptionType.Subcommand
        },
        {
          name: "view",
          description: "View roster rankings (only visible to you)",
          type: ApplicationCommandOptionType.Subcommand
        }
      ]
    }
  }
} as CommandHandler & MessageComponentHandler
