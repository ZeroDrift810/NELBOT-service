import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, createMessageResponse, DiscordClient } from "../discord_utils"
import { ApplicationCommandType, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"

const HELP_SECTIONS = {
  stats: {
    title: "📊 Statistics & Data Commands",
    description: "View league, team, and player statistics from Madden",
    commands: [
      {
        name: "/standings [filter]",
        description: "View league standings with detailed team stats",
        usage: "Filter by: NFL, AFC, NFC, or specific divisions (AFC_NORTH, NFC_SOUTH, etc.)",
        why: "Track team rankings, records, and performance metrics throughout the season"
      },
      {
        name: "/schedule [week] [season]",
        description: "Display weekly game schedules with scores and results",
        usage: "Optionally specify week number (1-23) and season. Click games to view detailed stats",
        why: "See upcoming matchups, completed game scores, and identify simmed games"
      },
      {
        name: "/player [name]",
        description: "Search for any player and view their complete card",
        usage: "Type player name (fuzzy search supported). View ratings, stats, and attributes",
        why: "Scout players, compare ratings, track weekly/season statistics"
      },
      {
        name: "/sims [season]",
        description: "View complete history of simmed games",
        usage: "Shows all force wins and fair sims with requesting users",
        why: "Track which games were simmed and understand league sim patterns"
      },
      {
        name: "/playoffs [season]",
        description: "Generate visual playoff bracket with team logos and scores",
        usage: "Shows complete playoff picture including wildcard, divisional, championship, and Super Bowl",
        why: "Visualize playoff matchups and track postseason progression"
      },
      {
        name: "/leaders [week] [season] [category]",
        description: "View weekly stat leaders in all categories",
        usage: "Filter by passing, rushing, receiving, defense, or kicking. Defaults to current week and all categories",
        why: "Identify top performers for any given week across different stat categories"
      },
      {
        name: "/team_schedule [team] [season]",
        description: "View complete schedule for a specific team",
        usage: "Search by team name or abbreviation. Shows all games with results and upcoming matchups",
        why: "Track a team's season progression, wins/losses, and remaining schedule"
      }
    ]
  },
  gameManagement: {
    title: "🏈 Game Channel Management",
    description: "Automated game scheduling and channel management",
    commands: [
      {
        name: "/game_channels create [week]",
        description: "Create dedicated channels for all games in a week",
        usage: "Specify week 1-18 for regular season. Auto-posts matchup info and league rules",
        why: "Organize game scheduling and communication between opponents"
      },
      {
        name: "/game_channels wildcard",
        description: "Create channels for wildcard playoff round",
        usage: "Auto-creates channels for all wildcard matchups",
        why: "Manage playoff game scheduling and communication"
      },
      {
        name: "/game_channels divisional",
        description: "Create channels for divisional playoff round",
        usage: "Auto-creates channels for divisional round games",
        why: "Continue playoff organization into divisional round"
      },
      {
        name: "/game_channels conference",
        description: "Create channels for conference championship games",
        usage: "Auto-creates AFC and NFC championship game channels",
        why: "Manage conference championship matchups"
      },
      {
        name: "/game_channels superbowl",
        description: "Create channel for Super Bowl",
        usage: "Creates the championship game channel",
        why: "Organize the final game of the season"
      },
      {
        name: "/game_channels clear [week]",
        description: "Remove game channels",
        usage: "Optionally specify week to clear. Logs channels if configured",
        why: "Clean up completed game channels"
      },
      {
        name: "/game_channels notify",
        description: "Manually trigger notifications for unscheduled games",
        usage: "Pings all game channels that haven't been marked as scheduled",
        why: "Remind players to schedule their games"
      }
    ]
  },
  dataSync: {
    title: "🔄 Data Export & Sync",
    description: "Sync data from EA Sports Madden servers",
    commands: [
      {
        name: "/export week [week]",
        description: "Export specific week's data from Madden",
        usage: "Week 1-18 for regular season, 19-21 and 23 for playoffs",
        why: "Update bot with latest game results, stats, and rosters"
      },
      {
        name: "/export current",
        description: "Export the current week's data",
        usage: "Automatically detects and exports current week",
        why: "Quick update of the most recent week"
      },
      {
        name: "/export all",
        description: "Export all weeks in the season",
        usage: "Full data refresh for entire season",
        why: "Initial setup or complete data refresh"
      }
    ]
  },
  apSystem: {
    title: "💰 AP (Advancement Points) System",
    description: "League currency and rewards management",
    commands: [
      {
        name: "/ap balance [@user]",
        description: "Check AP balance for yourself or another user",
        usage: "Mention user or leave blank for your own balance",
        why: "Track accumulated advancement points"
      },
      {
        name: "/ap grant [@user] [amount] [reason]",
        description: "Award AP to a user (Admin only)",
        usage: "Specify user, amount, and reason for transaction log",
        why: "Reward players for achievements, wins, or participation"
      },
      {
        name: "/ap deduct [@user] [amount] [reason]",
        description: "Remove AP from a user (Admin only)",
        usage: "Specify user, amount, and reason for penalty",
        why: "Handle rule violations or AP purchases"
      },
      {
        name: "/ap set [@user] [amount] [reason]",
        description: "Set exact AP balance (Admin only)",
        usage: "Override balance to specific amount",
        why: "Correct errors or make major balance adjustments"
      },
      {
        name: "/ap history [@user]",
        description: "View complete AP transaction history",
        usage: "See all grants, deductions, and purchases",
        why: "Audit AP activity and track earning/spending patterns"
      },
      {
        name: "/ap prices [category]",
        description: "View AP price list and available purchases",
        usage: "Filter by category: Training, Gear, Roster, Special",
        why: "See what can be purchased with AP and costs"
      }
    ]
  },
  // AP System removed - handled by separate bot
  content: {
    title: "📢 Content & Broadcasting",
    description: "Post game results and stream integration",
    commands: [
      {
        name: "/postgame [week]",
        description: "Post formatted game results to designated channel",
        usage: "Specify week number to post all game scores",
        why: "Share weekly results with the league"
      },
      {
        name: "/postleaders [week]",
        description: "Generate and post weekly stat leaders",
        usage: "Shows top performers in passing, rushing, receiving, defense",
        why: "Highlight top players and celebrate achievements"
      },
      {
        name: "/streams configure",
        description: "Set up Twitch stream notifications",
        usage: "Link Twitch accounts and configure notification channel",
        why: "Auto-post when league members go live streaming games"
      },
      {
        name: "/broadcasts configure",
        description: "Set up broadcast notification channel",
        usage: "Designate channel for league announcements",
        why: "Centralize important league broadcasts and updates"
      },
      {
        name: "/schedule_export configure",
        description: "Auto-post weekly schedules",
        usage: "Configure automatic schedule posting to a channel",
        why: "Keep league informed of upcoming games automatically"
      }
    ]
  },
  setup: {
    title: "⚙️ Setup & Configuration (Admin)",
    description: "Initial bot setup and league configuration",
    commands: [
      {
        name: "/teams configure",
        description: "Set up team assignment system",
        usage: "Choose user-based or role-based team assignments",
        why: "Link Discord users to their Madden teams"
      },
      {
        name: "/teams assign",
        description: "Assign users to specific teams",
        usage: "Match Discord members with their in-game teams",
        why: "Enable @mentions in game channels and track ownership"
      },
      {
        name: "/teams customize_logo",
        description: "Upload custom team logo emoji",
        usage: "Upload PNG image to replace default team emoji",
        why: "Personalize team branding throughout the bot"
      },
      {
        name: "/game_channels configure",
        description: "Configure game channel automation",
        usage: "Set category, scoreboard channel, notification timing, admin role, privacy",
        why: "Enable automated game channel creation and management"
      },
      {
        name: "/logger configure",
        description: "Set up game channel logging",
        usage: "Configure channel archiving instead of deletion",
        why: "Preserve game channel history and conversations"
      },
      {
        name: "/dashboard",
        description: "Get your league's web dashboard URL",
        usage: "Returns link to connect EA account and manage settings",
        why: "Access web interface for advanced configuration"
      }
    ]
  },
  utility: {
    title: "🛠️ Utility Commands",
    description: "Additional helpful tools",
    commands: [
      {
        name: "/waitlist",
        description: "Manage league waitlist",
        usage: "Add/remove users from waiting list for league spots",
        why: "Track interested players when league is full"
      }
    ]
  }
}

function generateHelpMessage(): string {
  let message = `# 🏈 NELBOT Command Guide\n\n`
  message += `Use these commands to interact with your Madden league data, manage games, and track statistics.\n\n`
  message += `**💡 Tip**: Most commands support autocomplete - start typing to see suggestions!\n\n`
  message += `---\n\n`

  // Filter out deprecated AP system
  const activeSections = Object.entries(HELP_SECTIONS).filter(([key]) => key !== 'apSystem')

  for (const [key, section] of activeSections) {
    message += `## ${section.title}\n`
    message += `*${section.description}*\n\n`

    for (const cmd of section.commands) {
      message += `### ${cmd.name}\n`
      message += `**What**: ${cmd.description}\n`
      message += `**How**: ${cmd.usage}\n`
      message += `**Why**: ${cmd.why}\n\n`
    }

    message += `---\n\n`
  }

  message += `## 🎮 Game Channel Reactions\n`
  message += `When in a game channel, use these reactions:\n`
  message += `• ⏰ - Mark game as scheduled\n`
  message += `• 🏆 - Game is finished (auto-closes channel)\n`
  message += `• 🏠 - Request home team force win\n`
  message += `• ✈️ - Request away team force win\n`
  message += `• ⏭️ - Confirm sim/force win (player + admin must both react)\n\n`
  message += `**Force Win Process**: Winning team reacts with 🏠 or ✈️, both players react ⏭️, admin reacts ⏭️ to confirm.\n`
  message += `**Fair Sim Process**: Both players react 🏠 and ✈️, both react ⏭️, admin reacts ⏭️ to confirm.\n\n`
  message += `---\n\n`

  message += `## 📱 Need More Help?\n`
  message += `• Use \`/dashboard\` to access the web interface\n`
  message += `• Contact your league admin for setup questions\n`
  message += `• Bot issues? Check the GitHub repository\n\n`

  message += `**🤖 Powered by Snallabot** | https://snallabot.me`

  return message
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    // Help message is too long for a single Discord message (2000 char limit)
    // So we'll provide a shorter overview
    const shortHelp = `# 🏈 NELBOT Quick Reference

**📊 View Stats**: \`/standings\`, \`/schedule\`, \`/player\`, \`/leaders\`, \`/teamschedule\`
**🏈 Game Channels**: \`/game_channels create [week]\` - Auto-create game channels
**🔄 Data Sync**: \`/export current\` - Update bot with latest Madden data
**📢 Content**: \`/postgame\`, \`/postleaders\` - Post results to channel
**⚙️ Setup**: \`/teams configure\`, \`/dashboard\` - Initial configuration

💡 **Tip**: Most commands support autocomplete - start typing to see options!

For detailed documentation, visit your dashboard: Use \`/dashboard\` to get your league's setup URL.`

    respond(ctx, createMessageResponse(shortHelp))
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "help",
      description: "View complete guide to all NELBOT commands and features",
      type: ApplicationCommandType.ChatInput
    }
  }
} as CommandHandler
