import { ParameterizedContext } from "koa"
import Router from "@koa/router"
import { CommandMode, DiscordClient, createProdClient, getSimsForWeek, formatSchedule } from "./discord_utils"
import { APIInteraction, InteractionType, InteractionResponseType, APIChatInputApplicationCommandGuildInteraction, APIApplicationCommandAutocompleteInteraction, APIMessageComponentInteraction } from "discord-api-types/payloads"
import db from "../db/firebase"
import EventDB from "../db/events_db"
import { handleCommand, commandsInstaller, handleAutocomplete, handleMessageComponent } from "./commands_handler"
import { ConfirmedSimV2, MaddenBroadcastEvent } from "../db/events"
import { Client } from "oceanic.js"
import LeagueSettingsDB, { DiscordIdType, LeagueSettings, TeamAssignments, createWeekKey } from "./settings_db"
import { fetchTeamsMessage } from "./commands/teams"
import createNotifier from "./notifier"
import MaddenClient from "../db/madden_db"
import MaddenDB from "../db/madden_db"
import { GameResult, MaddenGame } from "../export/madden_league_types"
import { leagueLogosView } from "../db/view"
import { startAutoPostScheduler } from "./autopost_scheduler"
import PickemDB from "./pickem_db"
import { notifyGameResult } from "../twitch-notifier/game_result_notifier"
import ProcessedGamesDB from "./processed_games_db"

const router = new Router({ prefix: "/discord/webhook" })

const prodClient = createProdClient()

async function handleInteraction(ctx: ParameterizedContext, client: DiscordClient) {
  const verified = await client.interactionVerifier(ctx)
  if (!verified) {
    ctx.status = 401
    return
  }
  const interaction = ctx.request.body as APIInteraction
  const { type: interactionType } = interaction
  if (interactionType === InteractionType.Ping) {
    ctx.status = 200
    ctx.body = { type: InteractionResponseType.Pong }
    return
  }
  if (interactionType === InteractionType.ApplicationCommand) {
    const slashCommandInteraction = interaction as APIChatInputApplicationCommandGuildInteraction
    const { token, guild_id, channel_id, data, member } = slashCommandInteraction
    const { name } = data
    await handleCommand({ command_name: name, token, guild_id, channel_id, data, member }, ctx, client, db)
    return
  } else if (interactionType === InteractionType.ApplicationCommandAutocomplete) {
    const slashCommandInteraction = interaction as APIApplicationCommandAutocompleteInteraction
    const { guild_id, data } = slashCommandInteraction
    if (guild_id) {
      const { name } = data
      await handleAutocomplete({ command_name: name, guild_id, data, token: slashCommandInteraction.token }, ctx)
    }
    return
  } else if (interactionType === InteractionType.MessageComponent) {
    const messageComponentInteraction = interaction as APIMessageComponentInteraction
    if (messageComponentInteraction.guild_id) {
      await handleMessageComponent({
        token: messageComponentInteraction.token,
        custom_id: messageComponentInteraction.data.custom_id,
        data: messageComponentInteraction.data,
        guild_id: messageComponentInteraction.guild_id,
        member: messageComponentInteraction.member  // Include member for user info
      }, ctx, client)
    }
    return
  }
  // anything else fail the command
  ctx.status = 404
}

type CommandsHandlerRequest = { commandNames?: string[], mode: CommandMode, guildId?: string }

// Admin API secret for sensitive endpoints - must be set via env var
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET
if (!ADMIN_API_SECRET) {
  console.warn("⚠️ ADMIN_API_SECRET not set - commandsHandler endpoint will be disabled for security")
}

router.post("/slashCommand", async (ctx) => {
  await handleInteraction(ctx, prodClient)
}).post("/commandsHandler", async (ctx) => {
  // Authentication required for command installation/deletion
  if (!ADMIN_API_SECRET) {
    ctx.status = 503
    ctx.body = { error: "Endpoint disabled - ADMIN_API_SECRET not configured" }
    return
  }

  const authHeader = ctx.request.headers["authorization"]
  if (!authHeader || authHeader !== `Bearer ${ADMIN_API_SECRET}`) {
    console.warn(`⚠️ Unauthorized commandsHandler request from ${ctx.request.ip}`)
    ctx.status = 401
    ctx.body = { error: "Unauthorized" }
    return
  }

  const req = ctx.request.body as CommandsHandlerRequest
  console.log(`🔧 Authorized command operation: ${req.mode} commands=${req.commandNames?.join(",") || "all"} guild=${req.guildId || "global"}`)
  await commandsInstaller(prodClient, req.commandNames || [], req.mode, req.guildId)
  ctx.status = 200
  ctx.body = { success: true }
})
EventDB.on<MaddenBroadcastEvent>("MADDEN_BROADCAST", async (events) => {
  events.map(async broadcastEvent => {
    const discordServer = broadcastEvent.key
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(discordServer)
    const configuration = leagueSettings.commands?.broadcast
    if (!configuration) {
      console.error(`${discordServer} is not configured for Broadcasts`)
    } else {
      const channel = configuration.channel
      const role = configuration.role ? `<@&${configuration.role.id}>` : ""
      try {
        await prodClient.createMessage(channel, `${role} ${broadcastEvent.title}\n\n${broadcastEvent.video}`, ["roles"])
      } catch (e) {
        console.error("could not send broacast")
      }

      // Auto-lock pick'em when broadcast starts
      try {
        const leagueId = leagueSettings.commands.madden_league?.league_id
        if (leagueId) {
          // Get current week from schedule
          const weeks = await MaddenDB.getAllWeeks(leagueId)
          if (weeks.length > 0) {
            const currentSeason = weeks[0].seasonIndex
            const currentWeek = weeks[0].weekIndex

            // Lock picks for current week
            await PickemDB.lockWeek(discordServer, leagueId, currentSeason, currentWeek, 'broadcast')
            console.log(`🔒 Auto-locked pick'em for Week ${currentWeek + 1} due to broadcast: ${broadcastEvent.title}`)
          }
        }
      } catch (e) {
        console.error("Could not auto-lock pick'em:", e)
      }
    }
  })
})

async function updateScoreboard(leagueSettings: LeagueSettings, guildId: string, seasonIndex: number, week: number) {
  const leagueId = leagueSettings.commands.madden_league?.league_id
  if (!leagueId) {
    return
  }
  const weekState = leagueSettings.commands.game_channel?.weekly_states?.[createWeekKey(seasonIndex, week)]
  const scoreboard_channel = leagueSettings.commands.game_channel?.scoreboard_channel
  if (!scoreboard_channel) {
    return
  }
  const scoreboard = weekState?.scoreboard
  if (!scoreboard) {
    return
  }
  try {
    const teams = await MaddenClient.getLatestTeams(leagueId)
    const games = await MaddenClient.getWeekScheduleForSeason(leagueId, week, seasonIndex)

    const logos = await leagueLogosView.createView(leagueId)
    const sims = await getSimsForWeek(leagueId, week, seasonIndex)
    const message = formatSchedule(week, seasonIndex, games, teams, sims, logos)
    await prodClient.editMessage(scoreboard_channel, scoreboard, message, [])
  } catch (e) {
    console.error(`❌ Failed to update scoreboard for guild ${guildId}, week ${week}:`, e)
  }
}

EventDB.on<ConfirmedSimV2>("CONFIRMED_SIM", async (events) => {
  await Promise.all(events.map(async sim => {
    const leagueId = sim.key
    const settings = await LeagueSettingsDB.getLeagueSettingsForLeagueId(leagueId)
    await Promise.all(settings.map(async s => {
      await updateScoreboard(s, s.guildId, sim.seasonIndex, sim.week)
    }))

  }))
})

MaddenDB.on<MaddenGame>("MADDEN_SCHEDULE", async (events) => {

  Object.entries(Object.groupBy(events, e => e.key)).map(async entry => {
    const [leagueId, groupedGames] = entry
    const games = groupedGames || []
    const finishedGames = games.filter(g => g.status !== GameResult.NOT_PLAYED)
    const finishedGame = finishedGames[0]
    const allSettingsForLeague = await LeagueSettingsDB.getLeagueSettingsForLeagueId(leagueId)
    await Promise.all(allSettingsForLeague.map(async settings => {
      const guild_id = settings.guildId
      if (finishedGame) {
        const season = finishedGame.seasonIndex
        const week = finishedGame.weekIndex + 1
        await updateScoreboard(settings, guild_id, season, week)
        const notifier = createNotifier(prodClient, guild_id, settings)
        const gameIds = new Set(finishedGames.map(g => g.scheduleId))
        await Promise.all(Object.values(settings.commands.game_channel?.weekly_states?.[createWeekKey(season, week)]?.channel_states || {}).map(async channelState => {
          if (gameIds.has(channelState.scheduleId)) {
            try {
              await notifier.deleteGameChannel(channelState, season, week, [prodClient.getBotUser()])
            } catch (e) {
              console.error(`❌ Failed to delete game channel ${channelState.channel.id}:`, e)
            }
          }
        }))

        // Auto-score pick'em for finished games
        try {
          console.log(`🎯 Auto-scoring pick'em for ${finishedGames.length} finished games (Week ${week}, Season ${season})`)

          // Build game results from finished games
          const gameResults: { [scheduleId: number]: { actualWinner: number, homeScore: number, awayScore: number } } = {}
          for (const game of finishedGames) {
            // Determine winner based on status
            let actualWinner: number
            if (game.status === GameResult.HOME_WIN) {
              actualWinner = game.homeTeamId
            } else if (game.status === GameResult.AWAY_WIN) {
              actualWinner = game.awayTeamId
            } else {
              // Tie - use home team as "winner" for scoring purposes (or skip)
              actualWinner = game.homeTeamId
            }

            gameResults[game.scheduleId] = {
              actualWinner,
              homeScore: game.homeScore,
              awayScore: game.awayScore
            }
          }

          // Save game results and score picks
          const weekIndex = finishedGame.weekIndex
          await PickemDB.saveGameResults(guild_id, leagueId, season, weekIndex, gameResults)
          await PickemDB.scoreWeekPicks(guild_id, leagueId, season, weekIndex)

          console.log(`✅ Pick'em scored for Week ${week}, Season ${season}`)
        } catch (e) {
          console.error(`❌ Error auto-scoring pick'em:`, e)
        }

        // Notify NEL Utility Bot of NEW game completions only
        try {
          // Filter to only unprocessed games
          const unprocessedGames = await ProcessedGamesDB.filterUnprocessedGames(leagueId, finishedGames)

          if (unprocessedGames.length > 0) {
            console.log(`🎮 Found ${unprocessedGames.length} NEW game completions to process`)
            const teamsData = await MaddenDB.getLatestTeams(leagueId)

            for (const game of unprocessedGames) {
              const homeTeam = teamsData.getTeamForId(game.homeTeamId)
              const awayTeam = teamsData.getTeamForId(game.awayTeamId)

              if (homeTeam && awayTeam) {
                // Send to NEL Utility Bot
                await notifyGameResult({
                  home_team: homeTeam.abbrName,
                  away_team: awayTeam.abbrName,
                  home_score: game.homeScore,
                  away_score: game.awayScore,
                  week_number: week,
                  season: `Season ${season + 1}` // Convert 0-indexed to display (Season 2 = index 1)
                })

                // Mark as processed so we don't send again
                await ProcessedGamesDB.markGameProcessed({
                  leagueId,
                  scheduleId: game.scheduleId,
                  seasonIndex: season,
                  weekIndex: finishedGame.weekIndex,
                  homeTeam: homeTeam.abbrName,
                  awayTeam: awayTeam.abbrName,
                  homeScore: game.homeScore,
                  awayScore: game.awayScore,
                  processedAt: new Date()
                })

                console.log(`📡 Notified NEL Utility: ${awayTeam.abbrName} ${game.awayScore} @ ${homeTeam.abbrName} ${game.homeScore}`)
              }
            }
          }
        } catch (e) {
          console.error(`❌ Error notifying NEL Utility Bot:`, e)
        }
      }
    }))
  })
})

const discordClient = new Client({
  auth: `Bot ${process.env.DISCORD_TOKEN}`,
  gateway: {
    intents: ["GUILD_MESSAGE_REACTIONS", "GUILD_MEMBERS"]
  }
})

discordClient.on("ready", () => console.log("Ready as", discordClient.user.tag));
discordClient.on("error", (error) => {
  console.error("Something went wrong:", error);
});


discordClient.on("guildMemberRemove", async (user, guild) => {
  const guildId = guild.id
  const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guildId)
  if (leagueSettings.commands.teams) {
    const assignments = leagueSettings.commands.teams?.assignments || {} as TeamAssignments
    await Promise.all(Object.entries(assignments).map(async entry => {
      const [teamId, assignment] = entry
      if (assignment.discord_user?.id === user.id) {
        await LeagueSettingsDB.removeAssignment(guildId, teamId)
        delete assignments[teamId].discord_user
      }
    }))
    const message = await fetchTeamsMessage(leagueSettings)
    try {
      await prodClient.editMessage(leagueSettings.commands.teams.channel, leagueSettings.commands.teams.messageId, message, [])
    } catch (e) {
      console.error(`❌ Failed to update teams message after member ${user.id} left guild ${guildId}:`, e)
    }
  }
});

discordClient.on("guildMemberUpdate", async (member, old) => {
  const guildId = member.guildID
  const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guildId)
  if (leagueSettings.commands.teams?.useRoleUpdates) {
    const users = await prodClient.getUsers(guildId)
    const userWithRoles = users.map((u) => ({ id: u.user.id, roles: u.roles }))
    const assignments = leagueSettings.commands.teams.assignments || {} as TeamAssignments
    await Promise.all(Object.entries(assignments).map(async entry => {
      const [teamId, assignment] = entry
      if (assignment.discord_role?.id) {
        const userInTeam = userWithRoles.filter(u => u.roles.includes(assignment.discord_role?.id || ""))
        if (userInTeam.length === 0) {
          await LeagueSettingsDB.removeAssignment(guildId, teamId)
          delete assignments[teamId].discord_user
        } else if (userInTeam.length === 1) {
          await LeagueSettingsDB.updateAssignmentUser(guildId, teamId, { id: userInTeam[0].id, id_type: DiscordIdType.USER })
          assignments[teamId].discord_user = { id: userInTeam[0].id, id_type: DiscordIdType.USER }
        }
      }
    }))
    const message = await fetchTeamsMessage(leagueSettings)
    try {
      await prodClient.editMessage(leagueSettings.commands.teams.channel, leagueSettings.commands.teams.messageId, message, [])
    } catch (e) {
      console.error(`❌ Failed to update teams message after role update for member ${member.id} in guild ${guildId}:`, e)
    }
  }
});

const validReactions = ["🏆", "⏭️"];

function getRandomInt(max: number) {
  return Math.floor(Math.random() * max);
}


discordClient.on("messageReactionAdd", async (msg, reactor, reaction) => {
  // don't respond when bots react!
  if (reactor.id === prodClient.getBotUser().id) {
    return
  }
  const guild = msg.guildID
  if (!guild) {
    return
  }
  if (!validReactions.includes(reaction.emoji.name)) {
    return
  }
  const reactionChannel = msg.channelID
  const reactionMessage = msg.id
  const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild)
  const weeklyStates = leagueSettings.commands?.game_channel?.weekly_states || {}
  await Promise.all(Object.values(weeklyStates).map(async weeklyState => {
    const channelStates = weeklyState.channel_states || {}
    await Promise.all(Object.entries(channelStates).map(async channelEntry => {
      const [channelId, channelState] = channelEntry
      if (channelId === reactionChannel && channelState?.message?.id === reactionMessage) {
        try {
          const notifier = createNotifier(prodClient, guild, leagueSettings)
          // wait for users to confirm/unconfirm
          const jitter = getRandomInt(10)
          await new Promise((r) => setTimeout(r, 5000 + jitter * 1000));
          await notifier.update(channelState, weeklyState.seasonIndex, weeklyState.week)
        } catch (e) {
        }
      }
    }))
  }))
})
if (process.env.NO_CLIENT !== "true") {
  discordClient.connect()
  // Start the auto-post scheduler
  startAutoPostScheduler(prodClient)
}


export default router
