import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, createMessageResponse, DiscordClient } from "../discord_utils"
import { APIApplicationCommandInteractionDataChannelOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ChannelType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import LeagueSettingsDB, { DiscordIdType, TransactionConfiguration } from "../settings_db"

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id } = command
    if (!command.data.options) {
      throw new Error("transactions command not defined properly")
    }
    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const subCommandName = subCommand.name

    if (subCommandName === "configure") {
      const subCommandOptions = subCommand.options
      if (!subCommandOptions) {
        throw new Error("missing transactions configure options!")
      }
      const channel = (subCommandOptions[0] as APIApplicationCommandInteractionDataChannelOption).value

      const transactionConfig: TransactionConfiguration = {
        channel: {
          id: channel,
          id_type: DiscordIdType.CHANNEL
        }
      }
      await LeagueSettingsDB.configureTransactions(guild_id, transactionConfig)
      respond(ctx, createMessageResponse(`Transaction notifications will be posted to <#${channel}>. Contract signings and free agent pickups will now be announced automatically!`))
    } else if (subCommandName === "status") {
      const settings = await LeagueSettingsDB.getLeagueSettings(guild_id)
      const transactionChannel = settings.commands.transactions?.channel
      if (transactionChannel) {
        respond(ctx, createMessageResponse(`Transaction notifications are configured to post in <#${transactionChannel.id}>`))
      } else {
        respond(ctx, createMessageResponse("Transaction notifications are not configured. Use `/transactions configure` to set up a channel."))
      }
    } else {
      throw new Error("Unknown transactions subcommand: " + subCommandName)
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "transactions",
      description: "Configure automatic contract signing notifications",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "configure",
          description: "Set the channel for contract signing notifications",
          options: [{
            type: ApplicationCommandOptionType.Channel,
            name: "channel",
            description: "Channel to post contract signings and FA pickups",
            required: true,
            channel_types: [ChannelType.GuildText]
          }]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "status",
          description: "Check the current transaction notification settings"
        }
      ]
    }
  }
} as CommandHandler
