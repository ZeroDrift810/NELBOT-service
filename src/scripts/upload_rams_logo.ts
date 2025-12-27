import { createProdClient } from "../discord/discord_utils"
import * as fs from "fs"
import * as path from "path"

async function uploadRamsLogo() {
  console.log("Uploading Rams logo...")

  const client = createProdClient()

  // Read the Rams logo file
  const logoPath = path.join(process.cwd(), "emojis", "snallabot_lar.png")
  const buffer = fs.readFileSync(logoPath)
  const base64Image = `data:image/png;base64,${buffer.toString('base64')}`

  try {
    const emoji = await client.uploadEmoji(base64Image, "snallabot_lar")
    console.log(`✅ Rams logo uploaded successfully!`)
    console.log(`   Emoji Name: ${emoji.name}`)
    console.log(`   Emoji ID: ${emoji.id}`)
    console.log(`   Discord Format: <:${emoji.name}:${emoji.id}>`)
    console.log(`\n📝 Please update the LAR emoji ID in src/discord/discord_utils.ts:`)
    console.log(`   LAR = "<:${emoji.name}:${emoji.id}>",`)
  } catch (error) {
    console.error("❌ Failed to upload Rams logo:", error)
    process.exit(1)
  }
}

uploadRamsLogo()
