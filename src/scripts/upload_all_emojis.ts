import { createProdClient } from "../discord/discord_utils"
import * as fs from "fs"
import * as path from "path"

async function uploadAllEmojis() {
  console.log("🚀 Uploading all emojis to your Discord server...")

  const client = createProdClient()
  const emojisDir = path.join(process.cwd(), "emojis")

  // Define emoji mapping
  const emojiFiles = [
    // Team logos
    "snallabot_ari.png",
    "snallabot_atl.png",
    "snallabot_bal.png",
    "snallabot_buf.png",
    "snallabot_car.png",
    "snallabot_chi.png",
    "snallabot_cin.png",
    "snallabot_cle.png",
    "snallabot_dal.png",
    "snallabot_den.png",
    "snallabot_det.png",
    "snallabot_gb.png",
    "snallabot_hou.png",
    "snallabot_ind.png",
    "snallabot_jax.png",
    "snallabot_kc.png",
    "snallabot_lac.png",
    "snallabot_lar.png",
    "snallabot_lv.png",
    "snallabot_mia.png",
    "snallabot_min.png",
    "snallabot_ne.png",
    "snallabot_no.png",
    "snallabot_nyg.png",
    "snallabot_nyj.png",
    "snallabot_phi.png",
    "snallabot_pit.png",
    "snallabot_sea.png",
    "snallabot_sf.png",
    "snallabot_tb.png",
    "snallabot_ten.png",
    "snallabot_was.png",
    // Dev traits
    "snallabot_hidden_dev.webp",
    "snallabot_normal_dev.webp",
    "snallabot_star_dev.webp",
    "snallabot_superstar_dev.webp",
    "snallabot_xfactor_dev.webp",
    // Game results
    "snallabot_win.webp",
    "snallabot_loss.webp",
    "snallabot_tie.webp",
    // Yes/No
    "snallabot_yes.webp",
    "snallabot_no.webp",
    // Status
    "snallabot_done.webp",
    "snallabot_error.webp",
    "snallabot_loading.webp",
    "snallabot_waiting.webp"
  ]

  const uploadedEmojis: { name: string, id: string, format: string }[] = []

  for (const filename of emojiFiles) {
    const emojiPath = path.join(emojisDir, filename)

    if (!fs.existsSync(emojiPath)) {
      console.log(`⚠️  Skipping ${filename} - file not found`)
      continue
    }

    const emojiName = path.parse(filename).name as string

    try {
      const buffer = fs.readFileSync(emojiPath)
      const ext = path.extname(filename).substring(1)
      const mimeType = ext === 'webp' ? 'image/webp' : 'image/png'
      const base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`

      const emoji = await client.uploadEmoji(base64Image, emojiName)
      const format = `<:${emoji.name}:${emoji.id}>`

      uploadedEmojis.push({ name: emojiName, id: emoji.id!, format })
      console.log(`✅ Uploaded ${emojiName}: ${format}`)

      // Discord rate limit - wait 1 second between uploads
      await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (error: any) {
      console.error(`❌ Failed to upload ${emojiName}:`, error.message)
    }
  }

  console.log(`\n\n📝 ====== UPDATE CODE WITH THESE VALUES ======\n`)

  // Generate team emojis enum
  console.log("// In src/discord/discord_utils.ts - SnallabotTeamEmojis enum:")
  const teamEmojis = uploadedEmojis.filter(e => e.name.startsWith('snallabot_') && !e.name.includes('_dev') && !e.name.includes('_win') && !e.name.includes('_loss') && !e.name.includes('_tie') && !e.name.includes('_yes') && !e.name.includes('_no') && !e.name.includes('_done') && !e.name.includes('_error') && !e.name.includes('_loading') && !e.name.includes('_waiting'))
  for (const emoji of teamEmojis) {
    const abbr = emoji.name.replace('snallabot_', '').toUpperCase()
    console.log(`  ${abbr} = "${emoji.format}",`)
  }

  // Generate dev trait emojis enum
  console.log("\n// In src/discord/commands/player.ts - SnallabotDevEmojis enum:")
  const devEmojis = uploadedEmojis.filter(e => e.name.includes('_dev'))
  const devMap: Record<string, string> = {
    'snallabot_normal_dev': 'NORMAL',
    'snallabot_star_dev': 'STAR',
    'snallabot_superstar_dev': 'SUPERSTAR',
    'snallabot_xfactor_dev': 'XFACTOR',
    'snallabot_hidden_dev': 'HIDDEN'
  }
  for (const emoji of devEmojis) {
    const key = devMap[emoji.name]
    if (key) {
      console.log(`  ${key} = "${emoji.format}",`)
    }
  }

  // Generate game result emojis
  console.log("\n// In src/discord/commands/player.ts - SnallabotGameResult enum:")
  const gameEmojis = uploadedEmojis.filter(e => e.name.includes('_win') || e.name.includes('_loss') || e.name.includes('_tie'))
  const gameMap: Record<string, string> = {
    'snallabot_win': 'WIN',
    'snallabot_loss': 'LOSS',
    'snallabot_tie': 'TIE'
  }
  for (const emoji of gameEmojis) {
    const key = gameMap[emoji.name]
    if (key) {
      console.log(`  ${key} = "${emoji.format}",`)
    }
  }

  // Generate yes/no emojis
  console.log("\n// In src/discord/commands/player.ts - formatYesNoTrait function:")
  const yesEmoji = uploadedEmojis.find(e => e.name === 'snallabot_yes')
  const noEmoji = uploadedEmojis.find(e => e.name === 'snallabot_no')
  if (yesEmoji) console.log(`    case YesNoTrait.YES: return "${yesEmoji.format}"`)
  if (noEmoji) console.log(`    case YesNoTrait.NO: return "${noEmoji.format}"`)

  console.log(`\n✅ Done! Uploaded ${uploadedEmojis.length} emojis.`)
}

uploadAllEmojis()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("❌ Error:", error)
    process.exit(1)
  })
