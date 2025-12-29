import { ParameterizedContext } from "koa"
import { CommandHandler, Command, MessageComponentHandler, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, formatTeamEmoji } from "../discord_utils"
import { ApplicationCommandType, ComponentType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize, ButtonStyle } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import MaddenDB, { PlayerStatType, TeamList } from "../../db/madden_db"
import LeagueSettingsDB from "../settings_db"
import { leagueLogosView, LeagueLogos } from "../../db/view"
import { MADDEN_SEASON, PassingStats, RushingStats, ReceivingStats, DefensiveStats, Player } from "../../export/madden_league_types"

const MADDEN_PORTRAIT_CDN = "https://ratings-images-prod.pulse.ea.com/madden-nfl-26/portraits"

function getPlayerPortraitUrl(portraitId: number): string {
  return `${MADDEN_PORTRAIT_CDN}/${portraitId}.png`
}

function formatSchemeFit(player: Player): string {
  const schemeOvr = player.playerSchemeOvr || 0
  if (schemeOvr >= 90) return '🟢 Perfect'
  if (schemeOvr >= 80) return '🟡 Good'
  if (schemeOvr >= 70) return '🟠 OK'
  return '🔴 Poor'
}

function formatContract(player: Player): string {
  const yearsLeft = player.contractYearsLeft || 0
  const salary = player.contractSalary || 0
  const capHit = (salary / 1000000).toFixed(1)
  if (yearsLeft <= 0) return 'FA'
  return `${yearsLeft}yr/$${capHit}M`
}

type TopPerformer = {
  category: string
  name: string
  teamEmoji: string
  statLine: string
  rosterId: number
  portraitId?: number
  playerOvr?: number
  schemeFit?: string
  contractInfo?: string
}

type AggregatedStats = {
  passingByPlayer: Map<string, PassingStats>
  rushingByPlayer: Map<string, RushingStats & { rushBrokenTackles: number }>
  receivingByPlayer: Map<string, ReceivingStats & { recYdsAfterCatch: number }>
  defenseByPlayer: Map<string, DefensiveStats & { defDeflections: number, defFumRec: number }>
}

async function fetchPlayerCards(league: string, rosterIds: number[]): Promise<Map<number, Player>> {
  const playerMap = new Map<number, Player>()
  await Promise.all(rosterIds.map(async (rosterId) => {
    try {
      const player = await MaddenDB.getPlayer(league, `${rosterId}`)
      if (player) playerMap.set(rosterId, player)
    } catch (e) {
      // Player not found, skip
    }
  }))
  return playerMap
}

async function aggregateSeasonStats(league: string, seasonIndex: number, weeks: { weekIndex: number }[]): Promise<AggregatedStats> {
  console.log(`📅 Aggregating stats for league ${league}, season ${seasonIndex}, weeks: ${weeks.map(w => w.weekIndex).join(', ')}`)
  const passingByPlayer = new Map<string, PassingStats>()
  const rushingByPlayer = new Map<string, RushingStats & { rushBrokenTackles: number }>()
  const receivingByPlayer = new Map<string, ReceivingStats & { recYdsAfterCatch: number }>()
  const defenseByPlayer = new Map<string, DefensiveStats & { defDeflections: number, defFumRec: number }>()

  for (const week of weeks) {
    try {
      const weeklyStats = await MaddenDB.getWeeklyStats(league, seasonIndex, week.weekIndex)
      const passingCount = weeklyStats[PlayerStatType.PASSING]?.length || 0
      const rushingCount = weeklyStats[PlayerStatType.RUSHING]?.length || 0
      console.log(`  Week ${week.weekIndex}: passing=${passingCount}, rushing=${rushingCount}`)

      if (weeklyStats[PlayerStatType.PASSING]) {
        (weeklyStats[PlayerStatType.PASSING] as PassingStats[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = passingByPlayer.get(key)
          if (existing) {
            existing.passYds += stat.passYds
            existing.passTDs += stat.passTDs
            existing.passInts += stat.passInts
            existing.passAtt += stat.passAtt
            existing.passComp += stat.passComp
            existing.passCompPct = (existing.passComp / existing.passAtt) * 100
          } else {
            passingByPlayer.set(key, { ...stat })
          }
        })
      }

      if (weeklyStats[PlayerStatType.RUSHING]) {
        (weeklyStats[PlayerStatType.RUSHING] as (RushingStats & { rushBrokenTackles: number })[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = rushingByPlayer.get(key)
          if (existing) {
            existing.rushYds += stat.rushYds
            existing.rushTDs += stat.rushTDs
            existing.rushAtt += stat.rushAtt
            existing.rushBrokenTackles = (existing.rushBrokenTackles || 0) + (stat.rushBrokenTackles || 0)
            existing.rushYdsPerAtt = existing.rushYds / existing.rushAtt
          } else {
            rushingByPlayer.set(key, { ...stat, rushBrokenTackles: stat.rushBrokenTackles || 0 })
          }
        })
      }

      if (weeklyStats[PlayerStatType.RECEIVING]) {
        (weeklyStats[PlayerStatType.RECEIVING] as (ReceivingStats & { recYdsAfterCatch: number })[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = receivingByPlayer.get(key)
          if (existing) {
            existing.recYds += stat.recYds
            existing.recTDs += stat.recTDs
            existing.recCatches += stat.recCatches
            existing.recYdsAfterCatch = (existing.recYdsAfterCatch || 0) + (stat.recYdsAfterCatch || 0)
            existing.recYdsPerCatch = existing.recYds / existing.recCatches
            existing.recLongest = Math.max(existing.recLongest, stat.recLongest)
          } else {
            receivingByPlayer.set(key, { ...stat, recYdsAfterCatch: stat.recYdsAfterCatch || 0 })
          }
        })
      }

      if (weeklyStats[PlayerStatType.DEFENSE]) {
        (weeklyStats[PlayerStatType.DEFENSE] as (DefensiveStats & { defDeflections: number, defFumRec: number })[]).forEach(stat => {
          const key = `${stat.rosterId}`
          const existing = defenseByPlayer.get(key)
          if (existing) {
            existing.defTotalTackles += stat.defTotalTackles
            existing.defSacks += stat.defSacks
            existing.defInts += stat.defInts
            existing.defForcedFum += stat.defForcedFum
            existing.defSafeties += stat.defSafeties
            existing.defTDs += stat.defTDs
            existing.defDeflections = (existing.defDeflections || 0) + (stat.defDeflections || 0)
            existing.defFumRec = (existing.defFumRec || 0) + (stat.defFumRec || 0)
          } else {
            defenseByPlayer.set(key, { ...stat, defDeflections: stat.defDeflections || 0, defFumRec: stat.defFumRec || 0 })
          }
        })
      }
    } catch (e) {
      console.log(`⚠️ Failed to fetch week ${week.weekIndex}: ${e}`)
    }
  }

  console.log(`📊 Stats aggregated - Passing: ${passingByPlayer.size}, Rushing: ${rushingByPlayer.size}, Receiving: ${receivingByPlayer.size}, Defense: ${defenseByPlayer.size}`)
  return { passingByPlayer, rushingByPlayer, receivingByPlayer, defenseByPlayer }
}

async function buildOffensePage(
  stats: AggregatedStats,
  teams: TeamList,
  logos: LeagueLogos,
  league: string,
  displaySeason: string,
  gamesPlayed: number
): Promise<any[]> {
  // Get top performers for offense categories
  const topQBs = Array.from(stats.passingByPlayer.values())
    .sort((a, b) => b.passYds - a.passYds)
    .slice(0, 5)

  const topRBs = Array.from(stats.rushingByPlayer.values())
    .filter(s => s.rushAtt >= 50)
    .sort((a, b) => b.rushYds - a.rushYds)
    .slice(0, 5)

  const topBrokenTackles = Array.from(stats.rushingByPlayer.values())
    .filter(s => s.rushBrokenTackles > 0)
    .sort((a, b) => b.rushBrokenTackles - a.rushBrokenTackles)
    .slice(0, 5)

  const topReceivers = Array.from(stats.receivingByPlayer.values())
    .filter(s => s.recCatches >= 20)
    .sort((a, b) => b.recYds - a.recYds)
    .slice(0, 5)

  const topYAC = Array.from(stats.receivingByPlayer.values())
    .filter(s => s.recYdsAfterCatch > 0)
    .sort((a, b) => b.recYdsAfterCatch - a.recYdsAfterCatch)
    .slice(0, 5)

  // Get portraits for #1 leaders
  const leaderRosterIds: number[] = []
  if (topQBs[0]) leaderRosterIds.push(topQBs[0].rosterId)
  if (topRBs[0]) leaderRosterIds.push(topRBs[0].rosterId)
  if (topBrokenTackles[0]) leaderRosterIds.push(topBrokenTackles[0].rosterId)
  if (topReceivers[0]) leaderRosterIds.push(topReceivers[0].rosterId)
  if (topYAC[0]) leaderRosterIds.push(topYAC[0].rosterId)

  const playerCards = await fetchPlayerCards(league, leaderRosterIds)

  // Build category leaders
  const categoryLeaders: TopPerformer[] = []

  if (topQBs[0]) {
    const stat = topQBs[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "🎯 PASSING LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.passYds} YDS | ${stat.passTDs} TD | ${stat.passInts} INT | ${stat.passCompPct.toFixed(1)}%`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topRBs[0]) {
    const stat = topRBs[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    const ypc = stat.rushAtt > 0 ? (stat.rushYds / stat.rushAtt).toFixed(1) : '0.0'
    categoryLeaders.push({
      category: "🏃🏿 RUSHING LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.rushYds} YDS | ${stat.rushTDs} TD | ${stat.rushAtt} ATT | ${ypc} YPC`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topBrokenTackles[0]) {
    const stat = topBrokenTackles[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "💪 BROKEN TACKLE LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.rushBrokenTackles} BT | ${stat.rushYds} YDS | ${stat.rushTDs} TD`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topReceivers[0]) {
    const stat = topReceivers[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    const ypc = stat.recCatches > 0 ? (stat.recYds / stat.recCatches).toFixed(1) : '0.0'
    categoryLeaders.push({
      category: "🙌🏿 RECEIVING LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.recYds} YDS | ${stat.recTDs} TD | ${stat.recCatches} REC | ${ypc} YPC`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topYAC[0]) {
    const stat = topYAC[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    const yacPerCatch = stat.recCatches > 0 ? (stat.recYdsAfterCatch / stat.recCatches).toFixed(1) : '0.0'
    categoryLeaders.push({
      category: "🔥 YAC LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.recYdsAfterCatch} YAC | ${yacPerCatch} YAC/REC | ${stat.recCatches} REC`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  // Build components
  const components: any[] = [
    {
      type: ComponentType.TextDisplay,
      content: `# 🏈 NEL PLAYER RANKINGS - OFFENSE\n## Season ${displaySeason}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    }
  ]

  // Add category leaders with portraits
  for (const leader of categoryLeaders) {
    let content = `### ${leader.category}\n${leader.teamEmoji} **${leader.name}**`
    if (leader.playerOvr) content += ` (${leader.playerOvr} OVR)`
    content += `\n${leader.statLine}`
    if (leader.schemeFit || leader.contractInfo) {
      const extras = []
      if (leader.schemeFit) extras.push(`Fit: ${leader.schemeFit}`)
      if (leader.contractInfo) extras.push(`Contract: ${leader.contractInfo}`)
      content += `\n*${extras.join(' | ')}*`
    }

    components.push({
      type: 9, // Section
      components: [{ type: ComponentType.TextDisplay, content }],
      accessory: leader.portraitId ? {
        type: 11, // Thumbnail
        media: { url: getPlayerPortraitUrl(leader.portraitId) }
      } : undefined
    })
  }

  components.push({
    type: ComponentType.Separator,
    divider: true,
    spacing: SeparatorSpacingSize.Small
  })

  // Full rankings (#2-5)
  let rankings = "### Full Rankings\n"

  if (topQBs.length > 1) {
    rankings += `**Passing:** ${topQBs.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.passYds})`
    }).join(" • ")}\n`
  }

  if (topRBs.length > 1) {
    rankings += `**Rushing:** ${topRBs.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.rushYds})`
    }).join(" • ")}\n`
  }

  if (topBrokenTackles.length > 1) {
    rankings += `**Broken Tackles:** ${topBrokenTackles.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.rushBrokenTackles})`
    }).join(" • ")}\n`
  }

  if (topReceivers.length > 1) {
    rankings += `**Receiving:** ${topReceivers.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.recYds})`
    }).join(" • ")}\n`
  }

  if (topYAC.length > 1) {
    rankings += `**YAC:** ${topYAC.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.recYdsAfterCatch})`
    }).join(" • ")}\n`
  }

  rankings += `\n───────────────────────\n`
  rankings += `Season ${displaySeason} • ${gamesPlayed} games`

  components.push({ type: ComponentType.TextDisplay, content: rankings })

  return components
}

async function buildDefensePage(
  stats: AggregatedStats,
  teams: TeamList,
  logos: LeagueLogos,
  league: string,
  displaySeason: string,
  gamesPlayed: number
): Promise<any[]> {
  console.log(`🛡️ buildDefensePage: defense players count = ${stats.defenseByPlayer.size}`)

  // Get top performers for defense categories
  const topTacklers = Array.from(stats.defenseByPlayer.values())
    .sort((a, b) => b.defTotalTackles - a.defTotalTackles)
    .slice(0, 5)

  const topSackers = Array.from(stats.defenseByPlayer.values())
    .filter(s => s.defSacks > 0)
    .sort((a, b) => b.defSacks - a.defSacks)
    .slice(0, 5)

  const topINTs = Array.from(stats.defenseByPlayer.values())
    .filter(s => s.defInts > 0)
    .sort((a, b) => b.defInts - a.defInts)
    .slice(0, 5)

  const topDeflections = Array.from(stats.defenseByPlayer.values())
    .filter(s => s.defDeflections > 0)
    .sort((a, b) => b.defDeflections - a.defDeflections)
    .slice(0, 5)

  const topFumbleRec = Array.from(stats.defenseByPlayer.values())
    .filter(s => s.defFumRec > 0)
    .sort((a, b) => b.defFumRec - a.defFumRec)
    .slice(0, 5)

  console.log(`🛡️ Defense categories: Tacklers=${topTacklers.length}, Sackers=${topSackers.length}, INTs=${topINTs.length}, Deflections=${topDeflections.length}, FumRec=${topFumbleRec.length}`)

  // Get portraits for #1 leaders
  const leaderRosterIds: number[] = []
  if (topTacklers[0]) leaderRosterIds.push(topTacklers[0].rosterId)
  if (topSackers[0]) leaderRosterIds.push(topSackers[0].rosterId)
  if (topINTs[0]) leaderRosterIds.push(topINTs[0].rosterId)
  if (topDeflections[0]) leaderRosterIds.push(topDeflections[0].rosterId)
  if (topFumbleRec[0]) leaderRosterIds.push(topFumbleRec[0].rosterId)

  const playerCards = await fetchPlayerCards(league, leaderRosterIds)

  // Build category leaders
  const categoryLeaders: TopPerformer[] = []

  if (topTacklers[0]) {
    const stat = topTacklers[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "🛡️ TACKLE LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.defTotalTackles} TKL | ${stat.defSacks} SK | ${stat.defInts} INT`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topSackers[0]) {
    const stat = topSackers[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "💥 SACK LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.defSacks} SK | ${stat.defTotalTackles} TKL | ${stat.defForcedFum} FF`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topINTs[0]) {
    const stat = topINTs[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "🦅 INTERCEPTION LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.defInts} INT | ${stat.defTotalTackles} TKL | ${stat.defTDs} TD`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topDeflections[0]) {
    const stat = topDeflections[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "🎯 DEFLECTION LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.defDeflections} PD | ${stat.defInts} INT | ${stat.defTotalTackles} TKL`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  if (topFumbleRec[0]) {
    const stat = topFumbleRec[0]
    const team = teams.getTeamForId(stat.teamId)
    const player = playerCards.get(stat.rosterId)
    categoryLeaders.push({
      category: "🧲 FUMBLE RECOVERY LEADER",
      name: stat.fullName,
      teamEmoji: formatTeamEmoji(logos, team?.abbrName || ''),
      statLine: `${stat.defFumRec} FR | ${stat.defForcedFum} FF | ${stat.defTotalTackles} TKL`,
      rosterId: stat.rosterId,
      portraitId: player?.portraitId,
      playerOvr: player?.playerBestOvr,
      schemeFit: player ? formatSchemeFit(player) : undefined,
      contractInfo: player ? formatContract(player) : undefined
    })
  }

  // Build components
  const components: any[] = [
    {
      type: ComponentType.TextDisplay,
      content: `# 🛡️ NEL PLAYER RANKINGS - DEFENSE\n## Season ${displaySeason}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    }
  ]

  // Add category leaders with portraits
  for (const leader of categoryLeaders) {
    let content = `### ${leader.category}\n${leader.teamEmoji} **${leader.name}**`
    if (leader.playerOvr) content += ` (${leader.playerOvr} OVR)`
    content += `\n${leader.statLine}`
    if (leader.schemeFit || leader.contractInfo) {
      const extras = []
      if (leader.schemeFit) extras.push(`Fit: ${leader.schemeFit}`)
      if (leader.contractInfo) extras.push(`Contract: ${leader.contractInfo}`)
      content += `\n*${extras.join(' | ')}*`
    }

    components.push({
      type: 9, // Section
      components: [{ type: ComponentType.TextDisplay, content }],
      accessory: leader.portraitId ? {
        type: 11, // Thumbnail
        media: { url: getPlayerPortraitUrl(leader.portraitId) }
      } : undefined
    })
  }

  components.push({
    type: ComponentType.Separator,
    divider: true,
    spacing: SeparatorSpacingSize.Small
  })

  // Full rankings (#2-5)
  let rankings = "### Full Rankings\n"

  if (topTacklers.length > 1) {
    rankings += `**Tackles:** ${topTacklers.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.defTotalTackles})`
    }).join(" • ")}\n`
  }

  if (topSackers.length > 1) {
    rankings += `**Sacks:** ${topSackers.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.defSacks})`
    }).join(" • ")}\n`
  }

  if (topINTs.length > 1) {
    rankings += `**Interceptions:** ${topINTs.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.defInts})`
    }).join(" • ")}\n`
  }

  if (topDeflections.length > 1) {
    rankings += `**Deflections:** ${topDeflections.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.defDeflections})`
    }).join(" • ")}\n`
  }

  if (topFumbleRec.length > 1) {
    rankings += `**Fumble Rec:** ${topFumbleRec.slice(1).map((s, i) => {
      const team = teams.getTeamForId(s.teamId)
      return `${i + 2}. ${formatTeamEmoji(logos, team?.abbrName || '')} ${s.fullName} (${s.defFumRec})`
    }).join(" • ")}\n`
  }

  rankings += `\n───────────────────────\n`
  rankings += `Season ${displaySeason} • ${gamesPlayed} games`

  components.push({ type: ComponentType.TextDisplay, content: rankings })

  return components
}

function addPageSelector(components: any[], currentPage: 'offense' | 'defense', league: string, seasonIndex: number) {
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: currentPage === 'offense' ? ButtonStyle.Primary : ButtonStyle.Secondary,
        label: "🏈 Offense",
        custom_id: JSON.stringify({ pr: 'offense', l: league, s: seasonIndex })
      },
      {
        type: ComponentType.Button,
        style: currentPage === 'defense' ? ButtonStyle.Primary : ButtonStyle.Secondary,
        label: "🛡️ Defense",
        custom_id: JSON.stringify({ pr: 'defense', l: league, s: seasonIndex })
      }
    ]
  })
}

async function generatePlayerRankings(token: string, client: DiscordClient, league: string, page: 'offense' | 'defense' = 'offense') {
  try {
    console.log(`🏅 generatePlayerRankings called: league=${league}, page=${page}`)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "# NEL Player Rankings\n\n⏳ Analyzing player performance across all positions..."
        }
      ]
    })

    const [teams, logos, weeks] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league)
    ])

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0
    const currentWeekIndex = weeks[0]?.weekIndex || 0
    console.log(`📅 Current: season=${currentSeasonIndex}, week=${currentWeekIndex}, total weeks in DB: ${weeks.length}`)

    // Determine target season
    let targetSeasonIndex = currentSeasonIndex
    const currentSeasonWeeks = weeks.filter(w => w.seasonIndex === currentSeasonIndex)
    if (currentSeasonWeeks.length === 0 || currentWeekIndex === 0) {
      const availableSeasons = [...new Set(weeks.map(w => w.seasonIndex))].sort((a, b) => b - a)
      for (const season of availableSeasons) {
        if (season < currentSeasonIndex) {
          const seasonWeeks = weeks.filter(w => w.seasonIndex === season)
          if (seasonWeeks.length > 0) {
            targetSeasonIndex = season
            break
          }
        }
      }
    }

    // Get weeks for target season (regular season only)
    const seasonWeeks = weeks.filter(w =>
      w.seasonIndex === targetSeasonIndex &&
      w.weekIndex >= 0 && w.weekIndex <= 17
    )
    console.log(`📅 Target season: ${targetSeasonIndex}, found ${seasonWeeks.length} regular season weeks`)

    if (seasonWeeks.length === 0) {
      await client.editOriginalInteraction(token, {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `# 🏅 NEL PLAYER RANKINGS\n\n⚠️ No regular season data found for season ${MADDEN_SEASON + targetSeasonIndex}.`
          }
        ]
      })
      return
    }

    // Aggregate stats
    let stats = await aggregateSeasonStats(league, targetSeasonIndex, seasonWeeks)

    // If no stats found for current season, fallback to previous season
    const hasStats = stats.passingByPlayer.size > 0 || stats.rushingByPlayer.size > 0 ||
                     stats.receivingByPlayer.size > 0 || stats.defenseByPlayer.size > 0
    if (!hasStats && targetSeasonIndex > 0) {
      console.log(`⚠️ No stats for season ${targetSeasonIndex}, falling back to season ${targetSeasonIndex - 1}`)
      targetSeasonIndex = targetSeasonIndex - 1
      const prevSeasonWeeks = weeks.filter(w =>
        w.seasonIndex === targetSeasonIndex &&
        w.weekIndex >= 0 && w.weekIndex <= 17
      )
      if (prevSeasonWeeks.length > 0) {
        stats = await aggregateSeasonStats(league, targetSeasonIndex, prevSeasonWeeks)
      }
    }

    const displaySeason = targetSeasonIndex !== currentSeasonIndex ? `${MADDEN_SEASON + targetSeasonIndex} (Final)` : `${MADDEN_SEASON + currentSeasonIndex}`

    // Build page components
    let components: any[]
    if (page === 'offense') {
      components = await buildOffensePage(stats, teams, logos, league, displaySeason, seasonWeeks.length)
    } else {
      components = await buildDefensePage(stats, teams, logos, league, displaySeason, seasonWeeks.length)
    }

    // Add page selector buttons
    addPageSelector(components, page, league, targetSeasonIndex)

    await client.editOriginalInteraction(token, {
      flags: 32768,
      components
    })

  } catch (e) {
    console.error("❌ Error in generatePlayerRankings:", e)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Failed to generate player rankings: ${e}`
        }
      ]
    })
  }
}

async function handlePageSwitch(interaction: MessageComponentInteraction, client: DiscordClient) {
  console.log(`🔄 handlePageSwitch called with custom_id: ${interaction.custom_id}`)
  try {
    const customId = JSON.parse(interaction.custom_id)
    const page = customId.pr as 'offense' | 'defense'
    const league = customId.l as string
    const seasonIndex = customId.s as number
    console.log(`🔄 Switching to page: ${page}, league: ${league}, season: ${seasonIndex}`)

    const [teams, logos, weeks] = await Promise.all([
      MaddenDB.getLatestTeams(league),
      leagueLogosView.createView(league),
      MaddenDB.getAllWeeks(league)
    ])

    let targetSeasonIndex = seasonIndex
    let seasonWeeks = weeks.filter(w =>
      w.seasonIndex === targetSeasonIndex &&
      w.weekIndex >= 0 && w.weekIndex <= 17
    )

    const currentSeasonIndex = weeks[0]?.seasonIndex || 0

    // Aggregate stats
    let stats = await aggregateSeasonStats(league, targetSeasonIndex, seasonWeeks)

    // If no stats found for current season, fallback to previous season
    const hasStats = stats.passingByPlayer.size > 0 || stats.rushingByPlayer.size > 0 ||
                     stats.receivingByPlayer.size > 0 || stats.defenseByPlayer.size > 0
    if (!hasStats && targetSeasonIndex > 0) {
      console.log(`⚠️ No stats for season ${targetSeasonIndex}, falling back to season ${targetSeasonIndex - 1}`)
      targetSeasonIndex = targetSeasonIndex - 1
      seasonWeeks = weeks.filter(w =>
        w.seasonIndex === targetSeasonIndex &&
        w.weekIndex >= 0 && w.weekIndex <= 17
      )
      if (seasonWeeks.length > 0) {
        stats = await aggregateSeasonStats(league, targetSeasonIndex, seasonWeeks)
      }
    }

    const displaySeason = targetSeasonIndex !== currentSeasonIndex ? `${MADDEN_SEASON + targetSeasonIndex} (Final)` : `${MADDEN_SEASON + targetSeasonIndex}`

    let components: any[]
    if (page === 'offense') {
      components = await buildOffensePage(stats, teams, logos, league, displaySeason, seasonWeeks.length)
    } else {
      components = await buildDefensePage(stats, teams, logos, league, displaySeason, seasonWeeks.length)
    }

    addPageSelector(components, page, league, targetSeasonIndex)
    console.log(`✅ Returning ${page} page with ${components.length} components`)

    return {
      type: 7, // UPDATE_MESSAGE
      data: {
        flags: 32768,
        components
      }
    }
  } catch (e) {
    console.error("❌ Error in handlePageSwitch:", e)
    return {
      type: 7,
      data: {
        flags: 32768,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `Failed to switch page: ${e}`
          }
        ]
      }
    }
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id } = command

    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(guild_id)
    if (!leagueSettings.commands.madden_league?.league_id) {
      throw new Error("Could not find a linked Madden league, link a league first")
    }
    const league = leagueSettings.commands.madden_league.league_id

    respond(ctx, deferMessage())
    generatePlayerRankings(command.token, client, league, 'offense')
  },

  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    return handlePageSwitch(interaction, client)
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "playerrankings",
      description: "View top players by position across the season",
      type: ApplicationCommandType.ChatInput,
    }
  }
} as CommandHandler & MessageComponentHandler
