/**
 * Pick'em Database Module
 * Handles storage and retrieval of user picks and predictions
 */

import db from "../db/firebase"
import { FieldValue, Timestamp } from "firebase-admin/firestore"

export type UserPick = {
  userId: string
  userName: string
  scheduleId: number
  predictedWinner: number // teamId
  submittedAt: Timestamp
}

export type WeekPredictions = {
  guildId: string
  leagueId: string
  seasonIndex: number
  weekIndex: number
  botPredictions: {
    [scheduleId: number]: {
      predictedWinner: number
      predictedWinnerScore: number
      predictedLoserScore: number
      confidence: number
      reasoning: string
    }
  }
  userPicks: {
    [userId: string]: {
      userName: string
      picks: {
        [scheduleId: number]: {
          predictedWinner: number
          submittedAt: Timestamp
        }
      }
    }
  }
  gameResults?: {
    [scheduleId: number]: {
      actualWinner: number
      homeScore: number
      awayScore: number
    }
  }
  createdAt: Timestamp
  scoredAt?: Timestamp
  lockedAt?: Timestamp  // When picks were locked (broadcast started or manual lock)
  lockedBy?: string     // "broadcast" or "manual" or userId who locked
}

export type UserSeasonStats = {
  userId: string
  userName: string
  guildId: string
  leagueId: string
  seasonIndex: number
  totalPicks: number
  correctPicks: number
  accuracy: number // 0-100%
  weeklyResults: {
    [weekIndex: number]: {
      picks: number
      correct: number
      accuracy: number
    }
  }
  lastUpdated: Timestamp
}

interface PickemDB {
  // Week predictions management
  saveWeekPredictions(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    botPredictions: WeekPredictions['botPredictions']
  ): Promise<void>

  getWeekPredictions(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<WeekPredictions | null>

  // User picks management
  saveUserPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    userId: string,
    userName: string,
    picks: { [scheduleId: number]: number }
  ): Promise<void>

  getUserPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    userId: string
  ): Promise<UserPick[] | null>

  getAllUserPicksForWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<WeekPredictions['userPicks'] | null>

  // Game results and scoring
  saveGameResults(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    gameResults: WeekPredictions['gameResults']
  ): Promise<void>

  scoreWeekPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<void>

  // Season stats
  getUserSeasonStats(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    userId: string
  ): Promise<UserSeasonStats | null>

  getSeasonLeaderboard(
    guildId: string,
    leagueId: string,
    seasonIndex: number
  ): Promise<UserSeasonStats[]>

  // Lock management
  lockWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    lockedBy: string
  ): Promise<void>

  unlockWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<void>

  isWeekLocked(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<boolean>
}

// Validate Discord snowflake IDs (17-20 digit numbers)
function isValidDiscordId(id: string): boolean {
  return /^\d{17,20}$/.test(id)
}

// Validate league ID (numeric string)
function isValidLeagueId(id: string): boolean {
  return /^\d+$/.test(id)
}

// Validate and sanitize inputs for document keys
function validateDocKeyInputs(guildId: string, leagueId: string, userId?: string): void {
  if (!isValidDiscordId(guildId)) {
    throw new Error(`Invalid guild ID format: ${guildId.substring(0, 30)}`)
  }
  if (!isValidLeagueId(leagueId)) {
    throw new Error(`Invalid league ID format: ${leagueId.substring(0, 30)}`)
  }
  if (userId && !isValidDiscordId(userId)) {
    throw new Error(`Invalid user ID format: ${userId.substring(0, 30)}`)
  }
}

function createWeekKey(guildId: string, leagueId: string, seasonIndex: number, weekIndex: number): string {
  validateDocKeyInputs(guildId, leagueId)
  return `${guildId}_${leagueId}_s${seasonIndex}_w${weekIndex}`
}

function createUserStatsKey(guildId: string, leagueId: string, seasonIndex: number, userId: string): string {
  validateDocKeyInputs(guildId, leagueId, userId)
  return `${guildId}_${leagueId}_s${seasonIndex}_${userId}`
}

const PickemDB: PickemDB = {
  async saveWeekPredictions(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    botPredictions: WeekPredictions['botPredictions']
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    await db.collection('pickem_weeks').doc(weekKey).set({
      guildId,
      leagueId,
      seasonIndex,
      weekIndex,
      botPredictions,
      userPicks: {},
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true })
  },

  async getWeekPredictions(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<WeekPredictions | null> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    const doc = await db.collection('pickem_weeks').doc(weekKey).get()

    if (!doc.exists) {
      return null
    }

    return doc.data() as WeekPredictions
  },

  async saveUserPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    userId: string,
    userName: string,
    picks: { [scheduleId: number]: number }
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)

    // Transform picks to include timestamp
    const picksWithTimestamp: { [scheduleId: number]: { predictedWinner: number, submittedAt: any } } = {}
    for (const scheduleId in picks) {
      picksWithTimestamp[scheduleId] = {
        predictedWinner: picks[scheduleId],
        submittedAt: FieldValue.serverTimestamp()
      }
    }

    // CRITICAL FIX: Get existing picks and merge them to avoid overwriting
    const existing = await this.getWeekPredictions(guildId, leagueId, seasonIndex, weekIndex)
    const existingUserPicks = existing?.userPicks || {}
    const existingPicks = existingUserPicks[userId]?.picks || {}

    // Merge new picks with existing picks
    const mergedPicks = { ...existingPicks, ...picksWithTimestamp }

    await db.collection('pickem_weeks').doc(weekKey).set({
      userPicks: {
        ...existingUserPicks,
        [userId]: {
          userName,
          picks: mergedPicks
        }
      }
    }, { merge: true })
  },

  async getUserPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    userId: string
  ): Promise<UserPick[] | null> {
    const weekData = await this.getWeekPredictions(guildId, leagueId, seasonIndex, weekIndex)

    if (!weekData || !weekData.userPicks || !weekData.userPicks[userId]) {
      return null
    }

    const userPicksData = weekData.userPicks[userId]
    const picks: UserPick[] = []

    for (const scheduleId in userPicksData.picks) {
      picks.push({
        userId,
        userName: userPicksData.userName,
        scheduleId: parseInt(scheduleId),
        predictedWinner: userPicksData.picks[scheduleId].predictedWinner,
        submittedAt: userPicksData.picks[scheduleId].submittedAt
      })
    }

    return picks
  },

  async getAllUserPicksForWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<WeekPredictions['userPicks'] | null> {
    const weekData = await this.getWeekPredictions(guildId, leagueId, seasonIndex, weekIndex)

    if (!weekData) {
      return null
    }

    return weekData.userPicks || {}
  },

  async saveGameResults(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    gameResults: WeekPredictions['gameResults']
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    await db.collection('pickem_weeks').doc(weekKey).set({
      gameResults
    }, { merge: true })
  },

  async scoreWeekPicks(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    const weekRef = db.collection('pickem_weeks').doc(weekKey)

    // Use transaction to prevent race condition on scoring
    const weekData = await db.runTransaction(async (transaction) => {
      const weekDoc = await transaction.get(weekRef)

      if (!weekDoc.exists) {
        console.warn(`Cannot score week ${weekIndex} - no week data found`)
        return null
      }

      const data = weekDoc.data() as WeekPredictions

      if (!data.gameResults) {
        console.warn(`Cannot score week ${weekIndex} - no game results available`)
        return null
      }

      // Check if already scored (idempotency) - within transaction
      if (data.scoredAt) {
        console.log(`Week ${weekIndex} already scored at ${data.scoredAt}. Skipping.`)
        return null
      }

      // Mark as scored within the same transaction to prevent race condition
      transaction.update(weekRef, {
        scoredAt: FieldValue.serverTimestamp()
      })

      return data
    })

    // Exit if transaction determined no scoring needed
    if (!weekData) {
      return
    }

    const gameResults = weekData.gameResults!
    const userPicks = weekData.userPicks

    // MAJOR FIX: Collect all updates to execute in parallel
    const updatePromises: Promise<any>[] = []

    // Score each user's picks
    for (const userId in userPicks) {
      const userData = userPicks[userId]
      let totalPicks = 0
      let correctPicks = 0

      for (const scheduleId in userData.picks) {
        const userPick = userData.picks[scheduleId]
        const gameResult = gameResults[parseInt(scheduleId)]

        if (gameResult) {
          totalPicks++
          if (userPick.predictedWinner === gameResult.actualWinner) {
            correctPicks++
          }
        }
      }

      const accuracy = totalPicks > 0 ? (correctPicks / totalPicks) * 100 : 0

      // Update user season stats
      const statsKey = createUserStatsKey(guildId, leagueId, seasonIndex, userId)

      // MAJOR FIX: Use async function to avoid race conditions
      const updateStatsPromise = (async () => {
        const statsDoc = await db.collection('pickem_stats').doc(statsKey).get()

        if (statsDoc.exists) {
          const currentStats = statsDoc.data() as UserSeasonStats
          const newTotal = currentStats.totalPicks + totalPicks
          const newCorrect = currentStats.correctPicks + correctPicks
          // MINOR FIX: Prevent NaN
          const newAccuracy = newTotal > 0 ? (newCorrect / newTotal) * 100 : 0

          await db.collection('pickem_stats').doc(statsKey).update({
            totalPicks: newTotal,
            correctPicks: newCorrect,
            accuracy: newAccuracy,
            [`weeklyResults.${weekIndex}`]: {
              picks: totalPicks,
              correct: correctPicks,
              accuracy
            },
            lastUpdated: FieldValue.serverTimestamp()
          })
        } else {
          // Create new stats entry
          await db.collection('pickem_stats').doc(statsKey).set({
            userId,
            userName: userData.userName,
            guildId,
            leagueId,
            seasonIndex,
            totalPicks,
            correctPicks,
            accuracy,
            weeklyResults: {
              [weekIndex]: {
                picks: totalPicks,
                correct: correctPicks,
                accuracy
              }
            },
            lastUpdated: FieldValue.serverTimestamp()
          })
        }
      })()

      updatePromises.push(updateStatsPromise)
    }

    // Execute all user stats updates in parallel
    await Promise.all(updatePromises)

    // scoredAt is now marked in the transaction above to prevent race conditions
  },

  async getUserSeasonStats(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    userId: string
  ): Promise<UserSeasonStats | null> {
    const statsKey = createUserStatsKey(guildId, leagueId, seasonIndex, userId)
    const doc = await db.collection('pickem_stats').doc(statsKey).get()

    if (!doc.exists) {
      return null
    }

    return doc.data() as UserSeasonStats
  },

  async getSeasonLeaderboard(
    guildId: string,
    leagueId: string,
    seasonIndex: number
  ): Promise<UserSeasonStats[]> {
    // MINOR FIX: Use client-side sorting to avoid compound index requirement
    const snapshot = await db.collection('pickem_stats')
      .where('guildId', '==', guildId)
      .where('leagueId', '==', leagueId)
      .where('seasonIndex', '==', seasonIndex)
      .get()

    const leaderboard = snapshot.docs.map(doc => doc.data() as UserSeasonStats)

    // Sort by accuracy (desc), then by totalPicks (desc) as tiebreaker
    return leaderboard.sort((a, b) => {
      if (a.accuracy !== b.accuracy) {
        return b.accuracy - a.accuracy
      }
      return b.totalPicks - a.totalPicks
    })
  },

  async lockWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number,
    lockedBy: string
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    await db.collection('pickem_weeks').doc(weekKey).set({
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy
    }, { merge: true })
    console.log(`🔒 Pick'em locked for Week ${weekIndex + 1} by ${lockedBy}`)
  },

  async unlockWeek(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<void> {
    const weekKey = createWeekKey(guildId, leagueId, seasonIndex, weekIndex)
    await db.collection('pickem_weeks').doc(weekKey).update({
      lockedAt: FieldValue.delete(),
      lockedBy: FieldValue.delete()
    })
    console.log(`🔓 Pick'em unlocked for Week ${weekIndex + 1}`)
  },

  async isWeekLocked(
    guildId: string,
    leagueId: string,
    seasonIndex: number,
    weekIndex: number
  ): Promise<boolean> {
    const weekData = await this.getWeekPredictions(guildId, leagueId, seasonIndex, weekIndex)
    return weekData?.lockedAt != null
  }
}

export default PickemDB
