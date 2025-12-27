import db from "./firebase"

// Award types available in Madden
export type AwardType =
  | "MVP"
  | "OPOY"
  | "DPOY"
  | "OROY"
  | "DROY"
  | "CPOY"  // Comeback Player of the Year
  | "PRO_BOWL"
  | "ALL_PRO_1ST"
  | "ALL_PRO_2ND"
  | "SUPER_BOWL_MVP"
  | "PASSING_LEADER"
  | "RUSHING_LEADER"
  | "RECEIVING_LEADER"
  | "SACK_LEADER"
  | "INT_LEADER"

export type Award = {
  awardType: AwardType
  seasonYear: number
  rosterId: number
  playerName: string
  position: string
  teamId: number
  teamAbbr: string
  grantedBy: string  // Discord user ID who granted the award
  grantedAt: Date
}

export type PlayerAwardSummary = {
  rosterId: number
  playerName: string
  position: string
  awards: Award[]
}

export type SeasonAwardSummary = {
  seasonYear: number
  awards: Award[]
}

const AWARD_LABELS: Record<AwardType, string> = {
  MVP: "League MVP",
  OPOY: "Offensive Player of the Year",
  DPOY: "Defensive Player of the Year",
  OROY: "Offensive Rookie of the Year",
  DROY: "Defensive Rookie of the Year",
  CPOY: "Comeback Player of the Year",
  PRO_BOWL: "Pro Bowl",
  ALL_PRO_1ST: "All-Pro 1st Team",
  ALL_PRO_2ND: "All-Pro 2nd Team",
  SUPER_BOWL_MVP: "Super Bowl MVP",
  PASSING_LEADER: "Passing Yards Leader",
  RUSHING_LEADER: "Rushing Yards Leader",
  RECEIVING_LEADER: "Receiving Yards Leader",
  SACK_LEADER: "Sack Leader",
  INT_LEADER: "Interception Leader"
}

const AWARD_EMOJIS: Record<AwardType, string> = {
  MVP: "🏆",
  OPOY: "⚡",
  DPOY: "🛡️",
  OROY: "🌟",
  DROY: "🔰",
  CPOY: "💪",
  PRO_BOWL: "⭐",
  ALL_PRO_1ST: "🥇",
  ALL_PRO_2ND: "🥈",
  SUPER_BOWL_MVP: "🏈",
  PASSING_LEADER: "🎯",
  RUSHING_LEADER: "🏃🏿",
  RECEIVING_LEADER: "🙌🏿",
  SACK_LEADER: "💥",
  INT_LEADER: "🤲🏿"
}

export function getAwardLabel(awardType: AwardType): string {
  return AWARD_LABELS[awardType] || awardType
}

export function getAwardEmoji(awardType: AwardType): string {
  return AWARD_EMOJIS[awardType] || "🏅"
}

export function getAllAwardTypes(): AwardType[] {
  return Object.keys(AWARD_LABELS) as AwardType[]
}

interface AwardsDB {
  grantAward(leagueId: string, award: Omit<Award, "grantedAt">): Promise<void>
  removeAward(leagueId: string, rosterId: number, awardType: AwardType, seasonYear: number): Promise<boolean>
  getPlayerAwards(leagueId: string, rosterId: number): Promise<Award[]>
  getSeasonAwards(leagueId: string, seasonYear: number): Promise<Award[]>
  getAllAwards(leagueId: string): Promise<Award[]>
  getAwardHistory(leagueId: string, awardType: AwardType): Promise<Award[]>
}

function createAwardId(award: Omit<Award, "grantedAt">): string {
  return `${award.seasonYear}_${award.awardType}_${award.rosterId}`
}

const AwardsDB: AwardsDB = {
  async grantAward(leagueId: string, award: Omit<Award, "grantedAt">) {
    const awardId = createAwardId(award)
    const fullAward: Award = {
      ...award,
      grantedAt: new Date()
    }

    await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .doc(awardId)
      .set(fullAward)
  },

  async removeAward(leagueId: string, rosterId: number, awardType: AwardType, seasonYear: number): Promise<boolean> {
    const awardId = `${seasonYear}_${awardType}_${rosterId}`
    const doc = await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .doc(awardId)
      .get()

    if (doc.exists) {
      await doc.ref.delete()
      return true
    }
    return false
  },

  async getPlayerAwards(leagueId: string, rosterId: number): Promise<Award[]> {
    const snapshot = await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .where("rosterId", "==", rosterId)
      .orderBy("seasonYear", "desc")
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        grantedAt: data.grantedAt?.toDate?.() || new Date(data.grantedAt)
      } as Award
    })
  },

  async getSeasonAwards(leagueId: string, seasonYear: number): Promise<Award[]> {
    const snapshot = await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .where("seasonYear", "==", seasonYear)
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        grantedAt: data.grantedAt?.toDate?.() || new Date(data.grantedAt)
      } as Award
    })
  },

  async getAllAwards(leagueId: string): Promise<Award[]> {
    const snapshot = await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .orderBy("seasonYear", "desc")
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        grantedAt: data.grantedAt?.toDate?.() || new Date(data.grantedAt)
      } as Award
    })
  },

  async getAwardHistory(leagueId: string, awardType: AwardType): Promise<Award[]> {
    const snapshot = await db.collection("madden_data26")
      .doc(leagueId)
      .collection("awards")
      .where("awardType", "==", awardType)
      .orderBy("seasonYear", "desc")
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        grantedAt: data.grantedAt?.toDate?.() || new Date(data.grantedAt)
      } as Award
    })
  }
}

export default AwardsDB
