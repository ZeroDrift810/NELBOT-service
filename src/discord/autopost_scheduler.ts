import { ComponentType, SeparatorSpacingSize } from "discord-api-types/v10"
import AutoPostDB, { ScheduledPost, formatSchedule } from "./autopost_db"
import { DiscordClient, formatTeamEmoji } from "./discord_utils"
import { ChannelId, DiscordIdType } from "./settings_db"
import MaddenDB, { PlayerStatType } from "../db/madden_db"
import { leagueLogosView } from "../db/view"
import { MADDEN_SEASON, formatRecord, GameResult, PlayoffStatus } from "../export/madden_league_types"
import db from "../db/firebase"

// Import command-specific logic
import { calculatePowerRankings, TeamGameData, PowerRanking } from "./commands/powerrankings_engine"
import { predictWeek, selectGOTW } from "./commands/prediction_engine"
import { generateGOTWPreview, isAnthropicConfigured, GOTWPreviewData } from "../ai/anthropic_client"
import PickemDB from "./pickem_db"
import AwardsDB, { getAwardLabel, getAwardEmoji, getAllAwardTypes } from "../db/awards_db"

let schedulerInterval: NodeJS.Timeout | null = null
let discordClient: DiscordClient | null = null
let isStarting = false  // Prevent race condition during startup

// Start the scheduler
export function startAutoPostScheduler(client: DiscordClient) {
  // Prevent double-start race condition
  if (isStarting) {
    console.log("⏰ Auto-post scheduler start already in progress")
    return
  }

  if (schedulerInterval) {
    console.log("⏰ Auto-post scheduler already running")
    return
  }

  isStarting = true

  try {
    discordClient = client
    console.log("⏰ Starting auto-post scheduler (checking every minute)")

    // Run immediately on start
    checkAndRunDuePosts()

    // Then run every minute
    schedulerInterval = setInterval(checkAndRunDuePosts, 60 * 1000)
  } finally {
    isStarting = false
  }
}

// Stop the scheduler
export function stopAutoPostScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    console.log("⏰ Auto-post scheduler stopped")
  }
}

// Check for and run due posts
async function checkAndRunDuePosts() {
  try {
    const duePosts = await AutoPostDB.getPostsDueNow()

    if (duePosts.length > 0) {
      console.log(`⏰ Found ${duePosts.length} scheduled posts due now`)
    }

    for (const post of duePosts) {
      try {
        console.log(`⏰ Executing scheduled post: ${post.commandType} for guild ${post.guildId}`)
        await executeScheduledPost(post)
        await AutoPostDB.markPostRun(post.id)
        console.log(`✅ Scheduled post ${post.id} completed successfully`)
      } catch (e) {
        const error = e as Error
        console.error(`❌ Failed to execute scheduled post ${post.id}:`, error.message)
        await AutoPostDB.markPostRun(post.id, error.message)
      }
    }
  } catch (e) {
    console.error("❌ Error checking for due posts:", e)
  }
}

// Execute a scheduled post
async function executeScheduledPost(post: ScheduledPost) {
  if (!discordClient) {
    throw new Error("Discord client not initialized")
  }

  const channelId: ChannelId = { id: post.channelId, id_type: DiscordIdType.CHANNEL }

  switch (post.commandType) {
    case 'powerrankings':
      await postPowerRankings(post, channelId)
      break
    case 'playerrankings':
      await postPlayerRankings(post, channelId)
      break
    case 'leaders':
      await postLeaders(post, channelId)
      break
    case 'standings':
      await postStandings(post, channelId)
      break
    case 'teamstats':
      await postTeamStats(post, channelId)
      break
    case 'schedule':
      await postSchedule(post, channelId)
      break
    case 'predictions':
      await postPredictions(post, channelId)
      break
    case 'gotw':
      await postGOTW(post, channelId)
      break
    case 'pickem_leaderboard':
      await postPickemLeaderboard(post, channelId)
      break
    case 'playoffs':
      await postPlayoffs(post, channelId)
      break
    case 'awards':
      await postAwards(post, channelId)
      break
    case 'farecap':
      await postFARecap(post, channelId)
      break
    default:
      throw new Error(`Unknown command type: ${post.commandType}`)
  }
}

// Post power rankings
async function postPowerRankings(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, standings, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
  const currentWeekIndex = weeks.length > 0 ? weeks[0].weekIndex : 0

  // Filter standings for current season
  const seasonStandings = standings.filter(s => s.seasonIndex === currentSeasonIndex)
  if (seasonStandings.length === 0) {
    throw new Error("No standings data for current season")
  }

  // Build team game data for power rankings calculation
  const teamGameData: TeamGameData[] = seasonStandings.map(standing => {
    const gamesPlayed = standing.totalWins + standing.totalLosses + standing.totalTies
    return {
      teamId: standing.teamId,
      gamesPlayed,
      wins: standing.totalWins,
      losses: standing.totalLosses,
      ties: standing.totalTies,
      pointsFor: standing.ptsFor || 0,
      pointsAgainst: standing.ptsAgainst || 0,
      totalOffYards: standing.offTotalYds || 0,
      totalOffPlays: gamesPlayed * 60,
      totalDefYardsAllowed: standing.defTotalYds || 0,
      totalDefPlaysFaced: gamesPlayed * 60,
      takeaways: Math.max(0, standing.tODiff),  // Approximate from TO diff
      giveaways: Math.max(0, -standing.tODiff), // Approximate from TO diff
      opponentTeamIds: []
    }
  })

  // Generate rankings
  const rankings = calculatePowerRankings(teamGameData)

  // Determine how many to show based on options
  const range = post.options?.range || 'top10'
  const limit = range === 'top5' ? 5 : range === 'top10' ? 10 : 32

  let message = `# NEL Power Rankings\n`
  message += `**Season ${MADDEN_SEASON + currentSeasonIndex} | Week ${currentWeekIndex + 1}**\n\n`

  rankings.slice(0, limit).forEach((ranking: PowerRanking, idx: number) => {
    const teamData = teams.getTeamForId(ranking.teamId)
    if (!teamData) return

    const emoji = formatTeamEmoji(logos, teamData.abbrName)
    const standing = seasonStandings.find(s => s.teamId === ranking.teamId)
    const record = standing ? `${standing.totalWins}-${standing.totalLosses}` : ''

    message += `**${idx + 1}.** ${emoji} **${teamData.displayName}** (${record})\n`
    message += `Power Score: ${ranking.powerScore.toFixed(1)}\n\n`
  })

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post player rankings - season stat leaders (matching approved format)
async function postPlayerRankings(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  if (weeks.length === 0) {
    throw new Error("No season data available")
  }

  const currentSeasonIndex = weeks[0].seasonIndex

  // Get all weeks for current season (regular season)
  const seasonWeeks = weeks.filter(w =>
    w.seasonIndex === currentSeasonIndex &&
    w.weekIndex >= 0 && w.weekIndex <= 17
  )

  // Aggregate stats across all weeks using correct PlayerStatType enum
  const passingByPlayer = new Map<string, any>()
  const rushingByPlayer = new Map<string, any>()
  const receivingByPlayer = new Map<string, any>()
  const defenseByPlayer = new Map<string, any>()

  for (const week of seasonWeeks) {
    try {
      const weeklyStats = await MaddenDB.getWeeklyStats(post.leagueId, currentSeasonIndex, week.weekIndex)

      // Passing stats
      if (weeklyStats[PlayerStatType.PASSING]) {
        (weeklyStats[PlayerStatType.PASSING] as any[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = passingByPlayer.get(key)
          if (existing) {
            existing.passYds += stat.passYds
            existing.passTDs += stat.passTDs
            existing.passInts += stat.passInts
            existing.passAtt += stat.passAtt
            existing.passComp += stat.passComp
          } else {
            passingByPlayer.set(key, { ...stat })
          }
        })
      }

      // Rushing stats (includes broken tackles)
      if (weeklyStats[PlayerStatType.RUSHING]) {
        (weeklyStats[PlayerStatType.RUSHING] as any[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = rushingByPlayer.get(key)
          if (existing) {
            existing.rushYds += stat.rushYds
            existing.rushTDs += stat.rushTDs
            existing.rushAtt += stat.rushAtt
            existing.rushBrokenTackles = (existing.rushBrokenTackles || 0) + (stat.rushBrokenTackles || 0)
          } else {
            rushingByPlayer.set(key, { ...stat, rushBrokenTackles: stat.rushBrokenTackles || 0 })
          }
        })
      }

      // Receiving stats (includes YAC)
      if (weeklyStats[PlayerStatType.RECEIVING]) {
        (weeklyStats[PlayerStatType.RECEIVING] as any[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = receivingByPlayer.get(key)
          if (existing) {
            existing.recYds += stat.recYds
            existing.recTDs += stat.recTDs
            existing.recCatches += stat.recCatches
            existing.recYdsAfterCatch = (existing.recYdsAfterCatch || 0) + (stat.recYdsAfterCatch || 0)
          } else {
            receivingByPlayer.set(key, { ...stat, recYdsAfterCatch: stat.recYdsAfterCatch || 0 })
          }
        })
      }

      // Defensive stats (includes deflections, fumble recovery)
      if (weeklyStats[PlayerStatType.DEFENSE]) {
        (weeklyStats[PlayerStatType.DEFENSE] as any[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = defenseByPlayer.get(key)
          if (existing) {
            existing.defTotalTackles += stat.defTotalTackles
            existing.defSacks += stat.defSacks
            existing.defInts += stat.defInts
            existing.defForcedFum += stat.defForcedFum
            existing.defTDs += stat.defTDs
            existing.defDeflections = (existing.defDeflections || 0) + (stat.defDeflections || 0)
            existing.defFumRec = (existing.defFumRec || 0) + (stat.defFumRec || 0)
          } else {
            defenseByPlayer.set(key, { ...stat, defDeflections: stat.defDeflections || 0, defFumRec: stat.defFumRec || 0 })
          }
        })
      }
    } catch (e) {
      // Skip failed weeks
    }
  }

  // ============= OFFENSE PAGE =============
  const topPassers = Array.from(passingByPlayer.values())
    .sort((a, b) => b.passYds - a.passYds)
    .slice(0, 5)

  const topRushers = Array.from(rushingByPlayer.values())
    .filter(s => s.rushAtt >= 50)
    .sort((a, b) => b.rushYds - a.rushYds)
    .slice(0, 5)

  const topBrokenTackles = Array.from(rushingByPlayer.values())
    .filter(s => s.rushBrokenTackles > 0)
    .sort((a, b) => b.rushBrokenTackles - a.rushBrokenTackles)
    .slice(0, 5)

  const topReceivers = Array.from(receivingByPlayer.values())
    .filter(s => s.recCatches >= 20)
    .sort((a, b) => b.recYds - a.recYds)
    .slice(0, 5)

  const topYAC = Array.from(receivingByPlayer.values())
    .filter(s => s.recYdsAfterCatch > 0)
    .sort((a, b) => b.recYdsAfterCatch - a.recYdsAfterCatch)
    .slice(0, 5)

  // Build offense page
  const offenseComponents: any[] = [
    {
      type: ComponentType.TextDisplay,
      content: `# 🏈 NEL PLAYER RANKINGS - OFFENSE\n## Season ${MADDEN_SEASON + currentSeasonIndex}`
    },
    { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small }
  ]

  if (topPassers[0]) {
    const p = topPassers[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    const compPct = p.passAtt > 0 ? ((p.passComp / p.passAtt) * 100).toFixed(1) : '0.0'
    offenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🎯 PASSING LEADER\n${emoji} **${p.fullName}**\n${p.passYds} YDS | ${p.passTDs} TD | ${p.passInts} INT | ${compPct}%`
    })
  }

  if (topRushers[0]) {
    const p = topRushers[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    const ypc = p.rushAtt > 0 ? (p.rushYds / p.rushAtt).toFixed(1) : '0.0'
    offenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🏃 RUSHING LEADER\n${emoji} **${p.fullName}**\n${p.rushYds} YDS | ${p.rushTDs} TD | ${p.rushAtt} ATT | ${ypc} YPC`
    })
  }

  if (topBrokenTackles[0]) {
    const p = topBrokenTackles[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    offenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 💪 BROKEN TACKLE LEADER\n${emoji} **${p.fullName}**\n${p.rushBrokenTackles} BT | ${p.rushYds} YDS | ${p.rushTDs} TD`
    })
  }

  if (topReceivers[0]) {
    const p = topReceivers[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    const ypc = p.recCatches > 0 ? (p.recYds / p.recCatches).toFixed(1) : '0.0'
    offenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🙌 RECEIVING LEADER\n${emoji} **${p.fullName}**\n${p.recYds} YDS | ${p.recTDs} TD | ${p.recCatches} REC | ${ypc} YPC`
    })
  }

  if (topYAC[0]) {
    const p = topYAC[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    const yacPerCatch = p.recCatches > 0 ? (p.recYdsAfterCatch / p.recCatches).toFixed(1) : '0.0'
    offenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🔥 YAC LEADER\n${emoji} **${p.fullName}**\n${p.recYdsAfterCatch} YAC | ${yacPerCatch} YAC/REC | ${p.recCatches} REC`
    })
  }

  offenseComponents.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small })

  // Offense rankings (#2-5)
  let offenseRankings = "### Full Rankings\n"
  if (topPassers.length > 1) {
    offenseRankings += `**Passing:** ${topPassers.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.passYds})`
    }).join(" • ")}\n`
  }
  if (topRushers.length > 1) {
    offenseRankings += `**Rushing:** ${topRushers.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.rushYds})`
    }).join(" • ")}\n`
  }
  if (topBrokenTackles.length > 1) {
    offenseRankings += `**Broken Tackles:** ${topBrokenTackles.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.rushBrokenTackles})`
    }).join(" • ")}\n`
  }
  if (topReceivers.length > 1) {
    offenseRankings += `**Receiving:** ${topReceivers.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.recYds})`
    }).join(" • ")}\n`
  }
  if (topYAC.length > 1) {
    offenseRankings += `**YAC:** ${topYAC.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.recYdsAfterCatch})`
    }).join(" • ")}\n`
  }
  offenseRankings += `\n───────────────────────\n`
  offenseRankings += `Season ${MADDEN_SEASON + currentSeasonIndex} • ${seasonWeeks.length} games`
  offenseComponents.push({ type: ComponentType.TextDisplay, content: offenseRankings })

  // Post offense page
  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: offenseComponents
  })

  // ============= DEFENSE PAGE =============
  const topTacklers = Array.from(defenseByPlayer.values())
    .sort((a, b) => b.defTotalTackles - a.defTotalTackles)
    .slice(0, 5)

  const topSackers = Array.from(defenseByPlayer.values())
    .filter(s => s.defSacks > 0)
    .sort((a, b) => b.defSacks - a.defSacks)
    .slice(0, 5)

  const topINTs = Array.from(defenseByPlayer.values())
    .filter(s => s.defInts > 0)
    .sort((a, b) => b.defInts - a.defInts)
    .slice(0, 5)

  const topDeflections = Array.from(defenseByPlayer.values())
    .filter(s => s.defDeflections > 0)
    .sort((a, b) => b.defDeflections - a.defDeflections)
    .slice(0, 5)

  const topFumbleRec = Array.from(defenseByPlayer.values())
    .filter(s => s.defFumRec > 0)
    .sort((a, b) => b.defFumRec - a.defFumRec)
    .slice(0, 5)

  // Build defense page
  const defenseComponents: any[] = [
    {
      type: ComponentType.TextDisplay,
      content: `# 🛡️ NEL PLAYER RANKINGS - DEFENSE\n## Season ${MADDEN_SEASON + currentSeasonIndex}`
    },
    { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small }
  ]

  if (topTacklers[0]) {
    const p = topTacklers[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    defenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🛡️ TACKLE LEADER\n${emoji} **${p.fullName}**\n${p.defTotalTackles} TKL | ${p.defSacks} SK | ${p.defInts} INT`
    })
  }

  if (topSackers[0]) {
    const p = topSackers[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    defenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 💥 SACK LEADER\n${emoji} **${p.fullName}**\n${p.defSacks} SK | ${p.defTotalTackles} TKL | ${p.defForcedFum || 0} FF`
    })
  }

  if (topINTs[0]) {
    const p = topINTs[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    defenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🦅 INTERCEPTION LEADER\n${emoji} **${p.fullName}**\n${p.defInts} INT | ${p.defTotalTackles} TKL | ${p.defTDs || 0} TD`
    })
  }

  if (topDeflections[0]) {
    const p = topDeflections[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    defenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🎯 DEFLECTION LEADER\n${emoji} **${p.fullName}**\n${p.defDeflections} PD | ${p.defInts} INT | ${p.defTotalTackles} TKL`
    })
  }

  if (topFumbleRec[0]) {
    const p = topFumbleRec[0]
    const team = teams.getTeamForId(p.teamId)
    const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
    defenseComponents.push({
      type: ComponentType.TextDisplay,
      content: `### 🧲 FUMBLE RECOVERY LEADER\n${emoji} **${p.fullName}**\n${p.defFumRec} FR | ${p.defForcedFum || 0} FF | ${p.defTotalTackles} TKL`
    })
  }

  defenseComponents.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small })

  // Defense rankings (#2-5)
  let defenseRankings = "### Full Rankings\n"
  if (topTacklers.length > 1) {
    defenseRankings += `**Tackles:** ${topTacklers.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.defTotalTackles})`
    }).join(" • ")}\n`
  }
  if (topSackers.length > 1) {
    defenseRankings += `**Sacks:** ${topSackers.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.defSacks})`
    }).join(" • ")}\n`
  }
  if (topINTs.length > 1) {
    defenseRankings += `**Interceptions:** ${topINTs.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.defInts})`
    }).join(" • ")}\n`
  }
  if (topDeflections.length > 1) {
    defenseRankings += `**Deflections:** ${topDeflections.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.defDeflections})`
    }).join(" • ")}\n`
  }
  if (topFumbleRec.length > 1) {
    defenseRankings += `**Fumble Rec:** ${topFumbleRec.slice(1).map((p, i) => {
      const team = teams.getTeamForId(p.teamId)
      return `${i + 2}. ${team ? formatTeamEmoji(logos, team.abbrName) : ''} ${p.fullName} (${p.defFumRec})`
    }).join(" • ")}\n`
  }
  defenseRankings += `\n───────────────────────\n`
  defenseRankings += `Season ${MADDEN_SEASON + currentSeasonIndex} • ${seasonWeeks.length} games\n`
  defenseRankings += `*Auto-posted ${formatSchedule(post.schedule)}*`
  defenseComponents.push({ type: ComponentType.TextDisplay, content: defenseRankings })

  // Post defense page
  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: defenseComponents
  })
}

// Post stat leaders
async function postLeaders(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
  const stats = await MaddenDB.getWeeklyStats(post.leagueId, currentSeasonIndex, -1)

  const category = post.options?.category || 'passing'
  let message = `# NEL ${category.charAt(0).toUpperCase() + category.slice(1)} Leaders\n\n`

  if (category === 'passing' && stats[0]) {
    const passers = (stats[0] as any[])
      .sort((a, b) => b.passYds - a.passYds)
      .slice(0, 10)

    passers.forEach((p, idx) => {
      const team = teams.getTeamForId(p.teamId)
      const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
      message += `**${idx + 1}.** ${emoji} **${p.fullName}** - ${p.passYds} yds, ${p.passTDs} TD, ${p.passInts} INT\n`
    })
  } else if (category === 'rushing' && stats[4]) {
    const rushers = (stats[4] as any[])
      .sort((a, b) => b.rushYds - a.rushYds)
      .slice(0, 10)

    rushers.forEach((p, idx) => {
      const team = teams.getTeamForId(p.teamId)
      const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
      message += `**${idx + 1}.** ${emoji} **${p.fullName}** - ${p.rushYds} yds, ${p.rushTDs} TD\n`
    })
  } else if (category === 'receiving' && stats[3]) {
    const receivers = (stats[3] as any[])
      .sort((a, b) => b.recYds - a.recYds)
      .slice(0, 10)

    receivers.forEach((p, idx) => {
      const team = teams.getTeamForId(p.teamId)
      const emoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
      message += `**${idx + 1}.** ${emoji} **${p.fullName}** - ${p.recCatches} rec, ${p.recYds} yds, ${p.recTDs} TD\n`
    })
  }

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post standings
async function postStandings(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, standings, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
  const seasonStandings = standings
    .filter(s => s.seasonIndex === currentSeasonIndex)
    .sort((a, b) => {
      // Sort by wins desc, then by point diff
      if (a.totalWins !== b.totalWins) return b.totalWins - a.totalWins
      return b.netPts - a.netPts
    })

  let message = `# NEL Standings\n`
  message += `**Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

  seasonStandings.slice(0, 16).forEach((standing, idx) => {
    const team = teams.getTeamForId(standing.teamId)
    if (!team) return

    const emoji = formatTeamEmoji(logos, team.abbrName)
    const record = standing.totalTies > 0
      ? `${standing.totalWins}-${standing.totalLosses}-${standing.totalTies}`
      : `${standing.totalWins}-${standing.totalLosses}`

    message += `**${idx + 1}.** ${emoji} **${team.displayName}** ${record}\n`
  })

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post team stats
async function postTeamStats(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, standings, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
  const seasonStandings = standings.filter(s => s.seasonIndex === currentSeasonIndex)

  let message = `# NEL Team Stats\n`
  message += `**Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

  // Offense rankings
  message += `**Top Offenses (Total Yards)**\n`
  const offenseRanks = [...seasonStandings].sort((a, b) => b.offTotalYds - a.offTotalYds).slice(0, 5)
  offenseRanks.forEach((s, idx) => {
    const team = teams.getTeamForId(s.teamId)
    if (!team) return
    const emoji = formatTeamEmoji(logos, team.abbrName)
    message += `${idx + 1}. ${emoji} ${team.abbrName} - ${s.offTotalYds} yds\n`
  })

  message += `\n**Top Defenses (Yards Allowed)**\n`
  const defenseRanks = [...seasonStandings].sort((a, b) => a.defTotalYds - b.defTotalYds).slice(0, 5)
  defenseRanks.forEach((s, idx) => {
    const team = teams.getTeamForId(s.teamId)
    if (!team) return
    const emoji = formatTeamEmoji(logos, team.abbrName)
    message += `${idx + 1}. ${emoji} ${team.abbrName} - ${s.defTotalYds} yds\n`
  })

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post schedule
async function postSchedule(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks, schedule] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId),
    MaddenDB.getLatestSchedule(post.leagueId)
  ])

  const currentSeasonIndex = weeks.length > 0 ? weeks[0].seasonIndex : 0
  const currentWeekIndex = weeks.length > 0 ? weeks[0].weekIndex : 0

  // Filter to current week's games
  const weekGames = schedule
    .filter(g => g.seasonIndex === currentSeasonIndex && g.weekIndex === currentWeekIndex)
    .sort((a, b) => a.scheduleId - b.scheduleId)

  let message = `# NEL Week ${currentWeekIndex + 1} Schedule\n`
  message += `**Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

  weekGames.forEach(game => {
    const homeTeam = teams.getTeamForId(game.homeTeamId)
    const awayTeam = teams.getTeamForId(game.awayTeamId)
    if (!homeTeam || !awayTeam) return

    const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
    const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)

    if (game.homeScore !== null && game.awayScore !== null) {
      // Game played
      if (game.awayScore > game.homeScore) {
        message += `**${awayEmoji} ${awayTeam.abbrName} ${game.awayScore}** @ ${homeEmoji} ${homeTeam.abbrName} ${game.homeScore}\n`
      } else if (game.homeScore > game.awayScore) {
        message += `${awayEmoji} ${awayTeam.abbrName} ${game.awayScore} @ **${homeEmoji} ${homeTeam.abbrName} ${game.homeScore}**\n`
      } else {
        message += `${awayEmoji} ${awayTeam.abbrName} ${game.awayScore} @ ${homeEmoji} ${homeTeam.abbrName} ${game.homeScore}\n`
      }
    } else {
      message += `${awayEmoji} ${awayTeam.abbrName} @ ${homeEmoji} ${homeTeam.abbrName}\n`
    }
  })

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post predictions
async function postPredictions(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks, standings] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId)
  ])

  if (weeks.length === 0) {
    throw new Error("No season data available")
  }

  const currentSeasonIndex = weeks[0].seasonIndex
  const currentWeekIndex = weeks[0].weekIndex

  const schedule = await MaddenDB.getLatestWeekSchedule(post.leagueId, currentWeekIndex + 1)

  if (schedule.length === 0) {
    throw new Error(`No games found for Week ${currentWeekIndex + 1}`)
  }

  // Build team game data
  const teamGameDataList: TeamGameData[] = standings.map(standing => {
    const gamesPlayed = standing.totalWins + standing.totalLosses + standing.totalTies
    return {
      teamId: standing.teamId,
      gamesPlayed,
      wins: standing.totalWins,
      losses: standing.totalLosses,
      ties: standing.totalTies,
      pointsFor: standing.ptsFor || 0,
      pointsAgainst: standing.ptsAgainst || 0,
      totalOffYards: (standing.ptsFor || 0) * 30,
      totalOffPlays: gamesPlayed * 60,
      totalDefYardsAllowed: (standing.ptsAgainst || 0) * 30,
      totalDefPlaysFaced: gamesPlayed * 60,
      takeaways: gamesPlayed,
      giveaways: gamesPlayed,
      opponentTeamIds: []
    }
  })

  const predictions = predictWeek(schedule, teamGameDataList, standings)

  let message = `# 📊 NEL PREDICTIONS\n`
  message += `**Week ${currentWeekIndex + 1} • Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

  for (const pred of predictions) {
    const homeTeam = teams.getTeamForId(pred.game.homeTeamId)
    const awayTeam = teams.getTeamForId(pred.game.awayTeamId)
    if (!homeTeam || !awayTeam) continue

    const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
    const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)
    const winner = teams.getTeamForId(pred.predictedWinner)
    const winnerEmoji = formatTeamEmoji(logos, winner?.abbrName || '')

    message += `${awayEmoji} ${awayTeam.abbrName} @ ${homeEmoji} ${homeTeam.abbrName} → ${winnerEmoji} **${pred.predictedWinnerScore}-${pred.predictedLoserScore}** (${pred.confidence}%)\n`
  }

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  // Truncate if too long
  if (message.length > 3900) {
    message = message.substring(0, 3900) + "\n...\n\n*Truncated - use /predictions for full list*"
  }

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post Game of the Week
async function postGOTW(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks, standings] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId)
  ])

  if (weeks.length === 0) {
    throw new Error("No season data available")
  }

  const currentSeasonIndex = weeks[0].seasonIndex
  const currentWeekIndex = weeks[0].weekIndex

  const schedule = await MaddenDB.getLatestWeekSchedule(post.leagueId, currentWeekIndex + 1)

  if (schedule.length === 0) {
    throw new Error(`No games found for Week ${currentWeekIndex + 1}`)
  }

  // Build team game data
  const teamGameDataList: TeamGameData[] = standings.map(standing => {
    const gamesPlayed = standing.totalWins + standing.totalLosses + standing.totalTies
    return {
      teamId: standing.teamId,
      gamesPlayed,
      wins: standing.totalWins,
      losses: standing.totalLosses,
      ties: standing.totalTies,
      pointsFor: standing.ptsFor || 0,
      pointsAgainst: standing.ptsAgainst || 0,
      totalOffYards: (standing.ptsFor || 0) * 30,
      totalOffPlays: gamesPlayed * 60,
      totalDefYardsAllowed: (standing.ptsAgainst || 0) * 30,
      totalDefPlaysFaced: gamesPlayed * 60,
      takeaways: gamesPlayed,
      giveaways: gamesPlayed,
      opponentTeamIds: []
    }
  })

  const powerRankings = calculatePowerRankings(teamGameDataList)
  const predictions = predictWeek(schedule, teamGameDataList, standings)
  const gotw = selectGOTW(schedule, predictions, powerRankings, standings)

  const homeTeam = teams.getTeamForId(gotw.game.homeTeamId)
  const awayTeam = teams.getTeamForId(gotw.game.awayTeamId)
  const homeStanding = standings.find(s => s.teamId === gotw.game.homeTeamId)
  const awayStanding = standings.find(s => s.teamId === gotw.game.awayTeamId)

  if (!homeTeam || !awayTeam || !homeStanding || !awayStanding) {
    throw new Error("Missing team data for GOTW")
  }

  const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
  const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)

  let message = `# 🏈 GAME OF THE WEEK\n`
  message += `## Week ${currentWeekIndex + 1} • Season ${MADDEN_SEASON + currentSeasonIndex}\n\n`
  message += `### ${awayEmoji} ${awayTeam.displayName} (${formatRecord(awayStanding)})\n`
  message += `### @ ${homeEmoji} ${homeTeam.displayName} (${formatRecord(homeStanding)})\n\n`

  // Try to get AI preview
  if (isAnthropicConfigured()) {
    try {
      const previewData: GOTWPreviewData = {
        homeTeam: homeTeam.displayName,
        awayTeam: awayTeam.displayName,
        homeRecord: formatRecord(homeStanding),
        awayRecord: formatRecord(awayStanding),
        homeRank: gotw.prediction.homeTeamPowerRank || 0,
        awayRank: gotw.prediction.awayTeamPowerRank || 0,
        predictedScore: `${teams.getTeamForId(gotw.prediction.predictedWinner)?.displayName || 'TBD'} ${gotw.prediction.predictedWinnerScore}-${gotw.prediction.predictedLoserScore}`,
        confidence: gotw.prediction.confidence,
        keyMatchups: [],
        storylines: gotw.reasoning
      }
      const aiPreview = await generateGOTWPreview(previewData)
      message += aiPreview + "\n\n"
    } catch (e) {
      console.warn("⚠️ GOTW AI preview failed:", e)
      message += `**Why this game matters:**\n${gotw.reasoning.join(" ")}\n\n`
    }
  } else {
    message += `**Why this game matters:**\n${gotw.reasoning.join(" ")}\n\n`
  }

  const winner = teams.getTeamForId(gotw.prediction.predictedWinner)
  message += `**Prediction:** ${winner?.displayName || 'TBD'} wins ${gotw.prediction.predictedWinnerScore}-${gotw.prediction.predictedLoserScore} (${gotw.prediction.confidence}% confidence)\n\n`
  message += `*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post Pick'em Leaderboard
async function postPickemLeaderboard(post: ScheduledPost, channelId: ChannelId) {
  const weeks = await MaddenDB.getAllWeeks(post.leagueId)

  if (weeks.length === 0) {
    throw new Error("No season data available")
  }

  const currentSeasonIndex = weeks[0].seasonIndex
  const leaderboard = await PickemDB.getSeasonLeaderboard(post.guildId, post.leagueId, currentSeasonIndex)

  if (leaderboard.length === 0) {
    throw new Error("No pick'em data for this season")
  }

  let message = `# 🏆 NEL PICK'EM LEADERBOARD\n`
  message += `## Season ${MADDEN_SEASON + currentSeasonIndex}\n\n`

  for (let i = 0; i < Math.min(leaderboard.length, 10); i++) {
    const user = leaderboard[i]
    const rank = i + 1

    let rankEmoji = `${rank}.`
    if (rank === 1) rankEmoji = '🥇'
    if (rank === 2) rankEmoji = '🥈'
    if (rank === 3) rankEmoji = '🥉'

    let accuracyEmoji = '🟢'
    if (user.accuracy < 70) accuracyEmoji = '🟡'
    if (user.accuracy < 60) accuracyEmoji = '🔴'

    message += `${rankEmoji} **${user.userName}** ${accuracyEmoji} ${user.correctPicks}/${user.totalPicks} (${user.accuracy.toFixed(1)}%)\n`
  }

  if (leaderboard.length > 10) {
    message += `\n*...and ${leaderboard.length - 10} more*\n`
  }

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post Playoffs Bracket (text summary)
async function postPlayoffs(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks, standings, schedule] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId),
    MaddenDB.getLatestStandings(post.leagueId),
    MaddenDB.getLatestSchedule(post.leagueId)
  ])

  if (weeks.length === 0) {
    throw new Error("No season data available")
  }

  const currentSeasonIndex = weeks[0].seasonIndex

  // Find playoff games (week 18+)
  const playoffGames = schedule.filter(g =>
    g.seasonIndex === currentSeasonIndex && g.weekIndex >= 18
  ).sort((a, b) => a.weekIndex - b.weekIndex || a.scheduleId - b.scheduleId)

  if (playoffGames.length === 0) {
    // Show playoff picture instead
    const seasonStandings = standings.filter(s => s.seasonIndex === currentSeasonIndex)

    // Get clinched teams
    const clinched = seasonStandings.filter(s =>
      s.playoffStatus === PlayoffStatus.CLINCHED_TOP_SEED ||
      s.playoffStatus === PlayoffStatus.CLINCHED_DIVISION ||
      s.playoffStatus === PlayoffStatus.CLINCHED_PLAYOFF_BERTH
    )

    let message = `# 🏆 PLAYOFF PICTURE\n`
    message += `**Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

    if (clinched.length > 0) {
      message += `**Clinched Playoff Berths:**\n`
      clinched.forEach(s => {
        const team = teams.getTeamForId(s.teamId)
        if (!team) return
        const emoji = formatTeamEmoji(logos, team.abbrName)
        const status = s.playoffStatus === PlayoffStatus.CLINCHED_TOP_SEED ? '(#1 seed)' :
          s.playoffStatus === PlayoffStatus.CLINCHED_DIVISION ? '(div)' : ''
        message += `${emoji} ${team.displayName} ${s.totalWins}-${s.totalLosses} ${status}\n`
      })
    } else {
      message += `*No teams have clinched playoff berths yet.*\n`
    }

    message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

    await discordClient!.createMessageWithComponents(channelId, {
      flags: 32768,
      components: [{
        type: ComponentType.TextDisplay,
        content: message
      }]
    })
    return
  }

  // Show playoff bracket status
  const weekNames: { [key: number]: string } = {
    18: 'Wild Card',
    19: 'Divisional',
    20: 'Conference Championships',
    21: 'Super Bowl'
  }

  let message = `# 🏆 PLAYOFF BRACKET\n`
  message += `**Season ${MADDEN_SEASON + currentSeasonIndex}**\n\n`

  // Group by week
  const byWeek = Object.groupBy(playoffGames, g => g.weekIndex)

  for (const [weekIdx, games] of Object.entries(byWeek)) {
    const weekName = weekNames[parseInt(weekIdx)] || `Week ${parseInt(weekIdx) + 1}`
    message += `### ${weekName}\n`

    for (const game of games || []) {
      const homeTeam = teams.getTeamForId(game.homeTeamId)
      const awayTeam = teams.getTeamForId(game.awayTeamId)
      if (!homeTeam || !awayTeam) continue

      const homeEmoji = formatTeamEmoji(logos, homeTeam.abbrName)
      const awayEmoji = formatTeamEmoji(logos, awayTeam.abbrName)

      if (game.status !== GameResult.NOT_PLAYED) {
        // Game finished
        const homeWon = (game.homeScore || 0) > (game.awayScore || 0)
        if (homeWon) {
          message += `${awayEmoji} ${awayTeam.abbrName} ${game.awayScore} @ **${homeEmoji} ${homeTeam.abbrName} ${game.homeScore}** ✓\n`
        } else {
          message += `**${awayEmoji} ${awayTeam.abbrName} ${game.awayScore}** @ ${homeEmoji} ${homeTeam.abbrName} ${game.homeScore} ✓\n`
        }
      } else {
        message += `${awayEmoji} ${awayTeam.abbrName} @ ${homeEmoji} ${homeTeam.abbrName}\n`
      }
    }
    message += `\n`
  }

  message += `*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post Awards
async function postAwards(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos, weeks] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId),
    MaddenDB.getAllWeeks(post.leagueId)
  ])

  const currentSeason = weeks.length > 0 ? MADDEN_SEASON + weeks[0].seasonIndex : MADDEN_SEASON

  const allAwards = await AwardsDB.getSeasonAwards(post.leagueId, currentSeason)

  let message = `# 🏆 NEL AWARDS\n`
  message += `**Season ${currentSeason}**\n\n`

  if (allAwards.length === 0) {
    message += `*No awards have been given yet this season.*\n\n`
    message += `*Use \`/awards give\` to grant awards to players.*`
  } else {
    for (const award of allAwards) {
      const team = teams.getTeamForId(award.teamId)
      const teamEmoji = team ? formatTeamEmoji(logos, team.abbrName) : ''
      const awardEmoji = getAwardEmoji(award.awardType)

      message += `${awardEmoji} **${getAwardLabel(award.awardType)}**\n`
      message += `${teamEmoji} ${award.playerName} (${award.position})\n\n`
    }
  }

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}

// Post FA Recap
async function postFARecap(post: ScheduledPost, channelId: ChannelId) {
  const [teams, logos] = await Promise.all([
    MaddenDB.getLatestTeams(post.leagueId),
    leagueLogosView.createView(post.leagueId)
  ])

  // Check last 7 days of signings
  const daysBack = 7
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysBack)

  // Get all players and check history for FA signings
  const playersSnap = await db.collection('madden_data26').doc(post.leagueId).collection('MADDEN_PLAYER').get()

  interface FASigning {
    firstName: string
    lastName: string
    position: string
    playerBestOvr: number
    teamId: number
    signingDate: Date
  }

  const faSignings: FASigning[] = []

  for (const doc of playersSnap.docs) {
    const player = doc.data()
    if (player.isFreeAgent || player.teamId === 0) continue

    const historySnap = await doc.ref.collection('history').orderBy('timestamp', 'desc').limit(5).get()

    for (const histDoc of historySnap.docs) {
      const hist = histDoc.data()
      if (!hist.timestamp) continue

      const signingDate = hist.timestamp.toDate()
      if (signingDate < cutoffDate) continue

      // Check if signed from FA
      if (hist.teamId && hist.teamId.oldValue === 0 && hist.teamId.newValue !== 0) {
        faSignings.push({
          firstName: player.firstName,
          lastName: player.lastName,
          position: player.position,
          playerBestOvr: player.playerBestOvr,
          teamId: player.teamId,
          signingDate
        })
        break
      }
      if (hist.isFreeAgent && hist.isFreeAgent.oldValue === true && hist.isFreeAgent.newValue === false) {
        faSignings.push({
          firstName: player.firstName,
          lastName: player.lastName,
          position: player.position,
          playerBestOvr: player.playerBestOvr,
          teamId: player.teamId,
          signingDate
        })
        break
      }
    }
  }

  let message = `# 📋 FREE AGENCY RECAP\n`
  message += `**Last ${daysBack} Days**\n\n`

  if (faSignings.length === 0) {
    message += `*No FA signings in the last ${daysBack} days.*\n`
  } else {
    // Sort by OVR
    faSignings.sort((a, b) => b.playerBestOvr - a.playerBestOvr)

    // Show top 10
    const topSignings = faSignings.slice(0, 10)

    for (const signing of topSignings) {
      const team = teams.getTeamForId(signing.teamId)
      const teamEmoji = team ? formatTeamEmoji(logos, team.abbrName) : ''

      message += `${teamEmoji} **${signing.firstName} ${signing.lastName}** (${signing.position}) - ${signing.playerBestOvr} OVR\n`
    }

    if (faSignings.length > 10) {
      message += `\n*...and ${faSignings.length - 10} more signings*\n`
    }
  }

  message += `\n*Auto-posted ${formatSchedule(post.schedule)}*`

  await discordClient!.createMessageWithComponents(channelId, {
    flags: 32768,
    components: [{
      type: ComponentType.TextDisplay,
      content: message
    }]
  })
}
