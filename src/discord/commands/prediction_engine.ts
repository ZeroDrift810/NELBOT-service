/**
 * Prediction Engine for Weekly Pick'em
 * Uses power rankings, team stats, and matchup data to predict game outcomes
 */

import { TeamGameData, PowerRanking, calculatePowerRankings } from "./powerrankings_engine"
import { MaddenGame, Standing } from "../../export/madden_league_types"

export type GamePrediction = {
  game: MaddenGame
  predictedWinner: number // teamId
  predictedLoser: number // teamId
  predictedWinnerScore: number
  predictedLoserScore: number
  confidence: number // 0-100%
  reasoning: string
  homeTeamPowerRank?: number
  awayTeamPowerRank?: number
}

export type GOTWSelection = {
  game: MaddenGame
  gotwScore: number
  reasoning: string[]
  prediction: GamePrediction
}

const HOME_FIELD_ADVANTAGE = 2.5 // Points added to home team

/**
 * Calculate expected score based on team stats
 */
function calculateExpectedScore(
  teamPowerScore: number,
  teamPointsFor: number,
  gamesPlayed: number,
  opponentDefenseRank: number,
  totalTeams: number,
  isHome: boolean
): number {
  const avgPointsPerGame = gamesPlayed > 0 ? teamPointsFor / gamesPlayed : 24

  // Adjust based on opponent defensive strength (0-100 scale)
  const defenseAdjustment = ((totalTeams - opponentDefenseRank) / totalTeams) * 4

  // Power score influence (normalized to points)
  const powerInfluence = (teamPowerScore / 100) * 3

  let expectedScore = avgPointsPerGame + defenseAdjustment + powerInfluence

  // Home field advantage
  if (isHome) {
    expectedScore += HOME_FIELD_ADVANTAGE
  }

  return Math.round(expectedScore)
}

/**
 * Predict a single game outcome
 */
export function predictGame(
  game: MaddenGame,
  homeTeamData: TeamGameData,
  awayTeamData: TeamGameData,
  powerRankings: PowerRanking[],
  teamGameDataList: TeamGameData[],
  totalTeams: number,
  homeTeamStanding: Standing,
  awayTeamStanding: Standing
): GamePrediction {
  const homeRanking = powerRankings.find(r => r.teamId === game.homeTeamId)
  const awayRanking = powerRankings.find(r => r.teamId === game.awayTeamId)

  if (!homeRanking || !awayRanking) {
    throw new Error(`Missing power ranking for game ${game.scheduleId}`)
  }

  // CRITICAL FIX: Create map for all teams, not just home/away
  const teamDataMap = new Map(teamGameDataList.map(t => [t.teamId, t]))

  // Get defensive ranks (sorted by points allowed ascending)
  const allTeamsByDefense = [...powerRankings].sort((a, b) => {
    const teamAData = teamDataMap.get(a.teamId)
    const teamBData = teamDataMap.get(b.teamId)
    return (teamAData?.pointsAgainst || 999) - (teamBData?.pointsAgainst || 999)
  })
  const homeDefRank = allTeamsByDefense.findIndex(r => r.teamId === game.homeTeamId) + 1
  const awayDefRank = allTeamsByDefense.findIndex(r => r.teamId === game.awayTeamId) + 1

  // Calculate expected scores
  const homeExpectedScore = calculateExpectedScore(
    homeRanking.powerScore,
    homeTeamData.pointsFor,
    homeTeamData.gamesPlayed,
    awayDefRank,
    totalTeams,
    true
  )

  const awayExpectedScore = calculateExpectedScore(
    awayRanking.powerScore,
    awayTeamData.pointsFor,
    awayTeamData.gamesPlayed,
    homeDefRank,
    totalTeams,
    false
  )

  // Determine winner
  const homeWins = homeExpectedScore > awayExpectedScore
  const predictedWinner = homeWins ? game.homeTeamId : game.awayTeamId
  const predictedLoser = homeWins ? game.awayTeamId : game.homeTeamId
  const predictedWinnerScore = Math.max(homeExpectedScore, awayExpectedScore)
  const predictedLoserScore = Math.min(homeExpectedScore, awayExpectedScore)

  // Calculate confidence based on power score differential
  const powerDiff = Math.abs(homeRanking.powerScore - awayRanking.powerScore)
  const scoreDiff = Math.abs(homeExpectedScore - awayExpectedScore)

  // Confidence formula: higher power differential + larger score gap = higher confidence
  let confidence = 50 + (powerDiff * 0.5) + (scoreDiff * 2)
  confidence = Math.min(95, Math.max(55, confidence)) // Cap between 55-95%

  // Generate reasoning
  const winnerRank = homeWins ? homeRanking.rank : awayRanking.rank
  const loserRank = homeWins ? awayRanking.rank : homeRanking.rank
  const winnerRecord = homeWins
    ? `${homeTeamStanding.totalWins}-${homeTeamStanding.totalLosses}`
    : `${awayTeamStanding.totalWins}-${awayTeamStanding.totalLosses}`
  const loserRecord = homeWins
    ? `${awayTeamStanding.totalWins}-${awayTeamStanding.totalLosses}`
    : `${homeTeamStanding.totalWins}-${homeTeamStanding.totalLosses}`

  let reasoning = `#${winnerRank} vs #${loserRank} power ranking matchup. `

  if (powerDiff > 10) {
    reasoning += `Significant power advantage (${powerDiff.toFixed(1)} points). `
  } else if (powerDiff > 5) {
    reasoning += `Moderate power edge. `
  } else {
    reasoning += `Close matchup. `
  }

  if (homeWins) {
    reasoning += `Home field advantage decisive.`
  } else {
    reasoning += `Road team overcomes home field.`
  }

  return {
    game,
    predictedWinner,
    predictedLoser,
    predictedWinnerScore,
    predictedLoserScore,
    confidence: Math.round(confidence),
    reasoning,
    homeTeamPowerRank: homeRanking.rank,
    awayTeamPowerRank: awayRanking.rank
  }
}

/**
 * Select Game of the Week based on multiple factors
 */
export function selectGOTW(
  games: MaddenGame[],
  predictions: GamePrediction[],
  powerRankings: PowerRanking[],
  standings: Standing[]
): GOTWSelection {
  // CRITICAL FIX: Only score games that have predictions
  const gameScores: GOTWSelection[] = []

  for (const game of games) {
    const prediction = predictions.find(p => p.game.scheduleId === game.scheduleId)
    const homeRanking = powerRankings.find(r => r.teamId === game.homeTeamId)
    const awayRanking = powerRankings.find(r => r.teamId === game.awayTeamId)
    const homeStanding = standings.find(s => s.teamId === game.homeTeamId)
    const awayStanding = standings.find(s => s.teamId === game.awayTeamId)

    if (!prediction || !homeRanking || !awayRanking || !homeStanding || !awayStanding) {
      console.warn(`Skipping GOTW consideration for game ${game.scheduleId}: Missing data`)
      continue
    }

    let gotwScore = 0
    const reasoning: string[] = []

    // 1. Combined Power Rankings (0-40 points)
    const combinedPower = homeRanking.powerScore + awayRanking.powerScore
    const powerPoints = (combinedPower / 140) * 40 // Normalize to max 40
    gotwScore += powerPoints
    if (combinedPower > 120) {
      reasoning.push(`Elite matchup: Combined power ranking of ${combinedPower.toFixed(1)}`)
    }

    // 2. Record Quality (0-20 points)
    const totalWins = homeStanding.totalWins + awayStanding.totalWins
    const totalGames = (homeStanding.totalWins + homeStanding.totalLosses) +
                      (awayStanding.totalWins + awayStanding.totalLosses)
    const combinedWinPct = totalGames > 0 ? totalWins / totalGames : 0
    const recordPoints = combinedWinPct * 20
    gotwScore += recordPoints
    if (combinedWinPct > 0.75) {
      reasoning.push(`Premium records: Both teams winning at elite rates`)
    }

    // 3. Competitive Balance (0-20 points)
    const rankDiff = Math.abs(homeRanking.rank - awayRanking.rank)
    const balancePoints = Math.max(0, 20 - rankDiff) // Closer rank = higher score
    gotwScore += balancePoints
    if (rankDiff <= 5) {
      reasoning.push(`Highly competitive: Only ${rankDiff} spots separate these teams`)
    }

    // 4. Top 10 Matchup Bonus (0-10 points)
    if (homeRanking.rank <= 10 && awayRanking.rank <= 10) {
      gotwScore += 10
      reasoning.push(`Top-10 showdown: Both teams ranked in elite tier`)
    }

    // 5. Undefeated Teams Bonus (0-10 points)
    if (homeStanding.totalLosses === 0 || awayStanding.totalLosses === 0) {
      gotwScore += 10
      if (homeStanding.totalLosses === 0 && awayStanding.totalLosses === 0) {
        reasoning.push(`Battle of unbeatens: Both teams undefeated`)
      } else {
        reasoning.push(`Undefeated team on the line`)
      }
    }

    gameScores.push({
      game,
      gotwScore,
      reasoning,
      prediction
    })
  }

  if (gameScores.length === 0) {
    throw new Error('No valid games found for GOTW selection')
  }

  // Return game with highest score
  const gotw = gameScores.sort((a, b) => b.gotwScore - a.gotwScore)[0]

  return gotw
}

/**
 * Predict all games for a week
 */
export function predictWeek(
  games: MaddenGame[],
  teamGameDataList: TeamGameData[],
  standings: Standing[]
): GamePrediction[] {
  const powerRankings = calculatePowerRankings(teamGameDataList)

  // CRITICAL FIX: Filter out games with missing data instead of crashing
  const predictions: GamePrediction[] = []

  for (const game of games) {
    const homeTeamData = teamGameDataList.find(t => t.teamId === game.homeTeamId)
    const awayTeamData = teamGameDataList.find(t => t.teamId === game.awayTeamId)
    const homeStanding = standings.find(s => s.teamId === game.homeTeamId)
    const awayStanding = standings.find(s => s.teamId === game.awayTeamId)

    if (!homeTeamData || !awayTeamData || !homeStanding || !awayStanding) {
      console.warn(`Skipping game ${game.scheduleId}: Missing data for teams ${game.homeTeamId} vs ${game.awayTeamId}`)
      continue
    }

    try {
      const prediction = predictGame(
        game,
        homeTeamData,
        awayTeamData,
        powerRankings,
        teamGameDataList,
        teamGameDataList.length,
        homeStanding,
        awayStanding
      )
      predictions.push(prediction)
    } catch (e) {
      console.error(`Error predicting game ${game.scheduleId}:`, e)
    }
  }

  return predictions
}
