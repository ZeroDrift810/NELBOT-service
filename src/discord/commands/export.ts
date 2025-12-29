import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessageInvisible, createProdClient } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { ExportContext, exporterForLeague, ExportProgressCallback } from "../../dashboard/ea_client"
import { discordLeagueView } from "../../db/view"
import { DiscordIdType, ChannelId } from "../settings_db"


async function handleExport(guildId: string, week: number, token: string, channelId: string, client: DiscordClient) {
  const league = await discordLeagueView.createView(guildId)
  if (!league) {
    await client.editOriginalInteraction(token, {
      content: "Discord server not connected to any Madden league. Try setting up the dashboard again",
      flags: 64
    })
    return
  }

  // For all_weeks export, use progress updates via channel messages
  const isFullExport = week === 101
  const channel: ChannelId = { id: channelId, id_type: DiscordIdType.CHANNEL }
  const prodClient = createProdClient()

  // Track start time for duration reporting
  const startTime = Date.now()

  // Create progress callback that sends channel messages
  const onProgress: ExportProgressCallback = async (message: string) => {
    try {
      await prodClient.createMessage(channel, `📤 ${message}`, [])
    } catch (e) {
      console.error("[EXPORT] Failed to send progress message:", e)
    }
  }

  try {
    console.log(`[EXPORT] Starting export for league ${league.leagueId}...`)
    const exporter = await exporterForLeague(Number(league.leagueId), ExportContext.MANUAL)
    console.log(`[EXPORT] Got exporter, starting export...`)

    if (isFullExport) {
      // For full export, send initial message and use progress callback
      await client.editOriginalInteraction(token, {
        content: "Starting full league export... Progress updates will be posted below.",
        flags: 64
      })
      await onProgress("Starting full league export...")
      await exporter.exportAllWeeks(onProgress)
    } else if (week === 100) {
      await client.editOriginalInteraction(token, {
        content: "Exporting current week...",
        flags: 64
      })
      console.log(`[EXPORT] Calling exportCurrentWeek...`)
      await exporter.exportCurrentWeek()
      console.log(`[EXPORT] exportCurrentWeek completed`)
    } else {
      await client.editOriginalInteraction(token, {
        content: `Exporting week ${week}...`,
        flags: 64
      })
      await exporter.exportSpecificWeeks([{ weekIndex: week - 1, stage: 1 }])
    }

    const duration = Math.round((Date.now() - startTime) / 1000)
    const durationStr = duration > 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`

    if (isFullExport) {
      await prodClient.createMessage(channel, `✅ **Export complete!** (took ${durationStr})`, [])
    }

    // Try to update original interaction, but don't fail if token expired
    try {
      await client.editOriginalInteraction(token, {
        content: `✅ Finished exporting! (took ${durationStr})`,
        flags: 64
      })
    } catch (e) {
      // Token likely expired for long exports, that's ok
    }
  } catch (e) {
    const errorMsg = `Export failed: ${e}`

    if (isFullExport) {
      await prodClient.createMessage(channel, `❌ ${errorMsg}`, [])
    }

    try {
      await client.editOriginalInteraction(token, {
        content: `❌ ${errorMsg}`,
        flags: 64
      })
    } catch (tokenError) {
      // Token likely expired
    }
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token, channel_id } = command
    if (!command.data.options) {
      throw new Error("export command not defined properly")
    }
    const options = command.data.options
    const exportCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption


    const subCommand = exportCommand.name
    const week = (() => {
      if (subCommand === "week") {
        if (!exportCommand.options || !exportCommand.options[0]) {
          throw new Error("export week command misconfigured")
        }
        const week = Number((exportCommand.options[0] as APIApplicationCommandInteractionDataIntegerOption).value)
        if (week < 1 || week > 23 || week === 22) {
          throw new Error("Invalid week number. Valid weeks are week 1-18 and use specific playoff commands or playoff week numbers: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23")
        }
        return week
      }
      if (subCommand === "current") {
        return 100
      }
      if (subCommand === "all_weeks") {
        return 101
      }
    })()
    if (!week) {
      throw new Error("export week mising")
    }
    respond(ctx, deferMessageInvisible())
    handleExport(guild_id, week, token, channel_id, client)
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "export",
      description: "export your league through the dashboard",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "current",
          description: "exports the current week",
          options: [],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "week",
          description: "exports the specified week",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "the week number to export",
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "all_weeks",
          description: "exports all weeks",
          options: [],
        },
      ],
    }
  }
} as CommandHandler
