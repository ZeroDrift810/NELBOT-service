/**
 * Power Rankings Engine v1
 *
 * Calculates team power scores based on:
 * - Win percentage (25%)
 * - Efficiency - Net yards per play (30%)
 * - Margin of victory (15%)
 * - Turnover differential (15%)
 * - Strength of schedule (15%)
 */

import { Standing } from "../../export/madden_league_types"

export type TeamGameData = {
  teamId: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
  totalOffYards: number
  totalOffPlays: number
  totalDefYardsAllowed: number
  totalDefPlaysFaced: number
  takeaways: number
  giveaways: number
  opponentTeamIds: number[]
}

type RawMetrics = {
  winPct: number
  netYPP: number
  cappedMOV: number
  toDiffPG: number
  oppWinPctAvg: number
}

type PercentileMetrics = {
  WQ: number  // Win quality
  EFF: number // Efficiency
  MOV: number // Margin of victory
  TOD: number // Turnover differential
  SOS: number // Strength of schedule
}

export type PowerRanking = {
  teamId: number
  rank: number
  powerScore: number
  breakdown: PercentileMetrics
  rawMetrics: RawMetrics
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Calculate percentile (0-100) for a value among all teams
 */
function calculatePercentile(value: number, allValues: number[]): number {
  const sorted = [...allValues].sort((a, b) => a - b)
  const rank = sorted.filter(v => v < value).length
  const percentile = (rank / (allValues.length - 1)) * 100
  return Math.max(0, Math.min(100, percentile))
}

/**
 * Calculate raw metrics for a team
 */
function calculateRawMetrics(
  team: TeamGameData,
  allTeams: Map<number, TeamGameData>
): RawMetrics {
  const winPct = team.gamesPlayed > 0 ? team.wins / team.gamesPlayed : 0

  const offYPP = team.totalOffPlays > 0 ? team.totalOffYards / team.totalOffPlays : 0
  const defYPP = team.totalDefPlaysFaced > 0 ? team.totalDefYardsAllowed / team.totalDefPlaysFaced : 0
  const netYPP = offYPP - defYPP

  const avgMOV = team.gamesPlayed > 0
    ? (team.pointsFor - team.pointsAgainst) / team.gamesPlayed
    : 0
  const cappedMOV = clamp(avgMOV, -21, 21)

  const toDiffPG = team.gamesPlayed > 0
    ? (team.takeaways - team.giveaways) / team.gamesPlayed
    : 0

  // Strength of schedule: average opponent win percentage
  let oppWinPctSum = 0
  let oppCount = 0
  for (const oppId of team.opponentTeamIds) {
    const opponent = allTeams.get(oppId)
    if (opponent && opponent.gamesPlayed > 0) {
      oppWinPctSum += opponent.wins / opponent.gamesPlayed
      oppCount++
    }
  }
  const oppWinPctAvg = oppCount > 0 ? oppWinPctSum / oppCount : 0.5

  return {
    winPct,
    netYPP,
    cappedMOV,
    toDiffPG,
    oppWinPctAvg
  }
}

/**
 * Calculate power rankings for all teams
 */
export function calculatePowerRankings(teams: TeamGameData[]): PowerRanking[] {
  console.log(`⚡ Power Rankings Engine: Processing ${teams.length} teams`)

  // Build team map for quick lookup
  const teamMap = new Map<number, TeamGameData>()
  teams.forEach(t => teamMap.set(t.teamId, t))

  // Calculate raw metrics for all teams
  const teamMetrics = teams.map(team => ({
    teamId: team.teamId,
    raw: calculateRawMetrics(team, teamMap)
  }))

  console.log(`⚡ Sample raw metrics:`, teamMetrics[0])

  // Extract all values for percentile calculation
  const allWinPct = teamMetrics.map(t => t.raw.winPct)
  const allNetYPP = teamMetrics.map(t => t.raw.netYPP)
  const allCappedMOV = teamMetrics.map(t => t.raw.cappedMOV)
  const allToDiffPG = teamMetrics.map(t => t.raw.toDiffPG)
  const allOppWinPctAvg = teamMetrics.map(t => t.raw.oppWinPctAvg)

  // Calculate percentiles and power scores
  const rankings = teamMetrics.map(({ teamId, raw }) => {
    const percentiles: PercentileMetrics = {
      WQ: calculatePercentile(raw.winPct, allWinPct),
      EFF: calculatePercentile(raw.netYPP, allNetYPP),
      MOV: calculatePercentile(raw.cappedMOV, allCappedMOV),
      TOD: calculatePercentile(raw.toDiffPG, allToDiffPG),
      SOS: calculatePercentile(raw.oppWinPctAvg, allOppWinPctAvg)
    }

    const powerScore =
      0.30 * percentiles.EFF +
      0.25 * percentiles.WQ +
      0.15 * percentiles.MOV +
      0.15 * percentiles.TOD +
      0.15 * percentiles.SOS

    return {
      teamId,
      rank: 0, // Will be set after sorting
      powerScore: Math.round(powerScore * 10) / 10,
      breakdown: percentiles,
      rawMetrics: raw
    }
  })

  // Sort by power score descending
  rankings.sort((a, b) => b.powerScore - a.powerScore)

  // Assign ranks
  rankings.forEach((r, i) => r.rank = i + 1)

  return rankings
}
