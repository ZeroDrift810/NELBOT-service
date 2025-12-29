/**
 * Anthropic AI Client for generating power rankings and game recaps
 */

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.warn("⚠️ ANTHROPIC_API_KEY not found in environment variables. AI features will not work.");
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
}) : null;

export type TeamPowerRankingData = {
  rank: number
  teamName: string
  teamAbbr: string
  record: string
  wins: number
  losses: number
  ties: number
  previousRank: number
  offensiveRank: number
  defensiveRank: number
  pointsScored: number
  pointsAllowed: number
  pointDifferential: number
  totalYards: number
  defensiveYards: number
  upcomingOpponents: string[]
}

export type GameRecapData = {
  weekIndex: number
  seasonIndex: number
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  winnerName: string
  loserName: string
  homeStats: {
    passYards: number
    rushYards: number
    totalYards: number
    turnovers: number
    penalties: number
    penaltyYards: number
    thirdDownConv: number
    thirdDownAtt: number
    sacks: number
    interceptions: number
    fumbles: number
    redZoneAtt: number
    redZoneTD: number
    fourthDownConv: number
    fourthDownAtt: number
  }
  awayStats: {
    passYards: number
    rushYards: number
    totalYards: number
    turnovers: number
    penalties: number
    penaltyYards: number
    thirdDownConv: number
    thirdDownAtt: number
    sacks: number
    interceptions: number
    fumbles: number
    redZoneAtt: number
    redZoneTD: number
    fourthDownConv: number
    fourthDownAtt: number
  }
  topPerformers: {
    name: string
    team: string
    stat: string
    category: 'passing' | 'rushing' | 'receiving' | 'defense'
  }[]
  explosivePlays: {
    player: string
    team: string
    description: string
  }[]
  keyDefensivePlays: {
    player: string
    team: string
    stat: string
  }[]
}

/**
 * Generate AI power ranking narrative for a team
 */
export async function generatePowerRankingNarrative(data: TeamPowerRankingData): Promise<string> {
  if (!anthropic) {
    throw new Error("Anthropic API key not configured. Add ANTHROPIC_API_KEY to your .env file.");
  }

  const prompt = `You're analyzing a Madden video game franchise. Write a punchy, analyst-style take on this team using ONLY the stats provided. NO real NFL history, NO player names not in the data.

Team: ${data.teamName}
Record: ${data.record}
Points Scored: ${data.pointsScored}
Points Allowed: ${data.pointsAllowed}
Offensive Rank: #${data.offensiveRank}
Defensive Rank: #${data.defensiveRank}
Point Differential: ${data.pointDifferential > 0 ? '+' : ''}${data.pointDifferential}

Write 1-2 SHORT sentences with personality. Be direct, engaging, and stat-focused. Keep it under 90 words.

Examples:
- "That 16-1 record isn't luck - #2 offense, #3 defense, dominating on both sides."
- "Winning 12 games with the 24th ranked defense? The offense is carrying this squad."
- "Balanced excellence with top-5 rankings on both sides of the ball."

Write your take:`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 90,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text.trim();
    }

    throw new Error("Unexpected response format from Anthropic API");
  } catch (error) {
    console.error("Error generating power ranking narrative:", error);
    throw new Error(`Failed to generate narrative: ${error}`);
  }
}

/**
 * Generate AI game recap with analyst personality
 */
export async function generateGameRecap(
  data: GameRecapData,
  analyst: 'Tom Brady' | 'Greg Olsen' | 'Stephen A. Smith' | 'Tony Romo' | 'Al Michaels'
): Promise<string> {
  if (!anthropic) {
    throw new Error("Anthropic API key not configured. Add ANTHROPIC_API_KEY to your .env file.");
  }

  const scoreDiff = Math.abs(data.homeScore - data.awayScore);
  const gameType = scoreDiff <= 3 ? "Close" : scoreDiff <= 7 ? "Competitive" : scoreDiff <= 14 ? "Strong" : "Dominant";
  const winner = data.homeScore > data.awayScore ? data.homeTeam : data.awayTeam;
  const winnerStats = data.homeScore > data.awayScore ? data.homeStats : data.awayStats;
  const loserStats = data.homeScore > data.awayScore ? data.awayStats : data.homeStats;

  const analystPersona = {
    'Tom Brady': 'You are Tom Brady providing game analysis. Focus on QB play, execution, and what it takes to win. Be analytical and reference fundamentals.',
    'Greg Olsen': 'You are Greg Olsen providing game analysis. Focus on matchups, key plays, and player performances. Be insightful and detailed.',
    'Stephen A. Smith': 'You are Stephen A. Smith providing game analysis. Be passionate and emphatic. Call out big performances and mistakes. Use phrases like "Let me tell you something".',
    'Tony Romo': 'You are Tony Romo providing game analysis. Predict what teams should have done, break down strategy. Be enthusiastic about smart plays.',
    'Al Michaels': 'You are Al Michaels providing game analysis. Be legendary and poetic. Paint the picture of the game with narrative flair.'
  };

  // Format red zone efficiency
  const winnerRZ = winnerStats.redZoneAtt > 0 ? `${winnerStats.redZoneTD}/${winnerStats.redZoneAtt}` : 'N/A'
  const loserRZ = loserStats.redZoneAtt > 0 ? `${loserStats.redZoneTD}/${loserStats.redZoneAtt}` : 'N/A'

  // Format explosive plays
  const explosivePlaysText = data.explosivePlays.length > 0
    ? `\nExplosive Plays:\n${data.explosivePlays.map(p => `- ${p.player} (${p.team}): ${p.description}`).join('\n')}`
    : ''

  // Format key defensive plays
  const defensiveText = data.keyDefensivePlays.length > 0
    ? `\nKey Defensive Plays:\n${data.keyDefensivePlays.map(p => `- ${p.player} (${p.team}): ${p.stat}`).join('\n')}`
    : ''

  const prompt = `You are analyzing a FICTIONAL video game. Write a game recap using ONLY the stats below. DO NOT mention real NFL history, real trades, or any context beyond this specific game's data.

Game: ${data.awayTeam} ${data.awayScore} at ${data.homeTeam} ${data.homeScore}
Week ${data.weekIndex + 1}, Season ${2024 + data.seasonIndex}

Winner (${winner}):
Pass: ${winnerStats.passYards} yards | Rush: ${winnerStats.rushYards} yards | Total: ${winnerStats.totalYards} yards
Turnovers: ${winnerStats.turnovers} (${winnerStats.interceptions} INT, ${winnerStats.fumbles} FUM) | Sacks Allowed: ${winnerStats.sacks}
3rd Down: ${winnerStats.thirdDownConv}/${winnerStats.thirdDownAtt} | 4th Down: ${winnerStats.fourthDownConv}/${winnerStats.fourthDownAtt}
Red Zone: ${winnerRZ} | Penalties: ${winnerStats.penalties} (${winnerStats.penaltyYards} yds)

Loser:
Pass: ${loserStats.passYards} yards | Rush: ${loserStats.rushYards} yards | Total: ${loserStats.totalYards} yards
Turnovers: ${loserStats.turnovers} (${loserStats.interceptions} INT, ${loserStats.fumbles} FUM) | Sacks Allowed: ${loserStats.sacks}
3rd Down: ${loserStats.thirdDownConv}/${loserStats.thirdDownAtt} | 4th Down: ${loserStats.fourthDownConv}/${loserStats.fourthDownAtt}
Red Zone: ${loserRZ} | Penalties: ${loserStats.penalties} (${loserStats.penaltyYards} yds)

Top Performers:
${data.topPerformers.map(p => `${p.name} (${p.team}): ${p.stat}`).join('\n')}
${explosivePlaysText}
${defensiveText}

Write 2-3 paragraphs in ${analyst}'s style. Focus ONLY on the stats above. Mention top performers by name from the list. Highlight any explosive plays or key defensive moments. Do not reference any player not listed above. Do not reference real NFL history.

Write the recap:`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text.trim();
    }

    throw new Error("Unexpected response format from Anthropic API");
  } catch (error) {
    console.error("Error generating game recap:", error);
    throw new Error(`Failed to generate recap: ${error}`);
  }
}

export type GOTWPreviewData = {
  homeTeam: string
  awayTeam: string
  homeRecord: string
  awayRecord: string
  homeRank: number
  awayRank: number
  predictedScore: string
  confidence: number
  keyMatchups: string[]
  storylines: string[]
}

/**
 * Generate AI preview for Game of the Week
 */
export async function generateGOTWPreview(data: GOTWPreviewData): Promise<string> {
  if (!anthropic) {
    throw new Error("Anthropic API key not configured. Add ANTHROPIC_API_KEY to your .env file.");
  }

  const prompt = `You're writing a hype preview for the NEL Game of the Week in a Madden video game franchise. Use ONLY the data provided. NO real NFL history.

Game: ${data.awayTeam} (${data.awayRecord}, #${data.awayRank}) at ${data.homeTeam} (${data.homeRecord}, #${data.homeRank})

Key Storylines:
${data.storylines.map(s => `- ${s}`).join('\n')}

Prediction: ${data.predictedScore} (${data.confidence}% confidence)

Write 2-3 paragraphs building excitement for this matchup. Focus on:
1. Why this game matters
2. Key strengths/weaknesses matchup
3. What to watch for
4. Bold prediction or hot take

Be engaging and hype, but base everything on the stats provided. Keep it under 300 words.

Write the preview:`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text.trim();
    }

    throw new Error("Unexpected response format from Anthropic API");
  } catch (error) {
    console.error("Error generating GOTW preview:", error);
    throw new Error(`Failed to generate preview: ${error}`);
  }
}

export type TeamRosterRankingData = {
  rank: number
  teamName: string
  rosterScore: number
  avgOvr: number
  starterOvr: number
  eliteCount: number
  superEliteCount: number
  xFactorCount: number
  superstarCount: number
  strongestGroup: string
  weakestGroup: string
  topPlayerNames: string[]
}

/**
 * Generate AI roster ranking narrative for a team
 */
export async function generateRosterRankingNarrative(data: TeamRosterRankingData): Promise<string> {
  if (!anthropic) {
    throw new Error("Anthropic API key not configured. Add ANTHROPIC_API_KEY to your .env file.");
  }

  const prompt = `You're analyzing a Madden video game franchise roster before the season starts. Write a punchy, analyst-style take on this team's roster using ONLY the data provided.

Team: ${data.teamName}
Roster Score: ${data.rosterScore}
Average OVR: ${data.avgOvr}
Starter OVR: ${data.starterOvr}
Elite Players (85+): ${data.eliteCount}
Super Elite (90+): ${data.superEliteCount}
X-Factors: ${data.xFactorCount}
Superstars: ${data.superstarCount}
Strongest Position: ${data.strongestGroup}
Weakest Position: ${data.weakestGroup}
Top Players: ${data.topPlayerNames.join(', ')}

Write 2-3 SHORT sentences with personality. Be direct, engaging, and roster-focused. Reference specific strengths/weaknesses. Keep it under 90 words.

Examples:
- "Loaded with 5 X-Factors and an elite secondary, this roster is built to dominate. Watch out for that weak O-line though."
- "Paper thin depth but the starters are absolutely stacked at 87.2 OVR. Live or die by the top 22."
- "No flash, no superstar power, just a balanced roster that could surprise some people."

Write your take:`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text.trim();
    }

    throw new Error("Unexpected response format from Anthropic API");
  } catch (error) {
    console.error("Error generating roster ranking narrative:", error);
    throw new Error(`Failed to generate narrative: ${error}`);
  }
}

/**
 * Check if Anthropic API is configured
 */
export function isAnthropicConfigured(): boolean {
  return !!ANTHROPIC_API_KEY;
}
