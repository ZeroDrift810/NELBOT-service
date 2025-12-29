import db from "../db/firebase"
import { ChannelId, DiscordIdType } from "./settings_db"

// Supported command types for auto-posting
export type AutoPostCommandType =
  | 'powerrankings'
  | 'playerrankings'
  | 'leaders'
  | 'standings'
  | 'teamstats'
  | 'schedule'
  | 'predictions'
  | 'gotw'
  | 'pickem_leaderboard'
  | 'playoffs'
  | 'awards'
  | 'farecap'

// Schedule configuration
export type PostSchedule = {
  dayOfWeek: number  // 0-6 (Sunday = 0, Saturday = 6)
  hour: number       // 0-23
  minute: number     // 0-59
  timezone?: string  // Default: 'America/New_York'
}

// Command-specific options
export type AutoPostOptions = {
  // For leaders command
  category?: 'passing' | 'rushing' | 'receiving' | 'defense' | 'kicking' | 'advanced'
  // For powerrankings
  range?: 'top5' | 'top10' | 'full'
  // For playerrankings
  position?: string
  // For teamstats
  teamAbbr?: string
}

// Full scheduled post configuration
export type ScheduledPost = {
  id: string
  guildId: string
  leagueId: string
  channelId: string
  commandType: AutoPostCommandType
  schedule: PostSchedule
  options: AutoPostOptions
  enabled: boolean
  createdBy: string
  createdAt: Date
  lastRun?: Date
  lastError?: string
}

// For creating new posts
export type CreateScheduledPost = Omit<ScheduledPost, 'id' | 'createdAt' | 'lastRun' | 'lastError'>

const COLLECTION = "scheduled_posts"

// Day name mappings
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Convert day name to number
export function parseDayOfWeek(day: string): number {
  const normalized = day.toLowerCase().trim()
  const index = DAY_NAMES.findIndex(d => d.toLowerCase() === normalized)
  if (index >= 0) return index
  const abbrevIndex = DAY_ABBREV.findIndex(d => d.toLowerCase() === normalized)
  if (abbrevIndex >= 0) return abbrevIndex
  const num = parseInt(day)
  if (!isNaN(num) && num >= 0 && num <= 6) return num
  throw new Error(`Invalid day of week: ${day}. Use Sunday-Saturday or 0-6`)
}

// Parse time string like "9:00" or "14:30"
export function parseTime(time: string): { hour: number, minute: number } {
  const match = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    throw new Error(`Invalid time format: ${time}. Use HH:MM format (e.g., 9:00, 14:30)`)
  }
  const hour = parseInt(match[1])
  const minute = parseInt(match[2])
  if (hour < 0 || hour > 23) throw new Error(`Hour must be 0-23, got ${hour}`)
  if (minute < 0 || minute > 59) throw new Error(`Minute must be 0-59, got ${minute}`)
  return { hour, minute }
}

// Format schedule for display
export function formatSchedule(schedule: PostSchedule): string {
  const day = DAY_NAMES[schedule.dayOfWeek]
  const hour = schedule.hour % 12 || 12
  const ampm = schedule.hour < 12 ? 'AM' : 'PM'
  const minute = schedule.minute.toString().padStart(2, '0')
  return `${day} at ${hour}:${minute} ${ampm} ET`
}

// Generate unique ID
function generateId(): string {
  return `ap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

interface AutoPostDB {
  createScheduledPost(post: CreateScheduledPost): Promise<ScheduledPost>
  getScheduledPost(id: string): Promise<ScheduledPost | null>
  getScheduledPostsForGuild(guildId: string): Promise<ScheduledPost[]>
  getAllScheduledPosts(): Promise<ScheduledPost[]>
  updateScheduledPost(id: string, updates: Partial<ScheduledPost>): Promise<void>
  deleteScheduledPost(id: string): Promise<boolean>
  markPostRun(id: string, error?: string): Promise<void>
  getPostsDueNow(): Promise<ScheduledPost[]>
}

const AutoPostDB: AutoPostDB = {
  async createScheduledPost(post: CreateScheduledPost): Promise<ScheduledPost> {
    const id = generateId()
    const fullPost: ScheduledPost = {
      ...post,
      id,
      createdAt: new Date(),
      enabled: true
    }

    await db.collection(COLLECTION).doc(id).set({
      ...fullPost,
      createdAt: fullPost.createdAt.toISOString()
    })

    return fullPost
  },

  async getScheduledPost(id: string): Promise<ScheduledPost | null> {
    const doc = await db.collection(COLLECTION).doc(id).get()
    if (!doc.exists) return null

    const data = doc.data()!
    return {
      ...data,
      id: doc.id,
      createdAt: new Date(data.createdAt),
      lastRun: data.lastRun ? new Date(data.lastRun) : undefined
    } as ScheduledPost
  },

  async getScheduledPostsForGuild(guildId: string): Promise<ScheduledPost[]> {
    const snapshot = await db.collection(COLLECTION)
      .where('guildId', '==', guildId)
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        id: doc.id,
        createdAt: new Date(data.createdAt),
        lastRun: data.lastRun ? new Date(data.lastRun) : undefined
      } as ScheduledPost
    })
  },

  async getAllScheduledPosts(): Promise<ScheduledPost[]> {
    const snapshot = await db.collection(COLLECTION)
      .where('enabled', '==', true)
      .get()

    return snapshot.docs.map(doc => {
      const data = doc.data()
      return {
        ...data,
        id: doc.id,
        createdAt: new Date(data.createdAt),
        lastRun: data.lastRun ? new Date(data.lastRun) : undefined
      } as ScheduledPost
    })
  },

  async updateScheduledPost(id: string, updates: Partial<ScheduledPost>): Promise<void> {
    await db.collection(COLLECTION).doc(id).update(updates)
  },

  async deleteScheduledPost(id: string): Promise<boolean> {
    const doc = await db.collection(COLLECTION).doc(id).get()
    if (!doc.exists) return false
    await doc.ref.delete()
    return true
  },

  async markPostRun(id: string, error?: string): Promise<void> {
    const updates: any = {
      lastRun: new Date().toISOString()
    }
    if (error) {
      updates.lastError = error
    } else {
      updates.lastError = null
    }
    await db.collection(COLLECTION).doc(id).update(updates)
  },

  async getPostsDueNow(): Promise<ScheduledPost[]> {
    // Get current time in ET
    const now = new Date()
    const etOptions: Intl.DateTimeFormatOptions = {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }
    const etParts = new Intl.DateTimeFormat('en-US', etOptions).formatToParts(now)

    const dayMap: { [key: string]: number } = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 }
    const currentDay = dayMap[etParts.find(p => p.type === 'weekday')?.value || 'Mon']
    const currentHour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0')
    const currentMinute = parseInt(etParts.find(p => p.type === 'minute')?.value || '0')

    // Get all enabled posts
    const allPosts = await this.getAllScheduledPosts()

    // Filter to posts that are due now (within the current minute)
    return allPosts.filter(post => {
      if (!post.enabled) return false
      if (post.schedule.dayOfWeek !== currentDay) return false
      if (post.schedule.hour !== currentHour) return false
      if (post.schedule.minute !== currentMinute) return false

      // Check if already run today (within last 5 minutes to avoid double-runs)
      if (post.lastRun) {
        const lastRunTime = new Date(post.lastRun).getTime()
        const fiveMinutesAgo = now.getTime() - (5 * 60 * 1000)
        if (lastRunTime > fiveMinutesAgo) return false
      }

      return true
    })
  }
}

export default AutoPostDB
