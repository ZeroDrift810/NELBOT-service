import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, createMessageResponse } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, ApplicationCommandOptionType, ChannelType } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB from "../../db/madden_db"
import LeagueSettingsDB, { DiscordIdType, ChannelId, RoleId } from "../settings_db"
import { MADDEN_SEASON } from "../../export/madden_league_types"
import PickemDB from "../pickem_db"

type PostTarget = {
  type: "interaction"
  token: string
} | {
  type: "channel"
  channelId: string
  roleId?: string
  token: string
}

async function showLeaderboard(
  client: DiscordClient,
  league: string,
  guildId: string,
  target: PostTarget,
  seasonNumber?: number
) {
  try {
    console.log(`🏆 showLeaderboard called: league=${league}, season=${seasonNumber}`)

    if (target.type === "interaction") {
      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "# 🏆 NEL PICK'EM LEADERBOARD\n\n⏳ Loading season standings..."
          }
        ]
      })
    }

    const weeks = await MaddenDB.getAllWeeks(league)

    if (weeks.length === 0) {
      throw new Error("No season data available")
    }

    const currentSeasonIndex = weeks[0].seasonIndex

    const targetSeason = seasonNumber !== undefined ? seasonNumber - MADDEN_SEASON : currentSeasonIndex

    console.log(`🏆 Loading leaderboard for Season ${MADDEN_SEASON + targetSeason}`)

    // Get leaderboard
    const leaderboard = await PickemDB.getSeasonLeaderboard(guildId, league, targetSeason)

    if (leaderboard.length === 0) {
      const emptyMessage = `# 🏆 NEL PICK'EM LEADERBOARD\n## Season ${MADDEN_SEASON + targetSeason}\n\n⚠️ No picks have been made yet this season.`

      if (target.type === "channel") {
        const channelIdObj = { id: target.channelId, id_type: DiscordIdType.CHANNEL as const }
        await client.createMessageWithComponents(channelIdObj, {
          flags: 32768,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: emptyMessage
            }
          ]
        })
        await client.editOriginalInteraction(target.token, {
          flags: 32768,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: `✅ Leaderboard posted to <#${target.channelId}>!`
            }
          ]
        })
      } else {
        await client.editOriginalInteraction(target.token, {
          flags: 32768,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: emptyMessage
            }
          ]
        })
      }
      return
    }

    // Build leaderboard message
    let message = `# 🏆 NEL PICK'EM LEADERBOARD\n`
    message += `## Season ${MADDEN_SEASON + targetSeason}\n\n`

    // Display top users
    for (let i = 0; i < Math.min(leaderboard.length, 15); i++) {
      const user = leaderboard[i]
      const rank = i + 1

      // Rank emoji
      let rankEmoji = `${rank}.`
      if (rank === 1) rankEmoji = '🥇'
      if (rank === 2) rankEmoji = '🥈'
      if (rank === 3) rankEmoji = '🥉'

      // Accuracy indicator
      let accuracyEmoji = '🟢' // High accuracy (70%+)
      if (user.accuracy < 70) accuracyEmoji = '🟡' // Medium (60-69%)
      if (user.accuracy < 60) accuracyEmoji = '🔴' // Low (<60%)

      message += `${rankEmoji} **${user.userName}**\n`
      message += `${accuracyEmoji} ${user.correctPicks}/${user.totalPicks} correct (${user.accuracy.toFixed(1)}%)\n`

      // Show weekly breakdown
      const weekNumbers = Object.keys(user.weeklyResults || {}).map(w => parseInt(w)).sort((a, b) => a - b)
      if (weekNumbers.length > 0) {
        const recentWeeks = weekNumbers.slice(-3) // Show last 3 weeks
        const weekSummary = recentWeeks.map(w => {
          const weekData = user.weeklyResults[w]
          const weekEmoji = weekData.accuracy >= 70 ? '✅' : weekData.accuracy >= 50 ? '➖' : '❌'
          return `W${w + 1}: ${weekData.correct}/${weekData.picks} ${weekEmoji}`
        }).join(' • ')
        message += `${weekSummary}\n`
      }
      message += `\n`
    }

    if (leaderboard.length > 15) {
      message += `*...and ${leaderboard.length - 15} more users*\n\n`
    }

    message += `───────────────────────\n`
    message += `🟢 High Accuracy (70%+) • 🟡 Medium (60-69%) • 🔴 Low (<60%)\n`
    message += `\n💡 Keep making picks each week to climb the leaderboard!`

    if (target.type === "channel") {
      // Post to configured channel
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

      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `✅ Leaderboard posted to <#${target.channelId}>!`
          }
        ]
      })
    } else {
      await client.editOriginalInteraction(target.token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: message
          }
        ]
      })
    }

    console.log(`✅ Leaderboard shown for ${leaderboard.length} users`)

  } catch (e) {
    console.error("❌ Error in showLeaderboard:", e)
    await client.editOriginalInteraction(target.token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to load leaderboard: ${e}`
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
        respond(ctx, createMessageResponse("Please provide a channel to post pick'em leaderboards to."))
        return
      }

      const channelId: ChannelId = { id: channelOption.value, id_type: DiscordIdType.CHANNEL }
      const roleId: RoleId | undefined = roleOption ? { id: roleOption.value, id_type: DiscordIdType.ROLE } : undefined

      // Only include role if it's defined (Firestore doesn't allow undefined values)
      const pickemConfig: any = { channel: channelId }
      if (roleId) {
        pickemConfig.role = roleId
      }

      await LeagueSettingsDB.configurePickem(guild_id, pickemConfig)

      const roleText = roleId ? ` and will ping <@&${roleId.id}>` : ""
      respond(ctx, createMessageResponse(`✅ Pick'em configured! Will post to <#${channelId.id}>${roleText} when you use \`/pickem_leaderboard post\`.`))
      return
    }

    if (subcommand?.name === "post") {
      // Post to configured channel
      const config = leagueSettings.commands.pickem
      if (!config?.channel) {
        respond(ctx, createMessageResponse("❌ No channel configured. Use `/pickem_leaderboard configure` first to set a channel."))
        return
      }

      const seasonOption = (subcommand as any).options?.find((o: any) => o.name === "season")
      const seasonNumber = seasonOption ? seasonOption.value : undefined

      respond(ctx, deferMessage())
      showLeaderboard(client, league, guild_id, {
        type: "channel",
        channelId: config.channel.id,
        roleId: config.role?.id,
        token: command.token
      }, seasonNumber)
      return
    }

    // Default or "view" subcommand: view leaderboard (ephemeral to user)
    const seasonOption = subcommand?.name === "view"
      ? (subcommand as any).options?.find((o: any) => o.name === "season")
      : data.options?.find((o: any) => o.name === "season")
    const seasonNumber = seasonOption ? seasonOption.value : undefined

    respond(ctx, deferMessage())
    showLeaderboard(client, league, guild_id, {
      type: "interaction",
      token: command.token
    }, seasonNumber)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "pickem_leaderboard",
      description: "View the pick'em leaderboard",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: "configure",
          description: "Configure the channel and role to ping for pick'em leaderboards",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "channel",
              description: "The channel to post leaderboards to",
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
          description: "Post leaderboard to the configured channel",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "season",
              description: "Season year (defaults to current season)",
              required: false,
              min_value: MADDEN_SEASON,
              max_value: MADDEN_SEASON + 10
            }
          ]
        },
        {
          name: "view",
          description: "View leaderboard (only visible to you)",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "season",
              description: "Season year (defaults to current season)",
              required: false,
              min_value: MADDEN_SEASON,
              max_value: MADDEN_SEASON + 10
            }
          ]
        }
      ]
    }
  }
} as CommandHandler
