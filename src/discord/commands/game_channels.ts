import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, createMessageResponse, DiscordClient, deferMessage, formatTeamMessageName, SnallabotReactions, SnallabotDiscordError, formatGame, formatSchedule } from "../discord_utils"
import { APIApplicationCommandInteractionDataBooleanOption, APIApplicationCommandInteractionDataChannelOption, APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataRoleOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ChannelType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import LeagueSettingsDB, { CategoryId, ChannelId, DiscordIdType, GameChannel, GameChannelConfiguration, GameChannelState, LeagueSettings, MaddenLeagueConfiguration, MessageId, RoleId, UserId, WeekState } from "../settings_db"
import MaddenClient, { TeamList } from "../../db/madden_db"
import { formatRecord, getMessageForWeek, MADDEN_SEASON, MaddenGame } from "../../export/madden_league_types"
import createLogger from "../logging"
import { ConfirmedSim, ConfirmedSimV2, SimResult } from "../../db/events"
import createNotifier from "../notifier"
import { ExportContext, Stage, exporterForLeague, EAAccountError } from "../../dashboard/ea_client"
import { LeagueLogos, leagueLogosView } from "../../db/view"

// Webhook configuration for NEL Utility Bot companion messages
const UTILITY_BOT_WEBHOOK_URL = process.env.UTILITY_BOT_WEBHOOK_URL || 'http://localhost:3002/api/game-channel-created'
const UTILITY_BOT_WEBHOOK_SECRET = process.env.UTILITY_BOT_WEBHOOK_SECRET || 'your-secret-key-change-this'

// Send webhook to NEL Utility Bot when game channel is created
async function sendGameChannelWebhook(data: {
  channel_id: string,
  guild_id: string,
  home_team: string,
  away_team: string,
  home_record: string,
  away_record: string,
  season: number,
  week: number,
  home_user_id?: string,
  away_user_id?: string
}) {
  try {
    const response = await fetch(UTILITY_BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${UTILITY_BOT_WEBHOOK_SECRET}`
      },
      body: JSON.stringify(data)
    })
    if (response.ok) {
      console.log(`✅ Webhook sent for game channel ${data.away_team} @ ${data.home_team}`)
    } else {
      console.warn(`⚠️ Webhook failed for game channel: ${response.status}`)
    }
  } catch (error) {
    console.warn(`⚠️ Could not send game channel webhook:`, error)
    // Don't throw - webhook failure shouldn't break channel creation
  }
}

async function react(client: DiscordClient, channel: ChannelId, message: MessageId, reaction: SnallabotReactions) {
  await client.reactToMessage(`${reaction}`, message, channel)
}

// ✅ Custom NEL game channel message with stream title suggestion
function notifierMessage(users: string, homeTeamName: string, homeRecord: string, awayTeamName: string, awayRecord: string, season: number, week: number): string {
    const suggestedStreamTitle = `NEL Y${season}W${week} ${homeTeamName} (${homeRecord}) @ ${awayTeamName} (${awayRecord})`

    const messageBody = `### 🏈 Time to Schedule Your Game! 🏈

**Scheduling & Results:**
• Once your game time is set, please react to this message with ⏰.
• When the game is finished, react with 🏆 to close this channel.

---

**🎮 Streaming (Optional):**
Include **NEL** anywhere in your Twitch stream title for auto-announcements!
> **Example:** \`${suggestedStreamTitle}\`

Streams post to <#1415819410022731956>. See the **Streaming Guide** button in <#1446736003145400361> for setup help!

---

**Sim / Force Win Rules:**
> 1. **Force Win:** React 🏠 (home wins) or ✈️ (away wins)
> 2. **Fair Sim:** Both players react (one 🏠, one ✈️)
> 3. **Confirm:** React ⏭️ — Admin must also react ⏭️ to approve

---

**League Reminders:**
• **4th Down Rules**: <#1415819246373703791>
• **Highlights**: <#1415819489626558524>`

    return `${users}\n${messageBody}`
}

enum SnallabotCommandReactions {
  LOADING = "<a:snallabot_loading:1288662414191104111>",
  WAITING = "<a:snallabot_waiting:1288664321781399584>",
  FINISHED = "<a:snallabot_done:1288666730595618868>",
  ERROR = "<:snallabot_error:1288692698320076820>"
}

async function createGameChannels(client: DiscordClient, db: Firestore, token: string, guild_id: string, settings: LeagueSettings, week: number, category: CategoryId, author: UserId) {
  let channelsToCleanup: ChannelId[] = []
  try {
    const leagueId = (settings.commands.madden_league as Required<MaddenLeagueConfiguration>).league_id
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${SnallabotCommandReactions.LOADING} Exporting
- ${SnallabotCommandReactions.WAITING} Creating Channels
- ${SnallabotCommandReactions.WAITING} Creating Notification Messages
- ${SnallabotCommandReactions.WAITING} Setting up notifier
- ${SnallabotCommandReactions.WAITING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
    })
    let exportEmoji = SnallabotCommandReactions.FINISHED
    let errorMessage = ""
    try {
      // Allow 90 seconds for exports (EA servers can be slow)
      const exportPromise = (async () => {
        const exporter = await exporterForLeague(Number(leagueId), ExportContext.AUTO)
        await exporter.exportSurroundingWeek()
      })()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Export timed out after 90 seconds')), 90000)
      )
      await Promise.race([exportPromise, timeoutPromise])
    } catch (e) {
      exportEmoji = SnallabotCommandReactions.ERROR
      if (e instanceof EAAccountError) {
        errorMessage = `Export Failed with: EA Error ${e.message} Guidance: ${e.troubleshoot}`
      } else {
        errorMessage = `Export Failed with: ${e}`
      }
      console.error('Export error:', e)
    }
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.LOADING} Creating Channels
- ${SnallabotCommandReactions.WAITING} Creating Notification Messages
- ${SnallabotCommandReactions.WAITING} Setting up notifier
- ${SnallabotCommandReactions.WAITING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
    })
    let weekSchedule;
    try {
      weekSchedule = (await MaddenClient.getLatestWeekSchedule(leagueId, week)).sort((g, g2) => g.scheduleId - g2.scheduleId)
    } catch (e) {
      await client.editOriginalInteraction(token, {
        content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.LOADING} Creating Channels, automatically retrieving the week for you! Please wait..
- ${SnallabotCommandReactions.WAITING} Creating Notification Messages
- ${SnallabotCommandReactions.WAITING} Setting up notifier
- ${SnallabotCommandReactions.WAITING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
      })
      try {
        const exporter = await exporterForLeague(Number(leagueId), ExportContext.AUTO)
        await exporter.exportSpecificWeeks([{ weekIndex: week, stage: Stage.SEASON }])
        weekSchedule = (await MaddenClient.getLatestWeekSchedule(leagueId, week)).sort((g, g2) => g.scheduleId - g2.scheduleId)
      } catch (e) {
        await client.editOriginalInteraction(token, { content: "This week is not exported! Export it via dashboard or companion app" })
        return
      }
    }

    const teams = await MaddenClient.getLatestTeams(leagueId)
    const assignments = teams.getLatestTeamAssignments(settings.commands.teams?.assignments || {})
    const gameChannels = []
    for (const game of weekSchedule) {
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      let channel;
      if (settings.commands.game_channel?.private_channels) {
        const users: UserId[] = [assignments?.[awayTeam.teamId]?.discord_user, assignments?.[homeTeam.teamId]?.discord_user]
          .flatMap(u => u ? [u] : [])
        channel = await client.createChannel(guild_id, `${awayTeam.displayName}-at-${homeTeam.displayName}`, category, users, [settings.commands.game_channel.admin])
      } else {
        channel = await client.createChannel(guild_id, `${awayTeam.displayName}-at-${homeTeam.displayName}`, category,)
      }
      gameChannels.push({ game: game, scheduleId: game.scheduleId, channel: channel })
    }
    channelsToCleanup = gameChannels.map(c => c.channel)
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.FINISHED} Creating Channels
- ${SnallabotCommandReactions.LOADING} Creating Notification Messages
- ${SnallabotCommandReactions.WAITING} Setting up notifier
- ${SnallabotCommandReactions.WAITING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
    })
    if (!settings.commands.game_channel) {
      return
    }
    const gameChannelsWithMessage = await Promise.all(gameChannels.map(async gameChannel => {
      const channel = gameChannel.channel
      const game = gameChannel.game
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeamId = awayTeam.teamId
      const homeTeamId = homeTeam.teamId
      const awayUser = formatTeamMessageName(assignments?.[awayTeamId]?.discord_user?.id, awayTeam?.userName)
      const homeUser = formatTeamMessageName(assignments?.[homeTeamId]?.discord_user?.id, homeTeam?.userName)
      const awayTeamStanding = await MaddenClient.getStandingForTeam(leagueId, awayTeamId)
      const homeTeamStanding = await MaddenClient.getStandingForTeam(leagueId, homeTeamId)
      const homeRecord = formatRecord(homeTeamStanding)
      const awayRecord = formatRecord(awayTeamStanding)
      const usersMessage = `${awayUser} (${awayRecord}) at ${homeUser} (${homeRecord})`
      const season = game.seasonIndex + 1
      const gameWeek = game.weekIndex + 1
      const message = await client.createMessage(channel, notifierMessage(usersMessage, homeTeam.displayName, homeRecord, awayTeam.displayName, awayRecord, season, gameWeek), ["users"])
      return { message: message, ...gameChannel }
    }))
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.FINISHED} Creating Channels
- ${SnallabotCommandReactions.FINISHED} Creating Notification Messages
- ${SnallabotCommandReactions.LOADING} Setting up notifier
- ${SnallabotCommandReactions.WAITING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
    })
    const finalGameChannels: GameChannel[] = await Promise.all(gameChannelsWithMessage.map(async gameChannel => {
      const { channel: channel, message: message, game } = gameChannel
      await react(client, channel, message, SnallabotReactions.SCHEDULE)
      await react(client, channel, message, SnallabotReactions.GG)
      await react(client, channel, message, SnallabotReactions.HOME)
      await react(client, channel, message, SnallabotReactions.AWAY)
      await react(client, channel, message, SnallabotReactions.SIM)

      // Send webhook to NEL Utility Bot for companion message with buttons
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeamStanding = await MaddenClient.getStandingForTeam(leagueId, game.awayTeamId)
      const homeTeamStanding = await MaddenClient.getStandingForTeam(leagueId, game.homeTeamId)
      sendGameChannelWebhook({
        channel_id: channel.id,
        guild_id: guild_id,
        home_team: homeTeam.displayName,
        away_team: awayTeam.displayName,
        home_record: formatRecord(homeTeamStanding),
        away_record: formatRecord(awayTeamStanding),
        season: game.seasonIndex + 1,
        week: game.weekIndex + 1,
        home_user_id: assignments?.[homeTeam.teamId]?.discord_user?.id,
        away_user_id: assignments?.[awayTeam.teamId]?.discord_user?.id
      })

      const { game: _game, ...rest } = gameChannel
      const createdTime = new Date().getTime()
      return { ...rest, state: GameChannelState.CREATED, notifiedTime: createdTime, channel: channel, message: message }
    }))
    const channelsMap = {} as { [key: string]: GameChannel }
    finalGameChannels.forEach(g => channelsMap[g.channel.id] = g)
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.FINISHED} Creating Channels
- ${SnallabotCommandReactions.FINISHED} Creating Notification Messages
- ${SnallabotCommandReactions.FINISHED} Setting up notifier
- ${SnallabotCommandReactions.LOADING} Creating Scoreboard
- ${SnallabotCommandReactions.WAITING} Logging`
    })

    const season = weekSchedule[0].seasonIndex
    const logos = await leagueLogosView.createView(leagueId)
    const scoreboardMessage = formatSchedule(week, season, weekSchedule, teams, [], logos)
    const scoreboardMessageId = await client.createMessage(settings.commands.game_channel?.scoreboard_channel, scoreboardMessage, [])
    const weeklyState: WeekState = { week: week, seasonIndex: season, scoreboard: scoreboardMessageId, channel_states: channelsMap }
    await client.editOriginalInteraction(token, {
      content: `Creating Game Channels:
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.FINISHED} Creating Channels
- ${SnallabotCommandReactions.FINISHED} Creating Notification Messages
- ${SnallabotCommandReactions.FINISHED} Setting up notifier
- ${SnallabotCommandReactions.FINISHED} Creating Scoreboard
- ${SnallabotCommandReactions.LOADING} Logging`
    })
    if (settings?.commands?.logger) {
      const logger = createLogger(settings.commands.logger)
      await logger.logUsedCommand("game_channels create", author, client)
    }
    await client.editOriginalInteraction(token, {
      content: `Game Channels Successfully Created :
- ${exportEmoji} Exporting
- ${SnallabotCommandReactions.FINISHED} Creating Channels
- ${SnallabotCommandReactions.FINISHED} Creating Notification Messages
- ${SnallabotCommandReactions.FINISHED} Setting up notifier
- ${SnallabotCommandReactions.FINISHED} Creating Scoreboard
- ${SnallabotCommandReactions.FINISHED} Logging
${errorMessage}
`
    })
    await LeagueSettingsDB.updateGameWeekState(guild_id, week, season, weeklyState)
  } catch (e) {
    try {
      await Promise.all(channelsToCleanup.map(async channel => {
        await client.deleteChannel(channel)
      }))
    } catch (e) {
    }
    if (e instanceof SnallabotDiscordError) {
      await client.editOriginalInteraction(token, { content: `Game Channels Create Failed with Error: ${e} Guidance: ${e.guidance}` })
    } else {
      await client.editOriginalInteraction(token, { content: `Game Channels Create Failed with Error: ${e}` })
    }
  }
}

async function clearGameChannels(client: DiscordClient, db: Firestore, token: string, guild_id: string, settings: LeagueSettings, author: UserId, weekToClear?: number) {
  try {
    await client.editOriginalInteraction(token, { content: `Clearing Game Channels...` })
    const weekStates = settings.commands.game_channel?.weekly_states || {}
    const weekStatesWithChannels = Object.fromEntries(Object.entries(weekStates).filter(entry => {
      const weekState = entry[1]
      if (weekToClear) {
        return weekState?.channel_states && weekState.week === weekToClear
      }
      return weekState?.channel_states
    }))
    const channelsToClear = Object.entries(weekStatesWithChannels).flatMap(entry => {
      const weekState = entry[1]
      return Object.values(weekState?.channel_states || {})
    }).map(channelStates => {
      return channelStates.channel
    })
    if (settings.commands.logger?.channel) {
      await client.editOriginalInteraction(token, { content: `Logging Game Channels...` })
      const logger = createLogger(settings.commands.logger)
      await logger.logChannels(channelsToClear, [author], client)
      await logger.logUsedCommand("game_channels clear", author, client)
    } else {
      await Promise.all(channelsToClear.map(async channel => {
        try {
          return await client.deleteChannel(channel)
        } catch (e) {
          if (e instanceof SnallabotDiscordError) {
            if (e.isDeletedChannel()) {
              return
            }
          }
          throw e
        }
      }))
    }
    await Promise.all(Object.values(weekStatesWithChannels).map(async weekState => {
      await LeagueSettingsDB.deleteGameChannels(guild_id, weekState.week, weekState.seasonIndex)
    }))
    await client.editOriginalInteraction(token, { content: `Game Channels Cleared` })
  } catch (e) {
    await client.editOriginalInteraction(token, { content: `Game Channels could not be cleared properly . Error: ${e}` })
  }
}

async function notifyGameChannels(client: DiscordClient, token: string, guild_id: string, settings: LeagueSettings) {
  try {
    await client.editOriginalInteraction(token, { content: `Notifying Game Channels...` })
    const weekStates = settings.commands.game_channel?.weekly_states || {}
    const notifier = createNotifier(client, guild_id, settings)
    await Promise.all(Object.entries(weekStates).map(async entry => {
      const weekState = entry[1]
      const season = weekState.seasonIndex
      const week = weekState.week
      return await Promise.all(Object.values(weekState.channel_states).map(async channel => {
        await notifier.ping(channel, season, week)
      }))
    }))
    await client.editOriginalInteraction(token, { content: `Game Channels Notified` })
  } catch (e) {
    await client.editOriginalInteraction(token, { content: `Game Channels could not be notified properly Error: ${e}` })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token, member } = command
    const author: UserId = { id: member.user.id, id_type: DiscordIdType.USER }
    if (!command.data.options) {
      throw new Error("game channels command not defined properly")
    }
    const options = command.data.options
    const gameChannelsCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const subCommand = gameChannelsCommand.name
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (subCommand === "configure") {
      if (!gameChannelsCommand.options || !gameChannelsCommand.options[0] || !gameChannelsCommand.options[1] || !gameChannelsCommand.options[2] || !gameChannelsCommand.options[3]) {
        throw new Error("game_channels configure command misconfigured")
      }
      const gameChannelCategory = (gameChannelsCommand.options[0] as APIApplicationCommandInteractionDataChannelOption).value
      const scoreboardChannel = (gameChannelsCommand.options[1] as APIApplicationCommandInteractionDataChannelOption).value
      const waitPing = (gameChannelsCommand.options[2] as APIApplicationCommandInteractionDataIntegerOption).value
      const adminRole = (gameChannelsCommand.options[3] as APIApplicationCommandInteractionDataRoleOption).value
      const usePrivateChannels = (gameChannelsCommand?.options?.[4] as APIApplicationCommandInteractionDataBooleanOption)?.value
      const conf: GameChannelConfiguration = {
        admin: { id: adminRole, id_type: DiscordIdType.ROLE },
        default_category: { id: gameChannelCategory, id_type: DiscordIdType.CATEGORY },
        scoreboard_channel: { id: scoreboardChannel, id_type: DiscordIdType.CHANNEL },
        wait_ping: Number.parseInt(`${waitPing}`),
        weekly_states: leagueSettings?.commands?.game_channel?.weekly_states || {},
        private_channels: !!usePrivateChannels
      }
      await LeagueSettingsDB.configureGameChannel(guild_id, conf)
      respond(ctx, createMessageResponse(`game channels commands are configured! Configuration:

- Admin Role: <@&${adminRole}>
- Game Channel Category: <#${gameChannelCategory}>
- Scoreboard Channel: <#${scoreboardChannel}>
- Notification Period: Every ${waitPing} hour(s)
- Private Channels: ${!!usePrivateChannels ? "Yes" : "No"}`))
    } else if (subCommand === "create" || subCommand === "wildcard" || subCommand === "divisional" || subCommand === "conference" || subCommand === "superbowl") {
      const week = (() => {
        if (subCommand === "create") {
          if (!gameChannelsCommand.options || !gameChannelsCommand.options[0]) {
            throw new Error("game_channels create command misconfigured")
          }
          const week = Number((gameChannelsCommand.options[0] as APIApplicationCommandInteractionDataIntegerOption).value)
          if (week < 1 || week > 23 || week === 22) {
            throw new Error("Invalid week number. Valid weeks are week 1-18 and use specific playoff commands or playoff week numbers: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23")
          }
          return week
        }
        if (subCommand === "wildcard") {
          return 19
        }
        if (subCommand === "divisional") {
          return 20
        }
        if (subCommand === "conference") {
          return 21
        }
        if (subCommand === "superbowl") {
          return 23
        }
      })()
      if (!week) {
        throw new Error("Invalid Week found " + week)
      }
      const categoryOverride = (() => {
        if (subCommand === "create") {
          return (gameChannelsCommand.options?.[1] as APIApplicationCommandInteractionDataChannelOption)?.value
        } else {
          return (gameChannelsCommand.options?.[0] as APIApplicationCommandInteractionDataChannelOption)?.value
        }
      })()
      if (!leagueSettings.commands?.game_channel?.scoreboard_channel) {
        throw new Error("Game channels are not configured! run /game_channels configure first")
      }
      if (!leagueSettings.commands?.madden_league?.league_id) {
        throw new Error("No madden league linked. Setup snallabot with your Madden league first")
      }
      const category = categoryOverride ? categoryOverride : leagueSettings.commands.game_channel.default_category.id
      respond(ctx, deferMessage())
      createGameChannels(client, db, token, guild_id, leagueSettings, week, { id: category, id_type: DiscordIdType.CATEGORY }, author)
    } else if (subCommand === "clear") {
      const gameChannelsCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
      const gameChannelWeekToClear = (gameChannelsCommand?.options?.[0] as APIApplicationCommandInteractionDataIntegerOption)?.value
      const weekToClear = gameChannelWeekToClear ? Number(gameChannelWeekToClear) : undefined
      respond(ctx, deferMessage())
      clearGameChannels(client, db, token, guild_id, leagueSettings, author, weekToClear)
    } else if (subCommand === "notify") {
      respond(ctx, deferMessage())
      notifyGameChannels(client, token, guild_id, leagueSettings)
    } else {
      throw new Error(`game_channels ${subCommand} not implemented`)
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "game_channels",
      description: "handles Snallabot game channels",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "create",
          description: "create game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "the week number to create for",
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category_override",
              description: "overrides the category to create channels in",
              channel_types: [ChannelType.GuildCategory],
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "wildcard",
          description: "creates wildcard week game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category_override",
              description: "overrides the category to create channels in",
              channel_types: [ChannelType.GuildCategory],
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "divisional",
          description: "creates divisional week game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category_override",
              description: "overrides the category to create channels in",
              channel_types: [ChannelType.GuildCategory],
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "conference",
          description: "creates conference championship week game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category_override",
              description: "overrides the category to create channels in",
              channel_types: [ChannelType.GuildCategory],
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "superbowl",
          description: "creates superbowl week game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category_override",
              description: "overrides the category to create channels in",
              channel_types: [ChannelType.GuildCategory],
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "clear",
          description: "clear all game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "optional week to clear",
              required: false,
            },
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "configure",
          description: "sets up game channels",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "category",
              description: "category to create channels under",
              required: true,
              channel_types: [ChannelType.GuildCategory],
            },
            {
              type: ApplicationCommandOptionType.Channel,
              name: "scoreboard_channel",
              description: "channel to post scoreboard",
              required: true,
              channel_types: [0],
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "notification_period",
              description: "number of hours to wait before notifying unscheduled games",
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Role,
              name: "admin_role",
              description: "admin role to confirm force wins",
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Boolean,
              name: "private_channels",
              description: "make game channels private to users and admins",
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "notify",
          description: "notifies all remaining game channels",
          options: [
          ]
        },
      ]
    }
  }
} as CommandHandler