import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage } from "../discord_utils"
import { APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import LeagueSettingsDB from "../settings_db"
import MaddenClient from "../../db/madden_db"
import { MADDEN_SEASON } from "../../export/madden_league_types"

async function exportScheduleAsJson(token: string, client: DiscordClient, league: string, week?: number) {
  try {
    let schedule;
    let weekNumber;
    let seasonIndex;

    if (week) {
      schedule = await MaddenClient.getLatestWeekSchedule(league, week);
      weekNumber = week;
      seasonIndex = schedule[0]?.seasonIndex ?? 0;
    } else {
      schedule = await MaddenClient.getLatestSchedule(league);
      weekNumber = schedule[0] ? schedule[0].weekIndex + 1 : 1;
      seasonIndex = schedule[0]?.seasonIndex ?? 0;
    }

    const teams = await MaddenClient.getLatestTeams(league);

    // Filter out games with invalid team references and enrich with team data
    const validGames = [];
    for (const game of schedule) {
      try {
        const awayTeam = teams.getTeamForId(game.awayTeamId);
        const homeTeam = teams.getTeamForId(game.homeTeamId);

        validGames.push({
          scheduleId: game.scheduleId,
          weekIndex: game.weekIndex,
          week: game.weekIndex + 1,
          seasonIndex: game.seasonIndex,
          season: MADDEN_SEASON + game.seasonIndex,
          stageIndex: game.stageIndex,
          awayTeam: {
            teamId: awayTeam.teamId,
            displayName: awayTeam.displayName,
            cityName: awayTeam.cityName,
            nickName: awayTeam.nickName,
            abbrName: awayTeam.abbrName,
            userName: awayTeam.userName
          },
          homeTeam: {
            teamId: homeTeam.teamId,
            displayName: homeTeam.displayName,
            cityName: homeTeam.cityName,
            nickName: homeTeam.nickName,
            abbrName: homeTeam.abbrName,
            userName: homeTeam.userName
          },
          awayScore: game.awayScore,
          homeScore: game.homeScore,
          status: game.status,
          isPlayoffGame: game.weekIndex >= 18,
          isGameOfTheWeek: game.isGameOfTheWeek
        });
      } catch (e) {
        console.warn(`Skipping game with invalid team references: scheduleId=${game.scheduleId}`);
      }
    }

    const exportData = {
      leagueId: league,
      week: weekNumber,
      season: MADDEN_SEASON + seasonIndex,
      weekIndex: weekNumber - 1,
      seasonIndex: seasonIndex,
      gamesCount: validGames.length,
      games: validGames
    };

    const jsonString = JSON.stringify(exportData, null, 2);

    // Discord has a 2000 character limit, so we'll create a file attachment
    const buffer = Buffer.from(jsonString, 'utf-8');
    const filename = `schedule_week${weekNumber}_season${MADDEN_SEASON + seasonIndex}.json`;

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `# Schedule Export\n\n**Week ${weekNumber}** | **Season ${MADDEN_SEASON + seasonIndex}**\n**Games:** ${validGames.length}\n\nDownload the JSON file attached to use with external tools.`
        }
      ],
      attachments: [{
        id: "0",
        filename: filename,
        description: `Schedule data for Week ${weekNumber}, Season ${MADDEN_SEASON + seasonIndex}`
      }],
      files: [{
        name: filename,
        file: buffer
      }]
    });

  } catch (e) {
    console.error(e);
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to export schedule: ${e}`
        }
      ]
    });
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id } = command;

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id);
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first");
    }
    const league = leagueSettings.commands.madden_league.league_id;

    if (!command.data.options) {
      throw new Error("schedule_export command not defined properly");
    }

    const options = command.data.options;
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption;

    if (subCommand.name === "week") {
      const week = (subCommand.options?.[0] as APIApplicationCommandInteractionDataIntegerOption)?.value;
      if (week != null && (Number(week) < 1 || Number(week) > 23 || week === 22)) {
        throw new Error("Invalid week number. Valid weeks are week 1-18 and for playoffs: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23");
      }
      exportScheduleAsJson(command.token, client, league, week ? Number(week) : undefined);
      respond(ctx, deferMessage());
    } else if (subCommand.name === "current") {
      exportScheduleAsJson(command.token, client, league);
      respond(ctx, deferMessage());
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "scheduleexport",
      description: "Export schedule data as JSON for use with external tools",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "current",
          description: "Export the current week's schedule",
          options: []
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "week",
          description: "Export a specific week's schedule",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "week",
              description: "Week number to export (1-18 regular season, 19-23 playoffs)",
              required: true
            }
          ]
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler
