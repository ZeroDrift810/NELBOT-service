/**
 * Custom Dev Trait Progression/Regression System
 * Based on statistical performance rankings within position groups
 */

import { Player, DevTrait, PassingStats, RushingStats, ReceivingStats, DefensiveStats, KickingStats, PuntingStats } from "../export/madden_league_types"
import { PlayerStats, PlayerStatType } from "../db/madden_db"

export type PositionGroup =
  | "QB"
  | "RB"
  | "WR"
  | "TE"
  | "DL"
  | "LB"
  | "DB"
  | "K"
  | "P"
  | "OL"

export type TraitChange = {
  player: Player
  oldTrait: DevTrait
  newTrait: DevTrait
  reason: string
  stats: PlayerPerformanceStats
  ranking: number
  totalInPosition: number
}

export type PlayerPerformanceStats = {
  rosterId: number
  fullName: string
  position: string
  teamId: number
  currentTrait: DevTrait
  yearsPro: number
  // Aggregated season stats
  gamesPlayed: number
  score: number // Composite score for ranking
  statDetails: string // Human-readable stat breakdown
}

export type SeasonPerformanceReport = {
  seasonIndex: number
  upgrades: TraitChange[]
  downgrades: TraitChange[]
  maintained: TraitChange[]
}

/**
 * Map player position to position group for rankings
 */
export function getPositionGroup(position: string): PositionGroup {
  const pos = position.toUpperCase()

  if (pos === "QB") return "QB"
  if (["HB", "FB"].includes(pos)) return "RB"
  if (["WR"].includes(pos)) return "WR"
  if (["TE"].includes(pos)) return "TE"
  if (["DT", "DE", "LE", "RE"].includes(pos)) return "DL"
  if (["LOLB", "MLB", "ROLB", "LB"].includes(pos)) return "LB"
  if (["CB", "FS", "SS", "DB"].includes(pos)) return "DB"
  if (["K"].includes(pos)) return "K"
  if (["P"].includes(pos)) return "P"
  if (["LT", "LG", "C", "RG", "RT"].includes(pos)) return "OL"

  return "OL" // Default
}

/**
 * Calculate performance score for QB
 */
function calculateQBScore(stats: PassingStats[]): { score: number, details: string } {
  if (stats.length === 0) return { score: 0, details: "No stats" }

  const totals = stats.reduce((acc, stat) => ({
    passerRating: acc.passerRating + stat.passerRating,
    passTDs: acc.passTDs + stat.passTDs,
    passYds: acc.passYds + stat.passYds,
    passInts: acc.passInts + stat.passInts,
    games: acc.games + 1
  }), { passerRating: 0, passTDs: 0, passYds: 0, passInts: 0, games: 0 })

  const avgRating = totals.passerRating / totals.games
  const tdIntRatio = totals.passInts > 0 ? totals.passTDs / totals.passInts : totals.passTDs

  // Weighted score: Rating (40%), TDs (30%), Yards (20%), TD:INT ratio (10%)
  const score = (avgRating * 0.4) + (totals.passTDs * 15 * 0.3) + (totals.passYds / 40 * 0.2) + (tdIntRatio * 20 * 0.1)

  const details = `${totals.passTDs} TDs, ${totals.passYds} yds, ${avgRating.toFixed(1)} rating, ${totals.passInts} INTs (${totals.games} games)`

  return { score, details }
}

/**
 * Calculate performance score for RB
 */
function calculateRBScore(rushStats: RushingStats[], recStats: ReceivingStats[]): { score: number, details: string } {
  const rushTotals = rushStats.reduce((acc, stat) => ({
    rushYds: acc.rushYds + stat.rushYds,
    rushTDs: acc.rushTDs + stat.rushTDs,
    rushAtt: acc.rushAtt + stat.rushAtt,
    games: acc.games + 1
  }), { rushYds: 0, rushTDs: 0, rushAtt: 0, games: 0 })

  const recTotals = recStats.reduce((acc, stat) => ({
    recYds: acc.recYds + stat.recYds,
    recTDs: acc.recTDs + stat.recTDs,
    recCatches: acc.recCatches + stat.recCatches
  }), { recYds: 0, recTDs: 0, recCatches: 0 })

  if (rushTotals.games === 0) return { score: 0, details: "No stats" }

  const ypc = rushTotals.rushAtt > 0 ? rushTotals.rushYds / rushTotals.rushAtt : 0
  const totalTDs = rushTotals.rushTDs + recTotals.recTDs
  const totalYards = rushTotals.rushYds + recTotals.recYds

  // Weighted score: Total Yards (40%), TDs (35%), YPC (15%), Receptions (10%)
  const score = (totalYards / 15 * 0.4) + (totalTDs * 20 * 0.35) + (ypc * 15 * 0.15) + (recTotals.recCatches * 1.5 * 0.1)

  const details = `${rushTotals.rushYds} rush yds, ${rushTotals.rushTDs} rush TDs, ${recTotals.recYds} rec yds, ${recTotals.recTDs} rec TDs (${rushTotals.games} games)`

  return { score, details }
}

/**
 * Calculate performance score for WR/TE
 */
function calculateReceiverScore(stats: ReceivingStats[]): { score: number, details: string } {
  if (stats.length === 0) return { score: 0, details: "No stats" }

  const totals = stats.reduce((acc, stat) => ({
    recYds: acc.recYds + stat.recYds,
    recTDs: acc.recTDs + stat.recTDs,
    recCatches: acc.recCatches + stat.recCatches,
    games: acc.games + 1
  }), { recYds: 0, recTDs: 0, recCatches: 0, games: 0 })

  const ypc = totals.recCatches > 0 ? totals.recYds / totals.recCatches : 0

  // Weighted score: Yards (40%), TDs (35%), Catches (15%), YPC (10%)
  const score = (totals.recYds / 15 * 0.4) + (totals.recTDs * 25 * 0.35) + (totals.recCatches * 2 * 0.15) + (ypc * 5 * 0.1)

  const details = `${totals.recYds} yds, ${totals.recTDs} TDs, ${totals.recCatches} catches, ${ypc.toFixed(1)} YPC (${totals.games} games)`

  return { score, details }
}

/**
 * Calculate performance score for Defensive players
 */
function calculateDefensiveScore(stats: DefensiveStats[], positionGroup: PositionGroup): { score: number, details: string } {
  if (stats.length === 0) return { score: 0, details: "No stats" }

  const totals = stats.reduce((acc, stat) => ({
    tackles: acc.tackles + stat.defTotalTackles,
    sacks: acc.sacks + stat.defSacks,
    ints: acc.ints + stat.defInts,
    forcedFum: acc.forcedFum + stat.defForcedFum,
    tds: acc.tds + stat.defTDs,
    deflections: acc.deflections + stat.defDeflections,
    games: acc.games + 1
  }), { tackles: 0, sacks: 0, ints: 0, forcedFum: 0, tds: 0, deflections: 0, games: 0 })

  // Different weights based on position
  let score = 0
  if (positionGroup === "DL") {
    // DL: Sacks (50%), Tackles (30%), Forced Fumbles (20%)
    score = (totals.sacks * 30 * 0.5) + (totals.tackles * 1.5 * 0.3) + (totals.forcedFum * 40 * 0.2)
  } else if (positionGroup === "LB") {
    // LB: Tackles (45%), Sacks (30%), INTs (15%), Forced Fumbles (10%)
    score = (totals.tackles * 2 * 0.45) + (totals.sacks * 25 * 0.3) + (totals.ints * 35 * 0.15) + (totals.forcedFum * 30 * 0.1)
  } else if (positionGroup === "DB") {
    // DB: INTs (40%), Deflections (30%), Tackles (20%), TDs (10%)
    score = (totals.ints * 40 * 0.4) + (totals.deflections * 8 * 0.3) + (totals.tackles * 1.5 * 0.2) + (totals.tds * 50 * 0.1)
  }

  const details = `${totals.tackles} tkl, ${totals.sacks} sacks, ${totals.ints} INT, ${totals.forcedFum} FF (${totals.games} games)`

  return { score, details }
}

/**
 * Calculate performance score for Kickers
 */
function calculateKickerScore(stats: KickingStats[]): { score: number, details: string } {
  if (stats.length === 0) return { score: 0, details: "No stats" }

  const totals = stats.reduce((acc, stat) => ({
    fgMade: acc.fgMade + stat.fGMade,
    fgAtt: acc.fgAtt + stat.fGAtt,
    fg50Made: acc.fg50Made + stat.fG50PlusMade,
    fg50Att: acc.fg50Att + stat.fG50PlusAtt,
    xpMade: acc.xpMade + stat.xPMade,
    xpAtt: acc.xpAtt + stat.xPAtt,
    games: acc.games + 1
  }), { fgMade: 0, fgAtt: 0, fg50Made: 0, fg50Att: 0, xpMade: 0, xpAtt: 0, games: 0 })

  const fgPct = totals.fgAtt > 0 ? (totals.fgMade / totals.fgAtt) * 100 : 0
  const xpPct = totals.xpAtt > 0 ? (totals.xpMade / totals.xpAtt) * 100 : 0
  const fg50Pct = totals.fg50Att > 0 ? (totals.fg50Made / totals.fg50Att) * 100 : 0

  // Weighted score: FG% (60%), 50+ FG% (25%), XP% (15%)
  const score = (fgPct * 0.6) + (fg50Pct * 0.25) + (xpPct * 0.15)

  const details = `${totals.fgMade}/${totals.fgAtt} FG (${fgPct.toFixed(1)}%), ${totals.fg50Made}/${totals.fg50Att} 50+ (${totals.games} games)`

  return { score, details }
}

/**
 * Calculate performance score for Punters
 */
function calculatePunterScore(stats: PuntingStats[]): { score: number, details: string } {
  if (stats.length === 0) return { score: 0, details: "No stats" }

  const totals = stats.reduce((acc, stat) => ({
    puntYds: acc.puntYds + stat.puntYds,
    punts: acc.punts + stat.puntAtt,
    puntTBs: acc.puntTBs + stat.puntTBs,
    puntsIn20: acc.puntsIn20 + stat.puntsIn20,
    games: acc.games + 1
  }), { puntYds: 0, punts: 0, puntTBs: 0, puntsIn20: 0, games: 0 })

  const avgYards = totals.punts > 0 ? totals.puntYds / totals.punts : 0
  const in20Pct = totals.punts > 0 ? (totals.puntsIn20 / totals.punts) * 100 : 0

  // Weighted score: Avg Yards (60%), Inside 20% (30%), Touchbacks (10% penalty)
  const score = (avgYards * 1.5 * 0.6) + (in20Pct * 0.3) - (totals.puntTBs * 5 * 0.1)

  const details = `${avgYards.toFixed(1)} avg, ${totals.puntsIn20}/${totals.punts} in 20 (${totals.games} games)`

  return { score, details }
}

/**
 * Aggregate player performance for the season
 */
export function aggregatePlayerPerformance(
  player: Player,
  stats: PlayerStats
): PlayerPerformanceStats {
  const positionGroup = getPositionGroup(player.position)
  let scoreData = { score: 0, details: "No stats", games: 0 }

  switch (positionGroup) {
    case "QB":
      if (stats[PlayerStatType.PASSING] && stats[PlayerStatType.PASSING]!.length > 0) {
        const qbScore = calculateQBScore(stats[PlayerStatType.PASSING]!)
        scoreData = { ...qbScore, games: stats[PlayerStatType.PASSING]!.length }
      }
      break
    case "RB":
      if (stats[PlayerStatType.RUSHING] && stats[PlayerStatType.RUSHING]!.length > 0) {
        const rbScore = calculateRBScore(stats[PlayerStatType.RUSHING]!, stats[PlayerStatType.RECEIVING] || [])
        scoreData = { ...rbScore, games: stats[PlayerStatType.RUSHING]!.length }
      }
      break
    case "WR":
    case "TE":
      if (stats[PlayerStatType.RECEIVING] && stats[PlayerStatType.RECEIVING]!.length > 0) {
        const recScore = calculateReceiverScore(stats[PlayerStatType.RECEIVING]!)
        scoreData = { ...recScore, games: stats[PlayerStatType.RECEIVING]!.length }
      }
      break
    case "DL":
    case "LB":
    case "DB":
      if (stats[PlayerStatType.DEFENSE] && stats[PlayerStatType.DEFENSE]!.length > 0) {
        const defScore = calculateDefensiveScore(stats[PlayerStatType.DEFENSE]!, positionGroup)
        scoreData = { ...defScore, games: stats[PlayerStatType.DEFENSE]!.length }
      }
      break
    case "K":
      if (stats[PlayerStatType.KICKING] && stats[PlayerStatType.KICKING]!.length > 0) {
        const kScore = calculateKickerScore(stats[PlayerStatType.KICKING]!)
        scoreData = { ...kScore, games: stats[PlayerStatType.KICKING]!.length }
      }
      break
    case "P":
      if (stats[PlayerStatType.PUNTING] && stats[PlayerStatType.PUNTING]!.length > 0) {
        const pScore = calculatePunterScore(stats[PlayerStatType.PUNTING]!)
        scoreData = { ...pScore, games: stats[PlayerStatType.PUNTING]!.length }
      }
      break
    default:
      scoreData = { score: 0, details: "OL - Manual review recommended", games: 0 }
  }

  return {
    rosterId: player.rosterId,
    fullName: `${player.firstName} ${player.lastName}`,
    position: player.position,
    teamId: player.teamId,
    currentTrait: player.devTrait,
    yearsPro: player.yearsPro,
    gamesPlayed: scoreData.games,
    score: scoreData.score,
    statDetails: scoreData.details
  }
}

/**
 * Determine if a player should upgrade/downgrade/maintain their trait
 */
export function evaluateTraitChange(
  performance: PlayerPerformanceStats,
  ranking: number,
  totalInPosition: number
): DevTrait | null {
  const { currentTrait, yearsPro, gamesPlayed } = performance

  // Minimum games played requirement (at least 25% of season)
  const minGames = 4
  if (gamesPlayed < minGames) {
    return null // Not enough playing time, maintain current
  }

  // Calculate percentile
  const percentile = (ranking / totalInPosition) * 100

  // Upgrade rules
  if (currentTrait === DevTrait.NORMAL && percentile <= 15) {
    return DevTrait.STAR // Top 15% -> Star
  }
  if (currentTrait === DevTrait.STAR && percentile <= 10) {
    return DevTrait.SUPERSTAR // Top 10% -> Superstar
  }
  if (currentTrait === DevTrait.SUPERSTAR && percentile <= 5) {
    return DevTrait.XFACTOR // Top 5% -> X-Factor
  }

  // Downgrade rules (with rookie protection)
  if (yearsPro === 0) {
    return null // Rookies protected from downgrades
  }

  if (currentTrait === DevTrait.XFACTOR && percentile > 10) {
    return DevTrait.SUPERSTAR // Falls below top 10%
  }
  if (currentTrait === DevTrait.SUPERSTAR && percentile > 15) {
    return DevTrait.STAR // Falls below top 15%
  }
  if (currentTrait === DevTrait.STAR && percentile > 25) {
    return DevTrait.NORMAL // Falls below top 25%
  }

  return null // No change
}

/**
 * Get trait name for display
 */
export function getTraitName(trait: DevTrait): string {
  switch (trait) {
    case DevTrait.NORMAL: return "Normal"
    case DevTrait.STAR: return "Star"
    case DevTrait.SUPERSTAR: return "Superstar"
    case DevTrait.XFACTOR: return "X-Factor"
    default: return "Unknown"
  }
}

/**
 * Get trait change direction emoji
 */
export function getTraitChangeEmoji(oldTrait: DevTrait, newTrait: DevTrait): string {
  if (newTrait > oldTrait) return "⬆️"
  if (newTrait < oldTrait) return "⬇️"
  return "➡️"
}
