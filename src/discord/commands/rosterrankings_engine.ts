import { Player, DevTrait } from "../../export/madden_league_types"

// Position groups for evaluation
const POSITION_GROUPS = {
  QB: ['QB'],
  RB: ['HB', 'FB'],
  WR: ['WR'],
  TE: ['TE'],
  OL: ['LT', 'LG', 'C', 'RG', 'RT'],
  DL: ['LE', 'RE', 'DT', 'LOLB', 'ROLB'], // Edge rushers included
  LB: ['MLB', 'LOLB', 'ROLB'],
  DB: ['CB', 'FS', 'SS']
}

// Starter counts per position group
const STARTER_COUNTS: { [key: string]: number } = {
  QB: 1,
  RB: 2, // HB + FB or 2 HBs
  WR: 3,
  TE: 1,
  OL: 5,
  DL: 4, // 2 DE + 2 DT
  LB: 3,
  DB: 4 // 2 CB + FS + SS
}

export type PositionGroupGrade = {
  name: string
  avgOvr: number
  starterOvr: number
  depth: number
  eliteCount: number
  grade: string // A+, A, B+, B, C+, C, D, F
}

export type TeamRosterData = {
  teamId: number
  teamName: string
  players: Player[]
}

export type TeamRosterRanking = {
  rank: number
  teamId: number
  teamName: string
  rosterScore: number
  avgOvr: number
  starterOvr: number
  eliteCount: number // 85+
  superEliteCount: number // 90+
  xFactorCount: number
  superstarCount: number
  positionGrades: PositionGroupGrade[]
  topPlayers: Player[]
  weakestGroup: string
  strongestGroup: string
}

function getGradeForOvr(ovr: number): string {
  if (ovr >= 88) return 'A+'
  if (ovr >= 85) return 'A'
  if (ovr >= 82) return 'B+'
  if (ovr >= 79) return 'B'
  if (ovr >= 76) return 'C+'
  if (ovr >= 73) return 'C'
  if (ovr >= 70) return 'D'
  return 'F'
}

function calculatePositionGroupGrade(players: Player[], groupName: string, positions: string[], starterCount: number): PositionGroupGrade {
  const groupPlayers = players
    .filter(p => positions.includes(p.position))
    .sort((a, b) => b.playerBestOvr - a.playerBestOvr)

  if (groupPlayers.length === 0) {
    return {
      name: groupName,
      avgOvr: 0,
      starterOvr: 0,
      depth: 0,
      eliteCount: 0,
      grade: 'F'
    }
  }

  const starters = groupPlayers.slice(0, starterCount)
  const avgOvr = groupPlayers.reduce((sum, p) => sum + p.playerBestOvr, 0) / groupPlayers.length
  const starterOvr = starters.reduce((sum, p) => sum + p.playerBestOvr, 0) / starters.length
  const eliteCount = groupPlayers.filter(p => p.playerBestOvr >= 85).length
  const depth = groupPlayers.length

  return {
    name: groupName,
    avgOvr: Math.round(avgOvr * 10) / 10,
    starterOvr: Math.round(starterOvr * 10) / 10,
    depth,
    eliteCount,
    grade: getGradeForOvr(starterOvr)
  }
}

export function calculateTeamRosterScore(team: TeamRosterData): TeamRosterRanking {
  const { teamId, teamName, players } = team

  // Filter out players with teamId 0 (free agents on roster somehow)
  const rosterPlayers = players.filter(p => p.teamId === teamId)

  // Calculate position group grades
  const positionGrades: PositionGroupGrade[] = []
  for (const [groupName, positions] of Object.entries(POSITION_GROUPS)) {
    const starterCount = STARTER_COUNTS[groupName] || 1
    const grade = calculatePositionGroupGrade(rosterPlayers, groupName, positions, starterCount)
    positionGrades.push(grade)
  }

  // Calculate overall metrics
  const avgOvr = rosterPlayers.length > 0
    ? rosterPlayers.reduce((sum, p) => sum + p.playerBestOvr, 0) / rosterPlayers.length
    : 0

  // Get top 22 starters (11 offense, 11 defense approximation)
  const sortedPlayers = [...rosterPlayers].sort((a, b) => b.playerBestOvr - a.playerBestOvr)
  const top22 = sortedPlayers.slice(0, 22)
  const starterOvr = top22.length > 0
    ? top22.reduce((sum, p) => sum + p.playerBestOvr, 0) / top22.length
    : 0

  // Count elite players
  const eliteCount = rosterPlayers.filter(p => p.playerBestOvr >= 85).length
  const superEliteCount = rosterPlayers.filter(p => p.playerBestOvr >= 90).length

  // Count dev traits
  const xFactorCount = rosterPlayers.filter(p => p.devTrait === DevTrait.XFACTOR).length
  const superstarCount = rosterPlayers.filter(p => p.devTrait === DevTrait.SUPERSTAR).length

  // Find strongest and weakest position groups
  const validGrades = positionGrades.filter(g => g.depth > 0)
  const sortedByOvr = [...validGrades].sort((a, b) => b.starterOvr - a.starterOvr)
  const strongestGroup = sortedByOvr[0]?.name || 'N/A'
  const weakestGroup = sortedByOvr[sortedByOvr.length - 1]?.name || 'N/A'

  // Calculate composite roster score
  // Weights: Starter OVR (40%), Elite count (20%), X-Factor/SS (15%), Depth (10%), Position balance (15%)
  const starterScore = starterOvr * 0.4
  const eliteScore = Math.min(eliteCount * 2, 30) * 0.2 // Cap at 15 elite players
  const devTraitScore = (xFactorCount * 5 + superstarCount * 3) * 0.15
  const depthScore = Math.min(rosterPlayers.length / 53, 1) * 10 * 0.1

  // Position balance - penalize teams with very weak groups
  const lowestGradeOvr = validGrades.length > 0
    ? Math.min(...validGrades.map(g => g.starterOvr))
    : 0
  const balanceScore = (lowestGradeOvr / 100) * 15 * 0.15

  const rosterScore = Math.round((starterScore + eliteScore + devTraitScore + depthScore + balanceScore) * 10) / 10

  // Get top 5 players for display
  const topPlayers = sortedPlayers.slice(0, 5)

  return {
    rank: 0, // Will be set after sorting all teams
    teamId,
    teamName,
    rosterScore,
    avgOvr: Math.round(avgOvr * 10) / 10,
    starterOvr: Math.round(starterOvr * 10) / 10,
    eliteCount,
    superEliteCount,
    xFactorCount,
    superstarCount,
    positionGrades,
    topPlayers,
    weakestGroup,
    strongestGroup
  }
}

export function calculateRosterRankings(teams: TeamRosterData[]): TeamRosterRanking[] {
  // Calculate scores for all teams
  const rankings = teams.map(team => calculateTeamRosterScore(team))

  // Sort by roster score descending
  rankings.sort((a, b) => b.rosterScore - a.rosterScore)

  // Assign ranks
  rankings.forEach((team, index) => {
    team.rank = index + 1
  })

  return rankings
}
