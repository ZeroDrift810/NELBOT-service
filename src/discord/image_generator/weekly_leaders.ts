import { createCanvas, loadImage, CanvasRenderingContext2D } from 'canvas'
import { PlayerStats, PlayerStatType, TeamList } from '../../db/madden_db'
import { PassingStats, ReceivingStats, RushingStats, DefensiveStats, Team } from '../../export/madden_league_types'
import path from 'path'
import fs from 'fs'

const CANVAS_WIDTH = 1400
const CANVAS_HEIGHT = 1000

interface TeamColors {
  primary: string
  secondary: string
}

// NFL team colors (same as game_recap)
const TEAM_COLORS: { [abbr: string]: TeamColors } = {
  'ARI': { primary: '#97233F', secondary: '#000000' },
  'ATL': { primary: '#A71930', secondary: '#000000' },
  'BAL': { primary: '#241773', secondary: '#000000' },
  'BUF': { primary: '#00338D', secondary: '#C60C30' },
  'CAR': { primary: '#0085CA', secondary: '#101820' },
  'CHI': { primary: '#0B162A', secondary: '#C83803' },
  'CIN': { primary: '#FB4F14', secondary: '#000000' },
  'CLE': { primary: '#311D00', secondary: '#FF3C00' },
  'DAL': { primary: '#041E42', secondary: '#869397' },
  'DEN': { primary: '#FB4F14', secondary: '#002244' },
  'DET': { primary: '#0076B6', secondary: '#B0B7BC' },
  'GB': { primary: '#203731', secondary: '#FFB612' },
  'HOU': { primary: '#03202F', secondary: '#A71930' },
  'IND': { primary: '#002C5F', secondary: '#A2AAAD' },
  'JAX': { primary: '#006778', secondary: '#D7A22A' },
  'KC': { primary: '#E31837', secondary: '#FFB81C' },
  'LAC': { primary: '#0080C6', secondary: '#FFC20E' },
  'LAR': { primary: '#003594', secondary: '#FFA300' },
  'LV': { primary: '#000000', secondary: '#A5ACAF' },
  'MIA': { primary: '#008E97', secondary: '#FC4C02' },
  'MIN': { primary: '#4F2683', secondary: '#FFC62F' },
  'NE': { primary: '#002244', secondary: '#C60C30' },
  'NO': { primary: '#D3BC8D', secondary: '#101820' },
  'NYG': { primary: '#0B2265', secondary: '#A71930' },
  'NYJ': { primary: '#125740', secondary: '#000000' },
  'PHI': { primary: '#004C54', secondary: '#A5ACAF' },
  'PIT': { primary: '#FFB612', secondary: '#101820' },
  'SEA': { primary: '#002244', secondary: '#69BE28' },
  'SF': { primary: '#AA0000', secondary: '#B3995D' },
  'TB': { primary: '#D50A0A', secondary: '#34302B' },
  'TEN': { primary: '#0C2340', secondary: '#4B92DB' },
  'WAS': { primary: '#5A1414', secondary: '#FFB612' },
}

function getBackgroundPath(): string | null {
  const bgPath = path.join(process.cwd(), 'backgrounds', 'weekly_leaders_bg.png')
  if (fs.existsSync(bgPath)) {
    return bgPath
  }
  return null
}

function getTeamColors(teamAbbr: string): TeamColors {
  return TEAM_COLORS[teamAbbr] || { primary: '#1a1a1a', secondary: '#666666' }
}

function createDefaultBackground(ctx: CanvasRenderingContext2D, topPerformerColors: TeamColors | null) {
  // Background gradient based on top performer's team colors
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
  if (topPerformerColors) {
    gradient.addColorStop(0, topPerformerColors.primary)
    gradient.addColorStop(1, topPerformerColors.secondary)
  } else {
    gradient.addColorStop(0, '#1a1a1a')
    gradient.addColorStop(1, '#2d2d2d')
  }
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

  // Add overlay for better text readability
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
}

export async function createWeeklyLeadersImage(
  stats: PlayerStats,
  teams: TeamList,
  week: number,
  season: number
): Promise<Buffer> {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT)
  const ctx = canvas.getContext('2d')

  // Get top performers
  const passingStats = stats[PlayerStatType.PASSING] || []
  const rushingStats = stats[PlayerStatType.RUSHING] || []
  const receivingStats = stats[PlayerStatType.RECEIVING] || []
  const defensiveStats = stats[PlayerStatType.DEFENSE] || []

  // Sort and get top performers
  const topPassers = [...passingStats].sort((a, b) => b.passYds - a.passYds).slice(0, 5)
  const topRushers = [...rushingStats].sort((a, b) => b.rushYds - a.rushYds).slice(0, 5)
  const topReceivers = [...receivingStats].sort((a, b) => b.recYds - a.recYds).slice(0, 5)
  const topDefenders = [...defensiveStats].sort((a, b) => b.defTotalTackles - a.defTotalTackles).slice(0, 5)

  // Get top performer's team colors for background
  const topPerformer = topPassers[0]
  const topPerformerTeam = topPerformer ? teams.getTeamForId(topPerformer.teamId) : null
  const topPerformerColors = topPerformerTeam ? getTeamColors(topPerformerTeam.abbrName) : null

  // Try to load custom background, otherwise use gradient
  const bgPath = getBackgroundPath()
  if (bgPath) {
    try {
      const bg = await loadImage(bgPath)
      ctx.drawImage(bg, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    } catch (e) {
      console.warn('Could not load background, using gradient')
      createDefaultBackground(ctx, topPerformerColors)
    }
  } else {
    createDefaultBackground(ctx, topPerformerColors)
  }

  // League branding - "NEL" in top left
  ctx.fillStyle = '#FFD700' // Gold
  ctx.font = 'bold 56px Arial'
  ctx.textAlign = 'left'
  ctx.fillText('NEL', 50, 70)

  ctx.fillStyle = '#ffffff'
  ctx.font = '28px Arial'
  ctx.fillText('No Excuses League', 50, 110)

  // Week/Season info - top right
  ctx.textAlign = 'right'
  ctx.font = 'bold 32px Arial'
  ctx.fillText(`WEEK ${week}`, CANVAS_WIDTH - 50, 70)
  ctx.font = '24px Arial'
  ctx.fillText(`Season ${season}`, CANVAS_WIDTH - 50, 105)

  // Title - center
  ctx.textAlign = 'center'
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 42px Arial'
  ctx.fillText('WEEKLY LEADERS', CANVAS_WIDTH / 2, 165)

  // TWO-COLUMN LAYOUT: OFFENSIVE LEADERS | DEFENSIVE LEADERS
  const leftX = 80
  const rightX = 720
  const startY = 220

  // Vertical divider line between columns
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(CANVAS_WIDTH / 2, startY)
  ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT - 50)
  ctx.stroke()

  // LEFT COLUMN - OFFENSIVE LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 36px Arial'
  ctx.textAlign = 'center'
  ctx.fillText('OFFENSIVE LEADERS', leftX + 270, startY + 35)

  let yPos = startY + 80

  // PASSING LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.textAlign = 'left'
  ctx.fillText('🏈 PASSING', leftX, yPos)
  yPos += 40

  topPassers.slice(0, 3).forEach((player, i) => {
    const team = teams.getTeamForId(player.teamId)
    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
    ctx.fillText(`${player.fullName}`, leftX + 20, yPos)

    ctx.font = '18px Arial'
    ctx.fillStyle = '#aaaaaa'
    ctx.fillText(`(${team.abbrName})`, leftX + 240, yPos)

    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
    ctx.textAlign = 'right'
    ctx.fillText(`${player.passYds} YDS, ${player.passTDs} TD`, leftX + 540, yPos)
    ctx.textAlign = 'left'
    yPos += 38
  })

  yPos += 25

  // RUSHING LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.fillText('🏃 RUSHING', leftX, yPos)
  yPos += 40

  topRushers.slice(0, 3).forEach((player, i) => {
    const team = teams.getTeamForId(player.teamId)
    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
    ctx.fillText(`${player.fullName}`, leftX + 20, yPos)

    ctx.font = '18px Arial'
    ctx.fillStyle = '#aaaaaa'
    ctx.fillText(`(${team.abbrName})`, leftX + 240, yPos)

    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
    ctx.textAlign = 'right'
    ctx.fillText(`${player.rushYds} YDS, ${player.rushTDs} TD`, leftX + 540, yPos)
    ctx.textAlign = 'left'
    yPos += 38
  })

  yPos += 25

  // RECEIVING LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.fillText('🙌 RECEIVING', leftX, yPos)
  yPos += 40

  topReceivers.slice(0, 3).forEach((player, i) => {
    const team = teams.getTeamForId(player.teamId)
    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
    ctx.fillText(`${player.fullName}`, leftX + 20, yPos)

    ctx.font = '18px Arial'
    ctx.fillStyle = '#aaaaaa'
    ctx.fillText(`(${team.abbrName})`, leftX + 240, yPos)

    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
    ctx.textAlign = 'right'
    ctx.fillText(`${player.recYds} YDS, ${player.recTDs} TD`, leftX + 540, yPos)
    ctx.textAlign = 'left'
    yPos += 38
  })

  // RIGHT COLUMN - DEFENSIVE LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 36px Arial'
  ctx.textAlign = 'center'
  ctx.fillText('DEFENSIVE LEADERS', rightX + 270, startY + 35)

  yPos = startY + 80

  // TACKLES LEADERS
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.textAlign = 'left'
  ctx.fillText('🛡️ TACKLES', rightX, yPos)
  yPos += 40

  topDefenders.slice(0, 5).forEach((player, i) => {
    const team = teams.getTeamForId(player.teamId)
    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
    ctx.fillText(`${player.fullName}`, rightX + 20, yPos)

    ctx.font = '18px Arial'
    ctx.fillStyle = '#aaaaaa'
    ctx.fillText(`(${team.abbrName})`, rightX + 240, yPos)

    ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
    ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
    ctx.textAlign = 'right'
    ctx.fillText(`${player.defTotalTackles} TKL`, rightX + 540, yPos)
    ctx.textAlign = 'left'
    yPos += 38
  })

  yPos += 25

  // SACKS LEADERS
  const topSackers = [...defensiveStats].sort((a, b) => b.defSacks - a.defSacks).slice(0, 5).filter(p => p.defSacks > 0)

  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.fillText('💥 SACKS', rightX, yPos)
  yPos += 40

  if (topSackers.length > 0) {
    topSackers.slice(0, 5).forEach((player, i) => {
      const team = teams.getTeamForId(player.teamId)
      ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
      ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
      ctx.fillText(`${player.fullName}`, rightX + 20, yPos)

      ctx.font = '18px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${team.abbrName})`, rightX + 240, yPos)

      ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
      ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
      ctx.textAlign = 'right'
      ctx.fillText(`${player.defSacks} SK`, rightX + 540, yPos)
      ctx.textAlign = 'left'
      yPos += 38
    })
  } else {
    ctx.fillStyle = '#666666'
    ctx.font = 'italic 20px Arial'
    ctx.textAlign = 'center'
    ctx.fillText('No sacks recorded', rightX + 270, yPos)
    ctx.textAlign = 'left'
    yPos += 38
  }

  yPos += 25

  // INTERCEPTIONS LEADERS
  const topInts = [...defensiveStats].sort((a, b) => b.defInts - a.defInts).slice(0, 5).filter(p => p.defInts > 0)

  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 28px Arial'
  ctx.fillText('🏴 INTERCEPTIONS', rightX, yPos)
  yPos += 40

  if (topInts.length > 0) {
    topInts.slice(0, 5).forEach((player, i) => {
      const team = teams.getTeamForId(player.teamId)
      ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
      ctx.font = i === 0 ? 'bold 22px Arial' : '20px Arial'
      ctx.fillText(`${player.fullName}`, rightX + 20, yPos)

      ctx.font = '18px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${team.abbrName})`, rightX + 240, yPos)

      ctx.fillStyle = i === 0 ? '#FFD700' : '#ffffff'
      ctx.font = i === 0 ? 'bold 20px Arial' : '18px Arial'
      ctx.textAlign = 'right'
      ctx.fillText(`${player.defInts} INT`, rightX + 540, yPos)
      ctx.textAlign = 'left'
      yPos += 38
    })
  } else {
    ctx.fillStyle = '#666666'
    ctx.font = 'italic 20px Arial'
    ctx.textAlign = 'center'
    ctx.fillText('No interceptions recorded', rightX + 270, yPos)
  }

  return canvas.toBuffer('image/png')
}
