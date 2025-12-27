/**
 * Script to upload team logo images as Discord emojis
 * Run with: npx ts-node src/scripts/upload_team_emojis.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config()

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!
const EMOJI_SERVER_ID = process.env.EMOJI_SERVER_ID || '785536090395115522' // Emoji server

// Map of file names to team abbreviations
const TEAM_ABBR_MAP: Record<string, string> = {
  'ari': 'ARI',
  'atl': 'ATL',
  'bal': 'BAL',
  'buf': 'BUF',
  'car': 'CAR',
  'chi': 'CHI',
  'cin': 'CIN',
  'cle': 'CLE',
  'dal': 'DAL',
  'den': 'DEN',
  'det': 'DET',
  'gb': 'GB',
  'hou': 'HOU',
  'ind': 'IND',
  'jax': 'JAX',
  'kc': 'KC',
  'lac': 'LAC',
  'lar': 'LAR',
  'lv': 'LV',
  'mia': 'MIA',
  'min': 'MIN',
  'ne': 'NE',
  'no': 'NO',
  'nyg': 'NYG',
  'nyj': 'NYJ',
  'phi': 'PHI',
  'pit': 'PIT',
  'sea': 'SEA',
  'sf': 'SF',
  'tb': 'TB',
  'ten': 'TEN',
  'was': 'WAS',
  'nfl': 'NFL',
  'afc': 'AFC',
  'nfc': 'NFC'
}

const LOGO_DIR = 'C:\\LeagueHQ\\NELBOTMASTER\\images\\NFL__Relocation_Logos_Flat_and_3D\\PNG\\3d'

async function uploadEmoji(serverID: string, name: string, imageBuffer: Buffer): Promise<{ id: string, name: string } | null> {
  const base64Image = imageBuffer.toString('base64')
  const dataUri = `data:image/png;base64,${base64Image}`

  const response = await fetch(`https://discord.com/api/v10/guilds/${serverID}/emojis`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: name,
      image: dataUri
    })
  })

  if (!response.ok) {
    const error = await response.text()
    console.error(`Failed to upload ${name}:`, error)
    return null
  }

  const emoji = await response.json() as { id: string, name: string }
  return emoji
}

async function getExistingEmojis(serverID: string): Promise<Map<string, string>> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${serverID}/emojis`, {
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`
    }
  })

  if (!response.ok) {
    console.error('Failed to get existing emojis')
    return new Map()
  }

  const emojis = await response.json() as Array<{ id: string, name: string }>
  const emojiMap = new Map<string, string>()
  emojis.forEach(e => emojiMap.set(e.name.toLowerCase(), e.id))
  return emojiMap
}

async function deleteEmoji(serverID: string, emojiId: string): Promise<boolean> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${serverID}/emojis/${emojiId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`
    }
  })
  return response.ok
}

async function main() {
  console.log('🏈 Uploading NFL team logos as Discord emojis...\n')
  console.log(`Server ID: ${EMOJI_SERVER_ID}`)
  console.log(`Logo directory: ${LOGO_DIR}\n`)

  // Get existing emojis to avoid duplicates
  const existingEmojis = await getExistingEmojis(EMOJI_SERVER_ID)
  console.log(`Found ${existingEmojis.size} existing emojis\n`)

  const results: Record<string, { name: string, id: string }> = {}
  const files = fs.readdirSync(LOGO_DIR)

  for (const file of files) {
    if (!file.endsWith('.png')) continue

    const baseName = path.basename(file, '.png').toLowerCase()
    const teamAbbr = TEAM_ABBR_MAP[baseName]

    if (!teamAbbr) {
      console.log(`⏭️  Skipping ${file} (not a team logo)`)
      continue
    }

    const emojiName = `nel_${teamAbbr.toLowerCase()}`

    // Check if emoji already exists
    if (existingEmojis.has(emojiName)) {
      const existingId = existingEmojis.get(emojiName)!
      console.log(`✓ ${teamAbbr} already exists: <:${emojiName}:${existingId}>`)
      results[teamAbbr] = { name: emojiName, id: existingId }
      continue
    }

    // Read and upload image
    const imagePath = path.join(LOGO_DIR, file)
    const imageBuffer = fs.readFileSync(imagePath)

    console.log(`📤 Uploading ${teamAbbr}...`)
    const emoji = await uploadEmoji(EMOJI_SERVER_ID, emojiName, imageBuffer)

    if (emoji) {
      console.log(`✅ ${teamAbbr}: <:${emoji.name}:${emoji.id}>`)
      results[teamAbbr] = { name: emoji.name, id: emoji.id }
    } else {
      console.log(`❌ Failed to upload ${teamAbbr}`)
    }

    // Rate limit: wait between uploads
    await new Promise(r => setTimeout(r, 1000))
  }

  // Generate the TypeScript enum
  console.log('\n\n// ============ COPY THIS TO discord_utils.ts ============\n')
  console.log('export enum NELTeamEmojis {')

  const sortedTeams = Object.keys(results).sort()
  for (const team of sortedTeams) {
    const { name, id } = results[team]
    console.log(`  ${team} = "<:${name}:${id}>",`)
  }

  console.log('}')
  console.log('\n// =========================================================\n')

  // Also save to a JSON file for reference
  fs.writeFileSync('team_emojis.json', JSON.stringify(results, null, 2))
  console.log('💾 Saved emoji data to team_emojis.json')
}

main().catch(console.error)
