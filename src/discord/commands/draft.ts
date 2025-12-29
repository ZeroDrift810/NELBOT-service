import { ParameterizedContext } from "koa"
import { CommandHandler, Command, AutocompleteHandler, Autocomplete } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji, createMessageResponse, getDevTraitEmoji } from "../discord_utils"
import { APIApplicationCommandInteractionDataChannelOption, APIApplicationCommandInteractionDataIntegerOption, APIApplicationCommandInteractionDataStringOption, APIApplicationCommandInteractionDataSubcommandOption, ApplicationCommandOptionType, ApplicationCommandType, ChannelType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { PlayerStatType } from "../../db/madden_db"
import LeagueSettingsDB, { DiscordIdType, DraftConfiguration } from "../settings_db"
import { discordLeagueView, leagueLogosView, teamSearchView } from "../../db/view"
import { Player, MADDEN_SEASON, PassingStats, RushingStats, ReceivingStats, DefensiveStats, DevTrait } from "../../export/madden_league_types"
import fuzzysort from "fuzzysort"

const MADDEN_PORTRAIT_CDN = "https://ratings-images-prod.pulse.ea.com/madden-nfl-26/portraits"

function getPlayerPortraitUrl(portraitId: number): string {
  return `${MADDEN_PORTRAIT_CDN}/${portraitId}.png`
}

type RookieStatEntry = {
  player: Player
  rosterId: number
  teamId: number
  fullName: string
  passYds: number
  passTDs: number
  passInts: number
  passCompPct: number
  rushYds: number
  rushTDs: number
  rushAtt: number
  recYds: number
  recTDs: number
  recCatches: number
  defTotalTackles: number
  defSacks: number
  defInts: number
  defForcedFum: number
}

type TopPerformer = {
  category: string
  name: string
  teamEmoji: string
  statLine: string
  rosterId: number
  portraitId?: number
}

const OL_POSITIONS = ['LT', 'LG', 'C', 'RG', 'RT']

// Helper to check if draft data is valid
function hasValidDraftData(player: Player): boolean {
  // Valid draft: round 1-7, pick 1-262 (max picks in 7-round draft with comp picks)
  return player.draftRound >= 1 && player.draftRound <= 7 &&
         player.draftPick >= 1 && player.draftPick <= 262
}

// Show a draft class with performance stats (playerrankings style)
async function showDraftClass(token: string, client: DiscordClient, league: string, yearsAgo: number = 0, targetChannel?: string) {
  try {
    console.log(`📋 showDraftClass called: league=${league}, yearsAgo=${yearsAgo}, targetChannel=${targetChannel || 'none'}`)

    const [allPlayers, teams, logos, weeks] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league)
    ])

    // Find the most recent draft class
    const playersWithDraftData = allPlayers.filter(p => p.draftRound >= 1 && p.draftRound <= 7)
    const maxRookieYear = Math.max(...playersWithDraftData.map(p => p.rookieYear))
    const targetRookieYear = maxRookieYear - yearsAgo
    const draftClass = playersWithDraftData.filter(p => p.rookieYear === targetRookieYear)
    // rookieYear is the actual calendar year (e.g., 2028), not a season index
    const draftYear = targetRookieYear

    console.log(`📋 Found ${draftClass.length} players in ${draftYear} draft class`)

    if (draftClass.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{ type: ComponentType.TextDisplay, content: `# ${draftYear} Draft Class\n\nNo players found.` }]
      })
      return
    }

    // Get current season for stats
    const currentSeasonIndex = weeks.length > 0 ? Math.max(...weeks.map(w => w.seasonIndex)) : 0
    const displaySeason = `${MADDEN_SEASON + currentSeasonIndex}`

    // Fetch stats for ALL rookies (not just top by OVR)
    console.log(`📋 Fetching stats for ${draftClass.length} rookies...`)
    const rookieStats: RookieStatEntry[] = []

    await Promise.all(draftClass.map(async (player) => {
      try {
        const stats = await MaddenDB.getPlayerStats(league, player)
        const entry: RookieStatEntry = {
          player,
          rosterId: player.rosterId,
          teamId: player.teamId,
          fullName: `${player.firstName} ${player.lastName}`,
          passYds: 0, passTDs: 0, passInts: 0, passCompPct: 0,
          rushYds: 0, rushTDs: 0, rushAtt: 0,
          recYds: 0, recTDs: 0, recCatches: 0,
          defTotalTackles: 0, defSacks: 0, defInts: 0, defForcedFum: 0
        }

        // Passing
        const passStats = (stats[PlayerStatType.PASSING] || []) as PassingStats[]
        const seasonPassing = passStats.filter(s => s.seasonIndex === currentSeasonIndex)
        let totalComp = 0, totalAtt = 0
        for (const s of seasonPassing) {
          entry.passYds += s.passYds
          entry.passTDs += s.passTDs
          entry.passInts += s.passInts
          totalComp += s.passComp
          totalAtt += s.passAtt
        }
        entry.passCompPct = totalAtt > 0 ? (totalComp / totalAtt) * 100 : 0

        // Rushing
        const rushStats = (stats[PlayerStatType.RUSHING] || []) as RushingStats[]
        for (const s of rushStats.filter(s => s.seasonIndex === currentSeasonIndex)) {
          entry.rushYds += s.rushYds
          entry.rushTDs += s.rushTDs
          entry.rushAtt += s.rushAtt
        }

        // Receiving
        const recStats = (stats[PlayerStatType.RECEIVING] || []) as ReceivingStats[]
        for (const s of recStats.filter(s => s.seasonIndex === currentSeasonIndex)) {
          entry.recYds += s.recYds
          entry.recTDs += s.recTDs
          entry.recCatches += s.recCatches
        }

        // Defense
        const defStats = (stats[PlayerStatType.DEFENSE] || []) as DefensiveStats[]
        for (const s of defStats.filter(s => s.seasonIndex === currentSeasonIndex)) {
          entry.defTotalTackles += s.defTotalTackles
          entry.defSacks += s.defSacks
          entry.defInts += s.defInts
          entry.defForcedFum += s.defForcedFum
        }

        rookieStats.push(entry)
      } catch (e) {
        // Skip players with errors
      }
    }))

    console.log(`📋 Got stats for ${rookieStats.length} rookies`)

    // Build category leaders - relaxed thresholds to show leaders even with minimal stats
    const topQBs = rookieStats.filter(s => s.passYds > 0 || s.player.position === 'QB').sort((a, b) => b.passYds - a.passYds).slice(0, 5)
    const topRBs = rookieStats.filter(s => s.rushYds > 0 || ['HB', 'FB'].includes(s.player.position)).sort((a, b) => b.rushYds - a.rushYds).slice(0, 5)
    const topReceivers = rookieStats.filter(s => s.recYds > 0 || ['WR', 'TE'].includes(s.player.position)).sort((a, b) => b.recYds - a.recYds).slice(0, 5)
    const topTacklers = rookieStats.filter(s => s.defTotalTackles > 0).sort((a, b) => b.defTotalTackles - a.defTotalTackles).slice(0, 5)
    const topSackers = rookieStats.filter(s => s.defSacks > 0).sort((a, b) => b.defSacks - a.defSacks).slice(0, 5)
    const topDBs = rookieStats.filter(s => s.defInts > 0).sort((a, b) => b.defInts - a.defInts).slice(0, 5)

    // Get OL players sorted by OVR
    const olPlayers = draftClass.filter(p => OL_POSITIONS.includes(p.position)).sort((a, b) => b.playerBestOvr - a.playerBestOvr).slice(0, 5)

    // Fetch portraits for #1 in each category
    const leaderRosterIds: number[] = []
    if (topQBs[0]) leaderRosterIds.push(topQBs[0].rosterId)
    if (topRBs[0]) leaderRosterIds.push(topRBs[0].rosterId)
    if (topReceivers[0]) leaderRosterIds.push(topReceivers[0].rosterId)
    if (topTacklers[0]) leaderRosterIds.push(topTacklers[0].rosterId)
    if (topSackers[0]) leaderRosterIds.push(topSackers[0].rosterId)
    if (topDBs[0]) leaderRosterIds.push(topDBs[0].rosterId)

    const playerCards = new Map<number, Player>()
    await Promise.all(leaderRosterIds.map(async (rosterId) => {
      try {
        const player = await MaddenDB.getPlayer(league, `${rosterId}`)
        if (player) playerCards.set(rosterId, player)
      } catch (e) {}
    }))

    // Build category leaders with portraits
    const categoryLeaders: TopPerformer[] = []

    // Helper to safely get team
    const getTeamSafe = (teamId: number) => teamId !== 0 ? teams.getTeamForId(teamId) : null

    if (topQBs[0]) {
      const stat = topQBs[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      categoryLeaders.push({
        category: "🎯 PASSING LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.passYds} YDS | ${stat.passTDs} TD | ${stat.passInts} INT | ${stat.passCompPct.toFixed(1)}%`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    if (topRBs[0]) {
      const stat = topRBs[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      const ypc = stat.rushAtt > 0 ? (stat.rushYds / stat.rushAtt).toFixed(1) : '0'
      categoryLeaders.push({
        category: "🏃🏾 RUSHING LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.rushYds} YDS | ${stat.rushTDs} TD | ${stat.rushAtt} ATT | ${ypc} YPC`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    if (topReceivers[0]) {
      const stat = topReceivers[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      const ypc = stat.recCatches > 0 ? (stat.recYds / stat.recCatches).toFixed(1) : '0'
      categoryLeaders.push({
        category: "🙌🏾 RECEIVING LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.recYds} YDS | ${stat.recTDs} TD | ${stat.recCatches} REC | ${ypc} YPC`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    if (topTacklers[0]) {
      const stat = topTacklers[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      categoryLeaders.push({
        category: "🛡️ TACKLE LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.defTotalTackles} TKL | ${stat.defSacks} SK | ${stat.defInts} INT`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    if (topSackers[0]) {
      const stat = topSackers[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      categoryLeaders.push({
        category: "💥 SACK LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.defSacks} SK | ${stat.defTotalTackles} TKL | ${stat.defForcedFum} FF`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    if (topDBs[0]) {
      const stat = topDBs[0]
      const team = getTeamSafe(stat.teamId)
      const player = playerCards.get(stat.rosterId)
      categoryLeaders.push({
        category: "🦅 INTERCEPTION LEADER",
        name: stat.fullName,
        teamEmoji: team ? formatTeamEmoji(logos, team.abbrName) : '🏈',
        statLine: `${stat.defInts} INT | ${stat.defTotalTackles} TKL`,
        rosterId: stat.rosterId,
        portraitId: player?.portraitId
      })
    }

    // Build components array
    // Rookie Class number: Season 3 rookies = Class 1, Season 4 rookies = Class 2, etc.
    const rookieClassNumber = currentSeasonIndex - 1 - yearsAgo
    const classLabel = rookieClassNumber > 0 ? `Rookie Class ${rookieClassNumber}` : 'Rookie Class'
    const components: any[] = [
      {
        type: ComponentType.TextDisplay,
        content: `# 🏈 NEL ${classLabel} Top Performers\n*${draftYear} Draft • Stats from Season ${MADDEN_SEASON + currentSeasonIndex}*`
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small
      }
    ]

    // Add category leaders with portraits
    for (const leader of categoryLeaders) {
      components.push({
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `### ${leader.category}\n${leader.teamEmoji} **${leader.name}**\n${leader.statLine}`
          }
        ],
        accessory: leader.portraitId ? {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(leader.portraitId)
          }
        } : undefined
      })
    }

    components.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    })

    // Build rest of rankings as text (#2-5 for each category)
    let message = ""

    // If we have stat leaders, show Full Rankings
    const hasAnyStats = categoryLeaders.length > 0
    if (hasAnyStats) {
      message += "### Full Rankings\n"

      if (topQBs.length > 1) {
        message += `**Passing:** `
        message += topQBs.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.passYds})`
        }).join(" • ") + `\n`
      }

      if (topRBs.length > 1) {
        message += `**Rushing:** `
        message += topRBs.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.rushYds})`
        }).join(" • ") + `\n`
      }

      if (topReceivers.length > 1) {
        message += `**Receiving:** `
        message += topReceivers.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.recYds})`
        }).join(" • ") + `\n`
      }

      if (topTacklers.length > 1) {
        message += `**Tackles:** `
        message += topTacklers.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.defTotalTackles})`
        }).join(" • ") + `\n`
      }

      if (topSackers.length > 1) {
        message += `**Sacks:** `
        message += topSackers.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.defSacks})`
        }).join(" • ") + `\n`
      }

      if (topDBs.length > 1) {
        message += `**Interceptions:** `
        message += topDBs.slice(1).map((stat, idx) => {
          const team = getTeamSafe(stat.teamId)
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${idx + 2}. ${emoji} ${stat.fullName} (${stat.defInts})`
        }).join(" • ") + `\n`
      }
    } else {
      // No stats yet - show top players by OVR in each position group
      message += "### Top Rookies by Position (no game stats yet)\n"

      const qbPlayers = draftClass.filter(p => p.position === 'QB').sort((a, b) => b.playerBestOvr - a.playerBestOvr).slice(0, 3)
      if (qbPlayers.length > 0) {
        message += `**QB:** ${qbPlayers.map(p => {
          const team = p.teamId !== 0 ? teams.getTeamForId(p.teamId) : null
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${emoji} ${p.firstName} ${p.lastName} (${p.playerBestOvr})`
        }).join(" • ")}\n`
      }

      const rbPlayers = draftClass.filter(p => ['HB', 'FB'].includes(p.position)).sort((a, b) => b.playerBestOvr - a.playerBestOvr).slice(0, 3)
      if (rbPlayers.length > 0) {
        message += `**RB:** ${rbPlayers.map(p => {
          const team = p.teamId !== 0 ? teams.getTeamForId(p.teamId) : null
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${emoji} ${p.firstName} ${p.lastName} (${p.playerBestOvr})`
        }).join(" • ")}\n`
      }

      const wrPlayers = draftClass.filter(p => p.position === 'WR').sort((a, b) => b.playerBestOvr - a.playerBestOvr).slice(0, 3)
      if (wrPlayers.length > 0) {
        message += `**WR:** ${wrPlayers.map(p => {
          const team = p.teamId !== 0 ? teams.getTeamForId(p.teamId) : null
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${emoji} ${p.firstName} ${p.lastName} (${p.playerBestOvr})`
        }).join(" • ")}\n`
      }

      const defPlayers = draftClass.filter(p => ['LEDGE', 'REDGE', 'MLB', 'CB', 'FS', 'SS', 'DT'].includes(p.position)).sort((a, b) => b.playerBestOvr - a.playerBestOvr).slice(0, 3)
      if (defPlayers.length > 0) {
        message += `**DEF:** ${defPlayers.map(p => {
          const team = p.teamId !== 0 ? teams.getTeamForId(p.teamId) : null
          const emoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
          return `${emoji} ${p.position} ${p.firstName} ${p.lastName} (${p.playerBestOvr})`
        }).join(" • ")}\n`
      }
    }

    // Add OL section
    if (olPlayers.length > 0) {
      message += `\n### 🏗️ Top Offensive Linemen\n`
      olPlayers.forEach((player, idx) => {
        const team = player.teamId !== 0 ? teams.getTeamForId(player.teamId) : null
        const teamEmoji = team ? formatTeamEmoji(logos, team.abbrName) : '🏈'
        const devEmoji = getDevTraitEmoji(player.devTrait, player.yearsPro)
        message += `${idx + 1}. ${teamEmoji} ${player.position} **${player.firstName} ${player.lastName}** ${devEmoji} ${player.playerBestOvr} OVR\n`
      })
    }

    // Add footer
    message += `\n───────────────────────\n`
    message += `${classLabel} • ${draftClass.length} players`

    components.push({
      type: ComponentType.TextDisplay,
      content: message
    })

    // If target channel specified, post there and confirm; otherwise respond in place
    if (targetChannel) {
      await client.createMessageWithComponents(
        { id: targetChannel, id_type: DiscordIdType.CHANNEL },
        { flags: 32768, components }
      )
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [{ type: ComponentType.TextDisplay, content: `✅ Draft class posted to <#${targetChannel}>` }]
      })
    } else {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components
      })
    }

  } catch (e) {
    console.error("❌ Error in showDraftClass:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [{ type: ComponentType.TextDisplay, content: `Failed to show draft class: ${e}` }]
    })
  }
}

// Show draft history with filters
async function showDraftHistory(token: string, client: DiscordClient, league: string, round?: number, position?: string) {
  try {
    console.log(`📋 showDraftHistory called: league=${league}, round=${round}, position=${position}`)

    const [allPlayers, teams, logos] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league)
    ])

    // Filter for players with VALID draft data only
    let draftedPlayers = allPlayers.filter(p => hasValidDraftData(p))

    if (round) {
      draftedPlayers = draftedPlayers.filter(p => p.draftRound === round)
    }

    if (position) {
      draftedPlayers = draftedPlayers.filter(p => p.position.toUpperCase() === position.toUpperCase())
    }

    if (draftedPlayers.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# Draft History\n\nNo players found with valid draft data${round ? ` in round ${round}` : ''}${position ? ` at position ${position}` : ''}.`
          }
        ]
      })
      return
    }

    // Sort by years pro (most recent first), then by draft pick
    const sortedPlayers = draftedPlayers
      .sort((a, b) => {
        if (a.yearsPro !== b.yearsPro) return a.yearsPro - b.yearsPro // Fewer years = more recent
        return a.draftPick - b.draftPick
      })
      .slice(0, 25)

    let message = `# Draft History${round ? ` - Round ${round}` : ''}${position ? ` - ${position}` : ''}\n\n**Total with valid data:** ${draftedPlayers.length} players\n**Showing:** ${sortedPlayers.length}\n\n`

    sortedPlayers.forEach(player => {
      let team = null
      let teamEmoji = '🏈'
      let teamName = 'FA'

      if (player.teamId !== 0) {
        try {
          team = teams.getTeamForId(player.teamId)
          teamEmoji = formatTeamEmoji(logos, team.abbrName)
          teamName = team.abbrName
        } catch (e) {
          // Team not found, use FA defaults
        }
      }

      message += `**Rd ${player.draftRound} Pick ${player.draftPick}** - ${teamEmoji} ${teamName} - ${player.position} ${player.firstName} ${player.lastName} (${player.playerBestOvr} OVR, ${player.yearsPro} yrs)\n`
    })

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })
  } catch (e) {
    console.error("❌ Error in showDraftHistory:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show draft history: ${e}`
        }
      ]
    })
  }
}

// Show team's draft history
async function showTeamDraft(token: string, client: DiscordClient, league: string, teamSearchPhrase: string) {
  try {
    console.log(`📋 showTeamDraft called: league=${league}, team=${teamSearchPhrase}`)

    const [allPlayers, teams, logos, teamsToSearch] = await Promise.all([
      MaddenDB.getLatestPlayers(league),
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      teamSearchView.createView(league)
    ])

    // Find team
    if (!teamsToSearch) {
      throw new Error("No teams found in league")
    }

    const results = fuzzysort.go(teamSearchPhrase, Object.values(teamsToSearch), {
      keys: ["cityName", "abbrName", "nickName", "displayName"],
      threshold: 0.9
    })

    if (results.length < 1) {
      throw new Error(`Could not find team for phrase ${teamSearchPhrase}. Enter a team name, city, abbreviation, or nickname. Examples: Buccaneers, TB, Tampa Bay, Bucs`)
    } else if (results.length > 1) {
      throw new Error(`Found more than one team for phrase ${teamSearchPhrase}. Enter a team name, city, abbreviation, or nickname. Examples: Buccaneers, TB, Tampa Bay, Bucs. Found teams: ${results.map(t => t.obj.displayName).join(", ")}`)
    }

    const foundTeam = results[0].obj
    const team = teams.getTeamForId(foundTeam.id)
    const teamEmoji = formatTeamEmoji(logos, team.abbrName)

    // Get team's drafted players with VALID draft data only
    const teamDraftPicks = allPlayers
      .filter(p => p.teamId === team.teamId && hasValidDraftData(p))
      .sort((a, b) => {
        // Sort by years pro (most recent first), then by round, then by pick
        if (a.yearsPro !== b.yearsPro) return a.yearsPro - b.yearsPro
        if (a.draftRound !== b.draftRound) return a.draftRound - b.draftRound
        return a.draftPick - b.draftPick
      })

    if (teamDraftPicks.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# ${teamEmoji} ${team.displayName} Draft History\n\nNo players found with valid draft data for this team.`
          }
        ]
      })
      return
    }

    // Group by year (using yearsPro to estimate draft year)
    const currentYear = MADDEN_SEASON
    const picksByYear = new Map<number, Player[]>()

    teamDraftPicks.forEach(player => {
      const draftYear = currentYear - player.yearsPro
      if (!picksByYear.has(draftYear)) {
        picksByYear.set(draftYear, [])
      }
      picksByYear.get(draftYear)!.push(player)
    })

    let message = `# ${teamEmoji} ${team.displayName} Draft History\n\n**Total Draft Picks:** ${teamDraftPicks.length}\n\n`

    // Show most recent drafts first
    const years = Array.from(picksByYear.keys()).sort((a, b) => b - a).slice(0, 5)

    years.forEach(year => {
      const picks = picksByYear.get(year)!
      message += `## ${year} Draft (${picks.length} picks)\n`
      picks.forEach(player => {
        message += `**Rd ${player.draftRound} Pick ${player.draftPick}** - ${player.position} ${player.firstName} ${player.lastName} (${player.playerBestOvr} OVR)\n`
      })
      message += '\n'
    })

    if (picksByYear.size > 5) {
      message += `*Showing most recent 5 draft years. Total years: ${picksByYear.size}*\n`
    }

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        }
      ]
    })
  } catch (e) {
    console.error("❌ Error in showTeamDraft:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to show team draft history: ${e}`
        }
      ]
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id } = command

    if (!command.data.options) {
      throw new Error("draft command not defined properly")
    }

    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption

    // Handle configure and status without requiring league connection
    if (subCommand.name === "configure") {
      const subCommandOptions = subCommand.options
      if (!subCommandOptions) {
        throw new Error("missing draft configure options!")
      }
      const channel = (subCommandOptions[0] as APIApplicationCommandInteractionDataChannelOption).value

      const draftConfig: DraftConfiguration = {
        channel: {
          id: channel,
          id_type: DiscordIdType.CHANNEL
        }
      }
      await LeagueSettingsDB.configureDraft(guild_id, draftConfig)
      respond(ctx, createMessageResponse(`Draft pick notifications will be posted to <#${channel}>. When you export during the draft, picks will be captured and announced automatically!`))
      return
    }

    if (subCommand.name === "status") {
      const settings = await LeagueSettingsDB.getLeagueSettings(guild_id)
      const draftChannel = settings.commands.draft?.channel
      if (draftChannel) {
        respond(ctx, createMessageResponse(`Draft pick notifications are configured to post in <#${draftChannel.id}>`))
      } else {
        respond(ctx, createMessageResponse("Draft pick notifications are not configured. Use `/draft configure` to set up a channel."))
      }
      return
    }

    // Require league connection for other subcommands
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    respond(ctx, deferMessage())

    if (subCommand.name === "class") {
      const yearsAgo = Number((subCommand.options?.find(o => o.name === "year") as APIApplicationCommandInteractionDataIntegerOption)?.value) || 0
      const targetChannel = (subCommand.options?.find(o => o.name === "channel") as APIApplicationCommandInteractionDataChannelOption)?.value
      showDraftClass(command.token, client, league, yearsAgo, targetChannel)
    } else if (subCommand.name === "history") {
      const round = (subCommand.options?.find(o => o.name === "round") as APIApplicationCommandInteractionDataIntegerOption)?.value
      const position = (subCommand.options?.find(o => o.name === "position") as APIApplicationCommandInteractionDataStringOption)?.value
      showDraftHistory(command.token, client, league, round ? Number(round) : undefined, position)
    } else if (subCommand.name === "team") {
      const teamSearchPhrase = (subCommand.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.value
      if (!teamSearchPhrase) {
        throw new Error("Team parameter is required")
      }
      showTeamDraft(command.token, client, league, teamSearchPhrase.toLowerCase())
    }
  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "draft",
      description: "View draft information and configure notifications",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "configure",
          description: "Set the channel for automatic draft pick notifications",
          options: [{
            type: ApplicationCommandOptionType.Channel,
            name: "channel",
            description: "Channel to post draft picks as they happen",
            required: true,
            channel_types: [ChannelType.GuildText]
          }]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "status",
          description: "Check the current draft notification settings"
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "class",
          description: "View a draft class with performance stats",
          options: [
            {
              type: ApplicationCommandOptionType.Channel,
              name: "channel",
              description: "Channel to post results to (optional - posts in current channel if not specified)",
              required: false,
              channel_types: [ChannelType.GuildText]
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "year",
              description: "Years ago (0 = rookies, 1 = last year, 2 = two years ago, etc.)",
              required: false,
              min_value: 0,
              max_value: 15
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "history",
          description: "View draft history with filters",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "round",
              description: "Filter by draft round (1-7)",
              required: false,
              min_value: 1,
              max_value: 7
            },
            {
              type: ApplicationCommandOptionType.String,
              name: "position",
              description: "Filter by position (QB, RB, WR, etc.)",
              required: false
            }
          ]
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "team",
          description: "View a team's draft history",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "team",
              description: "Ex: Buccaneers, TB, Tampa Bay, Bucs",
              required: true,
              autocomplete: true
            }
          ]
        }
      ],
      type: ApplicationCommandType.ChatInput,
    }
  },
  async choices(command: Autocomplete) {
    const { guild_id } = command
    if (!command.data.options) {
      return []
    }
    const options = command.data.options
    const subCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const view = await discordLeagueView.createView(guild_id)
    const leagueId = view?.leagueId
    if (leagueId && subCommand.name === "team" && (subCommand?.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.focused && subCommand?.options?.[0]?.value) {
      const teamSearchPhrase = subCommand.options[0].value as string
      const teamsToSearch = await teamSearchView.createView(leagueId)
      if (teamsToSearch) {
        const results = fuzzysort.go(teamSearchPhrase, Object.values(teamsToSearch), { keys: ["cityName", "abbrName", "nickName", "displayName"], threshold: 0.4, limit: 25 })
        return results.map(r => ({ name: r.obj.displayName, value: r.obj.displayName }))
      }
    }
    return []
  }
} as CommandHandler & AutocompleteHandler
