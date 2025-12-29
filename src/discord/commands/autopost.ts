import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, createMessageResponse } from "../discord_utils"
import {
  APIApplicationCommandInteractionDataChannelOption,
  APIApplicationCommandInteractionDataStringOption,
  APIApplicationCommandInteractionDataSubcommandOption,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  ComponentType,
  RESTPostAPIApplicationCommandsJSONBody
} from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { discordLeagueView } from "../../db/view"
import AutoPostDB, {
  AutoPostCommandType,
  CreateScheduledPost,
  DAY_NAMES,
  formatSchedule,
  parseDayOfWeek,
  parseTime
} from "../autopost_db"

// Add a new scheduled post
async function addScheduledPost(
  token: string,
  client: DiscordClient,
  guildId: string,
  leagueId: string,
  userId: string,
  commandType: AutoPostCommandType,
  channelId: string,
  day: string,
  time: string,
  options: { category?: string; range?: string }
) {
  try {
    // Parse day and time
    const dayOfWeek = parseDayOfWeek(day)
    const { hour, minute } = parseTime(time)

    // Create the scheduled post
    const post: CreateScheduledPost = {
      guildId,
      leagueId,
      channelId,
      commandType,
      schedule: { dayOfWeek, hour, minute },
      options: {
        category: options.category as any,
        range: options.range as any
      },
      enabled: true,
      createdBy: userId
    }

    const created = await AutoPostDB.createScheduledPost(post)

    const scheduleDisplay = formatSchedule(created.schedule)
    let message = `# Auto-Post Scheduled\n\n`
    message += `**Command:** \`${commandType}\`\n`
    message += `**Channel:** <#${channelId}>\n`
    message += `**Schedule:** ${scheduleDisplay}\n`
    if (options.category) message += `**Category:** ${options.category}\n`
    if (options.range) message += `**Range:** ${options.range}\n`
    message += `\n**ID:** \`${created.id}\`\n`
    message += `\n*Use \`/autopost list\` to see all scheduled posts*`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    const error = e as Error
    await client.editOriginalInteraction(token, {
      content: `Failed to create scheduled post: ${error.message}`
    })
  }
}

// List all scheduled posts for the guild
async function listScheduledPosts(token: string, client: DiscordClient, guildId: string) {
  try {
    const posts = await AutoPostDB.getScheduledPostsForGuild(guildId)

    if (posts.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{
          type: ComponentType.TextDisplay,
          content: `# Auto-Post Schedule\n\n*No scheduled posts configured.*\n\nUse \`/autopost add\` to create one.`
        }]
      })
      return
    }

    let message = `# Auto-Post Schedule\n\n`
    message += `**${posts.length} scheduled post${posts.length > 1 ? 's' : ''}**\n\n`

    posts.forEach((post, idx) => {
      const status = post.enabled ? '✅' : '❌'
      const scheduleDisplay = formatSchedule(post.schedule)

      message += `### ${idx + 1}. ${status} ${post.commandType}\n`
      message += `**Channel:** <#${post.channelId}>\n`
      message += `**Schedule:** ${scheduleDisplay}\n`
      if (post.options?.category) message += `**Category:** ${post.options.category}\n`
      if (post.options?.range) message += `**Range:** ${post.options.range}\n`
      if (post.lastRun) {
        const lastRunDate = new Date(post.lastRun)
        message += `**Last Run:** ${lastRunDate.toLocaleDateString()} ${lastRunDate.toLocaleTimeString()}\n`
      }
      if (post.lastError) message += `**Last Error:** ${post.lastError}\n`
      message += `**ID:** \`${post.id}\`\n\n`
    })

    message += `\n*Use \`/autopost remove <id>\` to remove a scheduled post*`

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
  } catch (e) {
    const error = e as Error
    await client.editOriginalInteraction(token, {
      content: `Failed to list scheduled posts: ${error.message}`
    })
  }
}

// Remove a scheduled post
async function removeScheduledPost(token: string, client: DiscordClient, guildId: string, postId: string) {
  try {
    // Verify the post belongs to this guild
    const post = await AutoPostDB.getScheduledPost(postId)
    if (!post) {
      await client.editOriginalInteraction(token, {
        content: `Scheduled post with ID \`${postId}\` not found.`
      })
      return
    }

    if (post.guildId !== guildId) {
      await client.editOriginalInteraction(token, {
        content: `That scheduled post doesn't belong to this server.`
      })
      return
    }

    await AutoPostDB.deleteScheduledPost(postId)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `# Auto-Post Removed\n\n**Command:** ${post.commandType}\n**Channel:** <#${post.channelId}>\n**Schedule:** ${formatSchedule(post.schedule)}\n\nThis post will no longer be auto-posted.`
      }]
    })
  } catch (e) {
    const error = e as Error
    await client.editOriginalInteraction(token, {
      content: `Failed to remove scheduled post: ${error.message}`
    })
  }
}

// Toggle a scheduled post on/off
async function toggleScheduledPost(token: string, client: DiscordClient, guildId: string, postId: string) {
  try {
    const post = await AutoPostDB.getScheduledPost(postId)
    if (!post) {
      await client.editOriginalInteraction(token, {
        content: `Scheduled post with ID \`${postId}\` not found.`
      })
      return
    }

    if (post.guildId !== guildId) {
      await client.editOriginalInteraction(token, {
        content: `That scheduled post doesn't belong to this server.`
      })
      return
    }

    const newEnabled = !post.enabled
    await AutoPostDB.updateScheduledPost(postId, { enabled: newEnabled })

    const status = newEnabled ? '✅ Enabled' : '❌ Disabled'
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: `# Auto-Post ${newEnabled ? 'Enabled' : 'Disabled'}\n\n**Command:** ${post.commandType}\n**Channel:** <#${post.channelId}>\n**Status:** ${status}`
      }]
    })
  } catch (e) {
    const error = e as Error
    await client.editOriginalInteraction(token, {
      content: `Failed to toggle scheduled post: ${error.message}`
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token, member } = command

    const discordLeague = await discordLeagueView.createView(guild_id)
    if (!discordLeague) {
      respond(ctx, createMessageResponse("No Madden league connected. Connect a league first using the dashboard."))
      return
    }

    respond(ctx, deferMessage())

    const options = command.data.options || []
    if (options.length === 0) {
      await client.editOriginalInteraction(token, {
        content: "Please specify a subcommand: add, list, remove, or toggle"
      })
      return
    }

    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    switch (subCommand.name) {
      case 'add': {
        const subOptions = subCommand.options || []
        const commandType = (subOptions.find(o => o.name === 'command') as APIApplicationCommandInteractionDataStringOption)?.value as AutoPostCommandType
        const channelOption = subOptions.find(o => o.name === 'channel') as APIApplicationCommandInteractionDataChannelOption
        const day = (subOptions.find(o => o.name === 'day') as APIApplicationCommandInteractionDataStringOption)?.value
        const time = (subOptions.find(o => o.name === 'time') as APIApplicationCommandInteractionDataStringOption)?.value
        const category = (subOptions.find(o => o.name === 'category') as APIApplicationCommandInteractionDataStringOption)?.value
        const range = (subOptions.find(o => o.name === 'range') as APIApplicationCommandInteractionDataStringOption)?.value

        if (!commandType || !channelOption || !day || !time) {
          await client.editOriginalInteraction(token, {
            content: "Missing required options. Usage: /autopost add command:<type> channel:<#channel> day:<day> time:<HH:MM>"
          })
          return
        }

        await addScheduledPost(
          token,
          client,
          guild_id,
          discordLeague.leagueId,
          member.user.id,
          commandType,
          channelOption.value,
          day,
          time,
          { category, range }
        )
        break
      }

      case 'list': {
        await listScheduledPosts(token, client, guild_id)
        break
      }

      case 'remove': {
        const subOptions = subCommand.options || []
        const postId = (subOptions.find(o => o.name === 'id') as APIApplicationCommandInteractionDataStringOption)?.value

        if (!postId) {
          await client.editOriginalInteraction(token, {
            content: "Please specify the ID of the scheduled post to remove. Use /autopost list to see IDs."
          })
          return
        }

        await removeScheduledPost(token, client, guild_id, postId)
        break
      }

      case 'toggle': {
        const subOptions = subCommand.options || []
        const postId = (subOptions.find(o => o.name === 'id') as APIApplicationCommandInteractionDataStringOption)?.value

        if (!postId) {
          await client.editOriginalInteraction(token, {
            content: "Please specify the ID of the scheduled post to toggle. Use /autopost list to see IDs."
          })
          return
        }

        await toggleScheduledPost(token, client, guild_id, postId)
        break
      }

      default:
        await client.editOriginalInteraction(token, {
          content: `Unknown subcommand: ${subCommand.name}`
        })
    }
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "autopost",
      description: "Configure automatic posting of stats and rankings",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "add",
          description: "Add a new scheduled auto-post",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "command",
              description: "Which command to auto-post",
              required: true,
              choices: [
                { name: "Power Rankings", value: "powerrankings" },
                { name: "Player Rankings", value: "playerrankings" },
                { name: "Stat Leaders", value: "leaders" },
                { name: "Standings", value: "standings" },
                { name: "Team Stats", value: "teamstats" },
                { name: "Weekly Schedule", value: "schedule" },
                { name: "Predictions (AI)", value: "predictions" },
                { name: "Game of the Week (AI)", value: "gotw" },
                { name: "Pick'em Leaderboard", value: "pickem_leaderboard" },
                { name: "Playoffs Bracket", value: "playoffs" },
                { name: "Awards", value: "awards" },
                { name: "FA Recap", value: "farecap" }
              ]
            },
            {
              type: ApplicationCommandOptionType.Channel,
              name: "channel",
              description: "Channel to post in",
              required: true,
              channel_types: [ChannelType.GuildText]
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "day",
              description: "Day of week (Sunday-Saturday)",
              required: true,
              choices: DAY_NAMES.map((d, i) => ({ name: d, value: d }))
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "time",
              description: "Time to post (HH:MM in ET, e.g., 9:00, 14:30)",
              required: true
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "category",
              description: "For leaders: which stat category",
              required: false,
              choices: [
                { name: "Passing", value: "passing" },
                { name: "Rushing", value: "rushing" },
                { name: "Receiving", value: "receiving" },
                { name: "Defense", value: "defense" }
              ]
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "range",
              description: "For power rankings: how many teams to show",
              required: false,
              choices: [
                { name: "Top 5", value: "top5" },
                { name: "Top 10", value: "top10" },
                { name: "Full (All 32)", value: "full" }
              ]
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "list",
          description: "List all scheduled auto-posts"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "remove",
          description: "Remove a scheduled auto-post",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "id",
              description: "The ID of the scheduled post to remove",
              required: true
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "toggle",
          description: "Enable or disable a scheduled auto-post",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "id",
              description: "The ID of the scheduled post to toggle",
              required: true
            }
          ]
        }
      ]
    }
  }
} as CommandHandler
