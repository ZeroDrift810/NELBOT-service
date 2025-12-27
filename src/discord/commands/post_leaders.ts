import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage } from "../discord_utils"
import {
  APIApplicationCommandInteractionDataChannelOption,
  APIApplicationCommandInteractionDataIntegerOption,
  APIApplicationCommandInteractionDataSubcommandOption,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  RESTPostAPIApplicationCommandsJSONBody
} from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import LeagueSettingsDB, { ChannelId, DiscordIdType } from "../settings_db"
import MaddenDB from "../../db/madden_db"
import { createWeeklyLeadersImage } from "../image_generator/weekly_leaders"

async function postWeeklyLeaders(
  client: DiscordClient,
  token: string,
  guildId: string,
  leagueId: string,
  week: number,
  targetChannel: ChannelId
) {
  try {
    await client.editOriginalInteraction(token, {
      content: "📊 Generating weekly leaders...",
      flags: 64
    })

    const [stats, teams, schedule] = await Promise.all([
      MaddenDB.getWeeklyStats(leagueId, 0, week), // season 0 for now
      MaddenDB.getLatestTeams(leagueId),
      MaddenDB.getLatestWeekSchedule(leagueId, week)
    ])

    // Get the season from the schedule
    const season = schedule.length > 0 ? schedule[0].seasonIndex : 0

    // Check if there are any stats
    const hasStats = Object.values(stats).some(statArray => statArray && statArray.length > 0)

    if (!hasStats) {
      await client.editOriginalInteraction(token, {
        content: `❌ No stats found for week ${week}. Make sure the week has been played and exported.`,
        flags: 64
      })
      return
    }

    // Generate image
    const imageBuffer = await createWeeklyLeadersImage(stats, teams, week, season + 1)

    // Post to channel
    const formData = new FormData()
    const blob = new Blob([imageBuffer], { type: 'image/png' })
    formData.append('files[0]', blob, `week_${week}_leaders.png`)
    formData.append('payload_json', JSON.stringify({
      content: `## 🏆 Week ${week} Leaders\n**Season ${season + 1} • No Excuses League**`,
      attachments: [{
        id: "0",
        filename: `week_${week}_leaders.png`,
        description: `Week ${week} statistical leaders`
      }]
    }))

    await client.createMessageWithForm(targetChannel, formData)

    await client.editOriginalInteraction(token, {
      content: `✅ Posted week ${week} leaders to <#${targetChannel.id}>`,
      flags: 64
    })

  } catch (e) {
    console.error('Error posting weekly leaders:', e)
    await client.editOriginalInteraction(token, {
      content: `❌ Failed to post weekly leaders: ${e}`,
      flags: 64
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token } = command

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("No Madden league linked. Setup the dashboard first")
    }
    const leagueId = leagueSettings.commands.madden_league.league_id

    if (!command.data.options) {
      throw new Error("post_leaders command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    if (subCommand.name === "week") {
      if (!subCommand.options || !subCommand.options[0] || !subCommand.options[1]) {
        throw new Error("post_leaders week command misconfigured")
      }

      const week = Number((subCommand.options[0] as APIApplicationCommandInteractionDataIntegerOption).value)
      const channelId = (subCommand.options[1] as APIApplicationCommandInteractionDataChannelOption).value

      if (week < 1 || week > 23) {
        throw new Error("Invalid week number. Valid weeks are 1-23")
      }

      const targetChannel: ChannelId = { id: channelId, id_type: DiscordIdType.CHANNEL }

      respond(ctx, deferMessage())
      postWeeklyLeaders(client, token, guild_id, leagueId, week, targetChannel)
    } else {
      throw new Error(`post_leaders ${subCommand.name} not implemented`)
    }
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "post_leaders",
      description: "Post weekly statistical leaders with top performers",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "week",
          description: "Post statistical leaders from a specific week",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "Week number (1-23)",
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Channel,
              name: "channel",
              description: "Channel to post the leaders in",
              channel_types: [ChannelType.GuildText],
              required: true,
            },
          ],
        },
      ],
    }
  }
} as CommandHandler
