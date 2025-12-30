import { Firestore } from "firebase-admin/firestore";
import { APIMessageComponentInteractionData } from "discord-api-types/v9";

import { ParameterizedContext } from "koa";
import {
  APIChatInputApplicationCommandInteractionData,
  APIInteractionGuildMember,
} from "discord-api-types/payloads";
import {
  APIAutocompleteApplicationCommandInteractionData,
  InteractionResponseType,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import {
  createMessageResponse,
  respond,
  DiscordClient,
  CommandMode,
  SnallabotDiscordError,
  NoConnectedLeagueError,
} from "./discord_utils";

import leagueExportHandler from "./commands/league_export";
import dashboardHandler from "./commands/dashboard";
import loggerHandler from "./commands/logger";
import waitlistHandler from "./commands/waitlist";
import broadcastsHandler from "./commands/broadcasts";
import streamsHandler from "./commands/streams";
import teamsHandler from "./commands/teams";
import schedulesHandler from "./commands/schedule";
import scheduleExportHandler from "./commands/schedule_export";
import gameChannelHandler from "./commands/game_channels";
import exportHandler from "./commands/export";
import standingsHandler from "./commands/standings";
import playerHandler from "./commands/player";
import gameStatsHandler from "./commands/game_stats";
import bracketHandler from "./commands/bracket";
import simsHandler from "./commands/sims";
import postGameHandler from "./commands/post_game";
import postLeadersHandler from "./commands/post_leaders";
import helpHandler from "./commands/help";
import leadersHandler from "./commands/leaders";
import teamScheduleHandler from "./commands/team_schedule";
import draftHandler from "./commands/draft";
import progressionHandler from "./commands/progression";
import powerrankingsHandler from "./commands/powerrankings";
import rosterrankingsHandler from "./commands/rosterrankings";
import gamerecapHandler from "./commands/gamerecap";
import playerrankingsHandler from "./commands/playerrankings";
import predictionsHandler from "./commands/predictions";
import gotwHandler from "./commands/gotw";
import pickemHandler from "./commands/pickem";
import pickemLeaderboardHandler from "./commands/pickem_leaderboard";
import teamStatsHandler from "./commands/team_stats";
import awardsHandler from "./commands/awards";
import transactionsHandler from "./commands/transactions";
import stateoftheleagueHandler from "./commands/stateoftheleague";
import farecapHandler from "./commands/farecap";
import teamreportHandler from "./commands/teamreport";
import autopostHandler from "./commands/autopost";



export type Command = {
  command_name: string;
  token: string;
  guild_id: string;
  channel_id: string;
  data: APIChatInputApplicationCommandInteractionData;
  member: APIInteractionGuildMember;
};
export type Autocomplete = {
  command_name: string;
  token: string;
  guild_id: string;
  data: APIAutocompleteApplicationCommandInteractionData;
};
export type MessageComponentInteraction = {
  custom_id: string;
  token: string;
  data: APIMessageComponentInteractionData;
  guild_id: string;
  member?: APIInteractionGuildMember;  // Added for user info access
};

export interface CommandHandler {
  handleCommand(
    command: Command,
    client: DiscordClient,
    db: Firestore,
    ctx: ParameterizedContext
  ): Promise<void>;
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody;
}

export interface AutocompleteHandler {
  choices(query: Autocomplete): Promise<{ name: string; value: string }[]>;
}
export interface MessageComponentHandler {
  handleInteraction(
    interaction: MessageComponentInteraction,
    client: DiscordClient
  ): Promise<any>;
}

export type CommandsHandler = { [key: string]: CommandHandler | undefined };
export type AutocompleteHandlers = Record<string, AutocompleteHandler>;
export type MessageComponentHandlers = Record<string, MessageComponentHandler>;

const SlashCommands: CommandsHandler = {
  league_export: leagueExportHandler,
  dashboard: dashboardHandler,
  game_channels: gameChannelHandler,
  teams: teamsHandler,
  streams: streamsHandler,
  broadcasts: broadcastsHandler,
  waitlist: waitlistHandler,
  schedule: schedulesHandler,
  scheduleexport: scheduleExportHandler,
  logger: loggerHandler,
  export: exportHandler,
  standings: standingsHandler,
  player: playerHandler,
  playoffs: bracketHandler,
  sims: simsHandler,
  postgame: postGameHandler,
  postleaders: postLeadersHandler,
  help: helpHandler,
  leaders: leadersHandler,
  teamschedule: teamScheduleHandler,
  draft: draftHandler,
  progression: progressionHandler,
  powerrankings: powerrankingsHandler,
  rosterrankings: rosterrankingsHandler,
  gamerecap: gamerecapHandler,
  playerrankings: playerrankingsHandler,
  predictions: predictionsHandler,
  gotw: gotwHandler,
  pickem: pickemHandler,
  pickem_leaderboard: pickemLeaderboardHandler,
  teamstats: teamStatsHandler,
  awards: awardsHandler,
  transactions: transactionsHandler,
  stateoftheleague: stateoftheleagueHandler,
  farecap: farecapHandler,
  teamreport: teamreportHandler,
  autopost: autopostHandler,
};

const AutocompleteCommands: AutocompleteHandlers = {
  teams: teamsHandler as any,
  player: playerHandler as any,
  schedule: schedulesHandler as any,
  teamschedule: teamScheduleHandler as any,
  draft: draftHandler as any,
  awards: awardsHandler as any,
};

const MessageComponents: MessageComponentHandlers = {
  player_card: playerHandler as any,
  week_selector: schedulesHandler as any,
  season_selector: schedulesHandler as any,
  team_season_selector: schedulesHandler as any,
  game_stats: gameStatsHandler as any,
  standings_filter: standingsHandler as any,
  sims_season_selector: simsHandler as any,
  gamerecap_week_selector: gamerecapHandler as any,
  gamerecap_game_selector: gamerecapHandler as any,
  gamerecap_analyst_selector: gamerecapHandler as any,
  powerrankings_range: powerrankingsHandler as any,
  rosterrankings_range: rosterrankingsHandler as any,
};

export async function handleCommand(
  command: Command,
  ctx: ParameterizedContext,
  discordClient: DiscordClient,
  db: Firestore
) {
  const commandName = command.command_name;
  const handler = SlashCommands[commandName];
  if (handler) {
    try {
      await handler.handleCommand(command, discordClient, db, ctx);
    } catch (e) {
      const error = e as Error;
      ctx.status = 200;
      if (error instanceof SnallabotDiscordError) {
        respond(
          ctx,
          createMessageResponse(
            `Discord Error in ${commandName}: ${error.message} Guidance: ${error.guidance}`
          )
        );
      } else if (error instanceof NoConnectedLeagueError) {
        respond(ctx, createMessageResponse(error.message));
      } else {
        respond(
          ctx,
          createMessageResponse(`Fatal Error in ${commandName}: ${error.message}`)
        );
      }
    }
  } else {
    ctx.status = 200;
    respond(ctx, createMessageResponse(`command ${commandName} not implemented`));
  }
}

export async function handleAutocomplete(
  command: Autocomplete,
  ctx: ParameterizedContext
) {
  const commandName = command.command_name;
  const handler = AutocompleteCommands[commandName];
  if (handler) {
    try {
      const choices = await handler.choices(command);
      ctx.status = 200;
      ctx.set("Content-Type", "application/json");
      ctx.body = {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices },
      };
    } catch (e) {
      console.error(`❌ Autocomplete error for command ${commandName}:`, e);
      ctx.status = 200;
      ctx.set("Content-Type", "application/json");
      ctx.body = {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [] },
      };
    }
  } else {
    ctx.status = 200;
    ctx.set("Content-Type", "application/json");
    ctx.body = {
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [] },
    };
  }
}

export async function handleMessageComponent(
  interaction: MessageComponentInteraction,
  ctx: ParameterizedContext,
  client: DiscordClient
) {
  const custom_id = interaction.custom_id;
  // Log interaction type without full custom_id to prevent log injection
  console.log(`🔘 Message component interaction received (length=${custom_id?.length || 0})`)
  const handler = MessageComponents[custom_id];
  if (handler) {
    try {
      const body = await handler.handleInteraction(interaction, client);
      ctx.status = 200;
      ctx.set("Content-Type", "application/json");
      ctx.body = body;
    } catch (e) {
      const error = e as Error;
      console.error(`❌ Message component error for ${custom_id}:`, error);
      ctx.status = 500;
      ctx.body = { error: "Failed to handle interaction" };
    }
  } else {
    try {
      const parsedCustomId = JSON.parse(custom_id);
      if (parsedCustomId.q != null) {
        const body = await (playerHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.t != null) {
        const body = await (broadcastsHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.p != null && parsedCustomId.si != null) {
        const body = await (simsHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.si != null) {
        const body = await (schedulesHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.f != null) {
        const body = await (standingsHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.action === 'pickem_select' || parsedCustomId.action === 'pickem_page' || parsedCustomId.a === 'ps' || parsedCustomId.a === 'pp') {
        // Handle both old (action=pickem_*) and new shortened (a=ps/pp) formats
        const body = await (pickemHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else if (parsedCustomId.pr != null) {
        console.log(`🔄 Routing to playerrankings handler for pr=${parsedCustomId.pr}`)
        const body = await (playerrankingsHandler as any).handleInteraction(interaction, client);
        ctx.status = 200;
        ctx.set("Content-Type", "application/json");
        ctx.body = body;
      } else {
        console.warn(`⚠️ Unknown custom_id format (length=${custom_id?.length || 0})`);
        ctx.status = 400;
        ctx.set("Content-Type", "application/json");
        ctx.body = { error: "Unknown interaction format" };
      }
    } catch (e) {
      // Don't log full custom_id to avoid log injection - just log length
      console.error(`❌ Error parsing custom_id (length=${custom_id?.length || 0}):`, e);
      ctx.status = 400;
      ctx.set("Content-Type", "application/json");
      ctx.body = { error: "Invalid interaction format" };
    }
  }
}

export async function commandsInstaller(
  client: DiscordClient,
  commandNames: string[],
  mode: CommandMode,
  guildId?: string
) {
  const commandsToHandle =
    commandNames.length === 0 ? Object.keys(SlashCommands) : commandNames;
  await Promise.all(
    commandsToHandle.map(async (name) => {
      const handler = SlashCommands[name];
      if (handler) {
        await client.handleSlashCommand(mode, handler.commandDefinition(), guildId);
        console.log(`${mode} ${name}`);
      }
    })
  );
}
