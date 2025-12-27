import { createCanvas, loadImage, CanvasRenderingContext2D } from 'canvas'
import { MaddenGame, GameResult, Team } from '../../export/madden_league_types'
import { GameStats, PlayerStatType } from '../../db/madden_db'
import { LeagueLogos } from '../../db/view'
import path from 'path'
import fs from 'fs'

const CANVAS_WIDTH = 1400
const CANVAS_HEIGHT = 1200

interface TeamColors {
  primary: string
  secondary: string
}

// NFL team colors
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

function getTeamLogoPath(teamAbbr: string): string | null {
  const logoPath = path.join(process.cwd(), 'emojis', `snallabot_${teamAbbr.toLowerCase()}.png`)
  if (fs.existsSync(logoPath)) {
    return logoPath
  }
  return null
}

function getBackgroundPath(): string | null {
  const bgPath = path.join(process.cwd(), 'backgrounds', 'game_recap_bg.png')
  if (fs.existsSync(bgPath)) {
    return bgPath
  }
  return null
}

function getTeamColors(teamAbbr: string): TeamColors {
  return TEAM_COLORS[teamAbbr] || { primary: '#1a1a1a', secondary: '#666666' }
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
  ctx.fill()
}

export async function createGameRecapImage(
  game: MaddenGame,
  awayTeam: Team,
  homeTeam: Team,
  stats: GameStats,
  logos?: LeagueLogos
): Promise<Buffer> {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT)
  const ctx = canvas.getContext('2d')

  const winner = game.status === GameResult.AWAY_WIN ? awayTeam :
                 game.status === GameResult.HOME_WIN ? homeTeam : null
  const winnerColors = winner ? getTeamColors(winner.abbrName) : null

  // Try to load custom background, otherwise use gradient
  const bgPath = getBackgroundPath()
  if (bgPath) {
    try {
      const bg = await loadImage(bgPath)
      ctx.drawImage(bg, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    } catch (e) {
      console.warn('Could not load background, using gradient')
      createDefaultBackground(ctx, winnerColors)
    }
  } else {
    createDefaultBackground(ctx, winnerColors)
  }

  // ========== LEFT SIDEBAR - Team Info ==========
  const sidebarWidth = 380
  const mainAreaX = sidebarWidth + 40

  // Vertical divider line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(sidebarWidth, 0)
  ctx.lineTo(sidebarWidth, CANVAS_HEIGHT)
  ctx.stroke()

  // League branding
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 48px Arial'
  ctx.textAlign = 'center'
  ctx.fillText('NEL', sidebarWidth / 2, 60)
  ctx.fillStyle = '#ffffff'
  ctx.font = '22px Arial'
  ctx.fillText('No Excuses League', sidebarWidth / 2, 95)

  // Week/Season
  ctx.font = 'bold 28px Arial'
  ctx.fillText(`WEEK ${game.weekIndex + 1}`, sidebarWidth / 2, 140)
  ctx.font = '20px Arial'
  ctx.fillStyle = '#aaaaaa'
  ctx.fillText(`Season ${game.seasonIndex + 1}`, sidebarWidth / 2, 170)

  let sidebarY = 220

  // AWAY TEAM
  try {
    const awayLogoPath = getTeamLogoPath(awayTeam.abbrName)
    if (awayLogoPath) {
      const awayLogo = await loadImage(awayLogoPath)
      const logoSize = winner === awayTeam ? 140 : 120
      ctx.globalAlpha = winner === awayTeam ? 1.0 : 0.7
      ctx.drawImage(awayLogo, (sidebarWidth - logoSize) / 2, sidebarY, logoSize, logoSize)
      sidebarY += logoSize + 35
    }
  } catch (e) {
    console.warn('Failed to load away logo')
    sidebarY += 140
  }

  ctx.globalAlpha = 1.0
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 28px Arial'
  ctx.textAlign = 'center'
  ctx.fillText(awayTeam.displayName.toUpperCase(), sidebarWidth / 2, sidebarY)
  sidebarY += 55

  // Away score
  ctx.font = 'bold 72px Arial'
  if (winner === awayTeam) {
    ctx.fillStyle = '#FFD700'
  } else {
    ctx.fillStyle = '#ffffff'
  }
  ctx.fillText(`${game.awayScore}`, sidebarWidth / 2, sidebarY)
  sidebarY += 90

  // VS divider
  ctx.fillStyle = '#aaaaaa'
  ctx.font = 'bold 24px Arial'
  ctx.fillText('VS', sidebarWidth / 2, sidebarY)
  sidebarY += 55

  // HOME TEAM
  try {
    const homeLogoPath = getTeamLogoPath(homeTeam.abbrName)
    if (homeLogoPath) {
      const homeLogo = await loadImage(homeLogoPath)
      const logoSize = winner === homeTeam ? 140 : 120
      ctx.globalAlpha = winner === homeTeam ? 1.0 : 0.7
      ctx.drawImage(homeLogo, (sidebarWidth - logoSize) / 2, sidebarY, logoSize, logoSize)
      sidebarY += logoSize + 35
    }
  } catch (e) {
    console.warn('Failed to load home logo')
    sidebarY += 140
  }

  ctx.globalAlpha = 1.0
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 28px Arial'
  ctx.fillText(homeTeam.displayName.toUpperCase(), sidebarWidth / 2, sidebarY)
  sidebarY += 55

  // Home score
  ctx.font = 'bold 72px Arial'
  if (winner === homeTeam) {
    ctx.fillStyle = '#FFD700'
  } else {
    ctx.fillStyle = '#ffffff'
  }
  ctx.fillText(`${game.homeScore}`, sidebarWidth / 2, sidebarY)

  // ========== MAIN AREA - Team Stats ==========
  let mainY = 50

  // Stats header
  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 40px Arial'
  ctx.textAlign = 'center'
  const mainCenterX = mainAreaX + (CANVAS_WIDTH - mainAreaX) / 2
  ctx.fillText('TEAM STATS', mainCenterX, mainY)
  mainY += 60

  // Get team stats
  const awayStats = stats.teamStats.find(ts => ts.teamId === game.awayTeamId)
  const homeStats = stats.teamStats.find(ts => ts.teamId === game.homeTeamId)

  if (awayStats && homeStats) {
    const statLeftX = mainAreaX + 60
    const statCenterX = mainCenterX
    const statRightX = CANVAS_WIDTH - 60

    ctx.font = 'bold 26px Arial'
    ctx.fillStyle = '#ffffff'

    // Column headers
    ctx.textAlign = 'left'
    ctx.fillText(awayTeam.abbrName, statLeftX, mainY)
    ctx.textAlign = 'center'
    ctx.fillText('STAT', statCenterX, mainY)
    ctx.textAlign = 'right'
    ctx.fillText(homeTeam.abbrName, statRightX, mainY)

    mainY += 50

    // Total Yards
    ctx.font = 'bold 30px Arial'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${awayStats.offTotalYds}`, statLeftX, mainY)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 26px Arial'
    ctx.fillText('Total Yards', statCenterX, mainY)
    ctx.font = 'bold 30px Arial'
    ctx.textAlign = 'right'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${homeStats.offTotalYds}`, statRightX, mainY)

    mainY += 48

    // Pass Yards
    ctx.textAlign = 'left'
    ctx.fillText(`${awayStats.offPassYds}`, statLeftX, mainY)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 26px Arial'
    ctx.fillText('Pass Yards', statCenterX, mainY)
    ctx.font = 'bold 30px Arial'
    ctx.textAlign = 'right'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${homeStats.offPassYds}`, statRightX, mainY)

    mainY += 48

    // Rush Yards
    ctx.textAlign = 'left'
    ctx.fillText(`${awayStats.offRushYds}`, statLeftX, mainY)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 26px Arial'
    ctx.fillText('Rush Yards', statCenterX, mainY)
    ctx.font = 'bold 30px Arial'
    ctx.textAlign = 'right'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${homeStats.offRushYds}`, statRightX, mainY)

    mainY += 48

    // Turnovers
    ctx.textAlign = 'left'
    ctx.fillText(`${awayStats.tOGiveaways}`, statLeftX, mainY)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 26px Arial'
    ctx.fillText('Turnovers', statCenterX, mainY)
    ctx.font = 'bold 30px Arial'
    ctx.textAlign = 'right'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${homeStats.tOGiveaways}`, statRightX, mainY)

    mainY += 60
  }

  // ========== TOP PERFORMERS SECTION ==========
  // Horizontal divider
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(mainAreaX, mainY)
  ctx.lineTo(CANVAS_WIDTH - 40, mainY)
  ctx.stroke()

  mainY += 50

  ctx.fillStyle = '#FFD700'
  ctx.font = 'bold 40px Arial'
  ctx.textAlign = 'center'
  ctx.fillText('TOP PERFORMERS', mainCenterX, mainY)

  mainY += 60

  // Get top performers from each team
  const passingStats = stats.playerStats[PlayerStatType.PASSING] || []
  const rushingStats = stats.playerStats[PlayerStatType.RUSHING] || []
  const receivingStats = stats.playerStats[PlayerStatType.RECEIVING] || []
  const defensiveStats = stats.playerStats[PlayerStatType.DEFENSE] || []

  // Away team top performers
  const awayPassers = passingStats.filter(p => p.teamId === game.awayTeamId).sort((a, b) => b.passYds - a.passYds)
  const awayRushers = rushingStats.filter(p => p.teamId === game.awayTeamId).sort((a, b) => b.rushYds - a.rushYds)
  const awayReceivers = receivingStats.filter(p => p.teamId === game.awayTeamId).sort((a, b) => b.recYds - a.recYds)
  const awaySackers = defensiveStats.filter(p => p.teamId === game.awayTeamId && p.defSacks > 0).sort((a, b) => b.defSacks - a.defSacks)
  const awayInterceptors = defensiveStats.filter(p => p.teamId === game.awayTeamId && p.defInts > 0).sort((a, b) => b.defInts - a.defInts)

  // Home team top performers
  const homePassers = passingStats.filter(p => p.teamId === game.homeTeamId).sort((a, b) => b.passYds - a.passYds)
  const homeRushers = rushingStats.filter(p => p.teamId === game.homeTeamId).sort((a, b) => b.rushYds - a.rushYds)
  const homeReceivers = receivingStats.filter(p => p.teamId === game.homeTeamId).sort((a, b) => b.recYds - a.recYds)
  const homeSackers = defensiveStats.filter(p => p.teamId === game.homeTeamId && p.defSacks > 0).sort((a, b) => b.defSacks - a.defSacks)
  const homeInterceptors = defensiveStats.filter(p => p.teamId === game.homeTeamId && p.defInts > 0).sort((a, b) => b.defInts - a.defInts)

  const perfLeftX = mainAreaX + 40
  const perfStatsX = CANVAS_WIDTH - 80

  // PASSING - show best from each team
  if (awayPassers.length > 0 || homePassers.length > 0) {
    ctx.textAlign = 'left'
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('🏈 PASSING', perfLeftX, mainY)
    mainY += 40

    if (awayPassers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${awayPassers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${awayTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${awayPassers[0].passComp}/${awayPassers[0].passAtt}, ${awayPassers[0].passYds} YDS, ${awayPassers[0].passTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }

    if (homePassers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${homePassers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${homeTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${homePassers[0].passComp}/${homePassers[0].passAtt}, ${homePassers[0].passYds} YDS, ${homePassers[0].passTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }
    mainY += 20
  }

  // RUSHING - show best from each team
  if (awayRushers.length > 0 || homeRushers.length > 0) {
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('🏃 RUSHING', perfLeftX, mainY)
    mainY += 40

    if (awayRushers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${awayRushers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${awayTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${awayRushers[0].rushAtt} ATT, ${awayRushers[0].rushYds} YDS, ${awayRushers[0].rushTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }

    if (homeRushers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${homeRushers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${homeTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${homeRushers[0].rushAtt} ATT, ${homeRushers[0].rushYds} YDS, ${homeRushers[0].rushTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }
    mainY += 20
  }

  // RECEIVING - show best from each team
  if (awayReceivers.length > 0 || homeReceivers.length > 0) {
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('🙌 RECEIVING', perfLeftX, mainY)
    mainY += 40

    if (awayReceivers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${awayReceivers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${awayTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${awayReceivers[0].recCatches} REC, ${awayReceivers[0].recYds} YDS, ${awayReceivers[0].recTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }

    if (homeReceivers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${homeReceivers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${homeTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${homeReceivers[0].recCatches} REC, ${homeReceivers[0].recYds} YDS, ${homeReceivers[0].recTDs} TD`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }
    mainY += 20
  }

  // SACKS - show best from each team (if any)
  if (awaySackers.length > 0 || homeSackers.length > 0) {
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('💥 SACKS', perfLeftX, mainY)
    mainY += 40

    if (awaySackers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${awaySackers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${awayTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${awaySackers[0].defSacks} SK`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }

    if (homeSackers[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${homeSackers[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${homeTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${homeSackers[0].defSacks} SK`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }
    mainY += 20
  }

  // INTERCEPTIONS - show best from each team (if any)
  if (awayInterceptors.length > 0 || homeInterceptors.length > 0) {
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('🏴 INTERCEPTIONS', perfLeftX, mainY)
    mainY += 40

    if (awayInterceptors[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${awayInterceptors[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${awayTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${awayInterceptors[0].defInts} INT`, perfStatsX, mainY)
      ctx.textAlign = 'left'
      mainY += 38
    }

    if (homeInterceptors[0]) {
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 22px Arial'
      ctx.fillText(`${homeInterceptors[0].fullName}`, perfLeftX + 20, mainY)
      ctx.font = '19px Arial'
      ctx.fillStyle = '#aaaaaa'
      ctx.fillText(`(${homeTeam.abbrName})`, perfLeftX + 240, mainY)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#ffffff'
      ctx.font = '20px Arial'
      ctx.fillText(`${homeInterceptors[0].defInts} INT`, perfStatsX, mainY)
      ctx.textAlign = 'left'
    }
  }

  return canvas.toBuffer('image/png')
}

function createDefaultBackground(ctx: CanvasRenderingContext2D, winnerColors: TeamColors | null) {
  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
  if (winnerColors) {
    gradient.addColorStop(0, winnerColors.primary)
    gradient.addColorStop(1, winnerColors.secondary)
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
