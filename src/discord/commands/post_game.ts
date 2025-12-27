import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage, createMessageResponse } from "../discord_utils"
import { APIApplicationCommandInteractionDataChannelOption, APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ChannelType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import LeagueSettingsDB, { ChannelId, DiscordIdType } from "../settings_db"
import MaddenDB from "../../db/madden_db"
import { discordLeagueView, leagueLogosView } from "../../db/view"
import { createGameRecapImage } from "../image_generator/game_recap"

async function postGameRecap(
  client: DiscordClient,
  token: string,
  guildId: string,
  leagueId: string,
  week: number,
  scheduleId: number | null,
  targetChannel: ChannelId
) {
  try {
    await client.editOriginalInteraction(token, {
      content: "📊 Generating game recap...",
      flags: 64
    })

    const [schedule, teams, logos] = await Promise.all([
      MaddenDB.getLatestWeekSchedule(leagueId, week),
      MaddenDB.getLatestTeams(leagueId),
      leagueLogosView.createView(leagueId)
    ])

    // Get games to post (specific game or all finished games)
    const gamesToPost = scheduleId
      ? schedule.filter(g => g.scheduleId === scheduleId)
      : schedule.filter(g => g.status !== 1) // 1 = NOT_PLAYED

    if (gamesToPost.length === 0) {
      await client.editOriginalInteraction(token, {
        content: scheduleId
          ? `❌ Game with ID ${scheduleId} not found in week ${week}`
          : `❌ No finished games found in week ${week}`,
        flags: 64
      })
      return
    }

    let posted = 0
    for (const game of gamesToPost) {
      try {
        const awayTeam = teams.getTeamForId(game.awayTeamId)
        const homeTeam = teams.getTeamForId(game.homeTeamId)

        // Get detailed stats for the game
        const stats = await MaddenDB.getStatsForGame(leagueId, game.seasonIndex, week, game.scheduleId)

        // Generate image (will create this next)
        const imageBuffer = await createGameRecapImage(game, awayTeam, homeTeam, stats, logos)

        // Post to channel
        const formData = new FormData()
        const blob = new Blob([imageBuffer], { type: 'image/png' })
        formData.append('files[0]', blob, `game_${game.scheduleId}.png`)
        formData.append('payload_json', JSON.stringify({
          content: `## 🏈 ${awayTeam.displayName} ${game.awayScore} - ${game.homeScore} ${homeTeam.displayName}\n**Week ${week} • Season ${game.seasonIndex + 1}**`,
          attachments: [{
            id: "0",
            filename: `game_${game.scheduleId}.png`,
            description: `Game recap: ${awayTeam.displayName} vs ${homeTeam.displayName}`
          }]
        }))

        await client.createMessageWithForm(targetChannel, formData)
        posted++
      } catch (gameError) {
        console.error(`Failed to post game ${game.scheduleId}:`, gameError)
      }
    }

    await client.editOriginalInteraction(token, {
      content: `✅ Posted ${posted} game recap${posted !== 1 ? 's' : ''} to <#${targetChannel.id}>`,
      flags: 64
    })

  } catch (e) {
    console.error('Error posting game recap:', e)
    await client.editOriginalInteraction(token, {
      content: `❌ Failed to post game recap: ${e}`,
      flags: 64
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token } = command

    // DEFER IMMEDIATELY - Discord requires response within 3 seconds
    respond(ctx, deferMessage())

    // Now do async work
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      await client.editOriginalInteraction(token, {
        content: "❌ No Madden league linked. Setup the dashboard first",
        flags: 64
      })
      return
    }
    const leagueId = leagueSettings.commands.madden_league.league_id

    if (!command.data.options) {
      await client.editOriginalInteraction(token, {
        content: "❌ Command not defined properly",
        flags: 64
      })
      return
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    if (subCommand.name === "week") {
      if (!subCommand.options || !subCommand.options[0] || !subCommand.options[1]) {
        await client.editOriginalInteraction(token, {
          content: "❌ Command misconfigured - missing required options",
          flags: 64
        })
        return
      }

      const week = Number((subCommand.options[0] as APIApplicationCommandInteractionDataIntegerOption).value)
      const channelId = (subCommand.options[1] as APIApplicationCommandInteractionDataChannelOption).value
      const scheduleId = (subCommand.options[2] as APIApplicationCommandInteractionDataIntegerOption)?.value

      if (week < 1 || week > 23) {
        await client.editOriginalInteraction(token, {
          content: "❌ Invalid week number. Valid weeks are 1-23",
          flags: 64
        })
        return
      }

      const targetChannel: ChannelId = { id: channelId, id_type: DiscordIdType.CHANNEL }

      // Don't await - let it run async
      postGameRecap(client, token, guild_id, leagueId, week, scheduleId ? Number(scheduleId) : null, targetChannel)
    } else {
      await client.editOriginalInteraction(token, {
        content: `❌ Subcommand ${subCommand.name} not implemented`,
        flags: 64
      })
    }
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "postgame",
      description: "Post game recaps with stats and team logos",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "week",
          description: "Post game recap(s) from a specific week",
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
              description: "Channel to post the recap in",
              channel_types: [ChannelType.GuildText],
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "game_id",
              description: "Specific game ID to post (optional - posts all finished games if not specified)",
              required: false,
            },
          ],
        },
      ],
    }
  }
} as CommandHandler
