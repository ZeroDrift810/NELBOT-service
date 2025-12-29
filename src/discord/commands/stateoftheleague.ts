import { ParameterizedContext } from "koa"
import { CommandHandler, Command } from "../commands_handler"
import { respond, DiscordClient, deferMessage } from "../discord_utils"
import { ApplicationCommandOptionType, ApplicationCommandType, ChannelType, RESTPostAPIApplicationCommandsJSONBody, APIApplicationCommandInteractionDataChannelOption, APIApplicationCommandInteractionDataRoleOption } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { ChannelId, DiscordIdType } from "../settings_db"
import * as fs from "fs"
import * as path from "path"

// NEL Historical Data - Compiled from 2 seasons
const NEL_DATA = {
  superBowls: {
    season1: {
      champion: "Raiders",
      record: "19-0",
      opponent: "Panthers",
      score: "38-18"
    },
    season2: {
      champion: "Cowboys",
      record: "16-1",
      opponent: "Raiders",
      score: "49-41"
    }
  },
  historicRecords: {
    raiders: {
      combined: "35-1",
      s1: "19-0",
      s2: "16-1",
      note: "Only loss: Super Bowl LX to Cowboys"
    },
    cowboys: {
      s1: "6-11",
      s2: "16-1",
      turnaround: "+27 games",
      note: "Greatest turnaround in NEL history"
    },
    dolphins: {
      s1: "12-6",
      s2: "0-17",
      collapse: "-29 games",
      note: "Historic collapse from playoff contender to winless"
    },
    rams: {
      s1: "1-16",
      s2: "10-7",
      note: "Rebuilt from worst to playoff contender"
    }
  },
  divisionWinners: {
    season1: {
      "AFC East": { team: "Dolphins", record: "12-6" },
      "AFC North": { team: "Ravens", record: "17-0" },
      "AFC South": { team: "Texans", record: "17-0" },
      "AFC West": { team: "Raiders", record: "19-0" },
      "NFC East": { team: "Commanders", record: "10-7" },
      "NFC North": { team: "Lions", record: "17-0" },
      "NFC South": { team: "Panthers", record: "8-9" },
      "NFC West": { team: "49ers", record: "14-3" }
    },
    season2: {
      "AFC East": { team: "Jets", record: "14-3" },
      "AFC North": { team: "Browns", record: "11-6" },
      "AFC South": { team: "Texans", record: "17-0" },
      "AFC West": { team: "Raiders", record: "16-1" },
      "NFC East": { team: "Cowboys", record: "16-1" },
      "NFC North": { team: "Lions", record: "15-2" },
      "NFC South": { team: "Buccaneers", record: "10-7" },
      "NFC West": { team: "Seahawks", record: "14-3" }
    }
  },
  statsLeaders: {
    passing: [
      { name: "Brock Purdy", yards: 8856, tds: 73, ints: 22, team: "49ers" },
      { name: "C.J. Stroud", yards: 8651, tds: 64, ints: 29, team: "Texans" },
      { name: "Bryce Young", yards: 8374, tds: 66, ints: 20, team: "Panthers" },
      { name: "Jalen Hurts", yards: 7895, tds: 72, ints: 22, team: "Eagles" },
      { name: "Joe Burrow", yards: 7834, tds: 70, ints: 10, team: "Bengals" }
    ],
    rushing: [
      { name: "Joe Mixon", yards: 3513, tds: 41, team: "Texans" },
      { name: "Jonathan Taylor", yards: 3180, tds: 39, team: "Colts" },
      { name: "Breece Hall", yards: 3150, tds: 32, team: "Jets" },
      { name: "Saquon Barkley", yards: 3042, tds: 40, team: "Eagles" },
      { name: "Josh Jacobs", yards: 2892, tds: 25, team: "Packers" }
    ],
    receiving: [
      { name: "CeeDee Lamb", yards: 4006, tds: 44, team: "Cowboys" },
      { name: "Tyreek Hill", yards: 3534, tds: 26, team: "Dolphins" },
      { name: "Ja'Marr Chase", yards: 3488, tds: 40, team: "Bengals" },
      { name: "Nico Collins", yards: 3333, tds: 30, team: "Texans" },
      { name: "A.J. Brown", yards: 2970, tds: 31, team: "Eagles" }
    ],
    sacks: [
      { name: "Micah Parsons", sacks: 35, team: "Cowboys" },
      { name: "Myles Garrett", sacks: 24, team: "Browns" },
      { name: "Josh Allen", sacks: 22.5, team: "Jaguars" },
      { name: "Maxx Crosby", sacks: 22, team: "Raiders" },
      { name: "T.J. Watt", sacks: 21.5, team: "Steelers" }
    ]
  }
}

// Discord embed colors
const COLORS = {
  GOLD: 0xFFD700,
  SILVER: 0xC0C0C0,
  RAIDERS: 0x000000,
  COWBOYS: 0x002244,
  NEL_BLUE: 0x1E90FF,
  STATS_PURPLE: 0x9B59B6,
  SUCCESS: 0x2ECC71,
  WARNING: 0xF1C40F
}

async function postStateOfTheLeague(
  client: DiscordClient,
  token: string,
  guildId: string,
  channelId: string,
  roleId?: string
) {
  try {
    // Read images for embeds
    const assetsPath = path.join(__dirname, "../../../assets/images")
    let richEisenBuffer: Buffer | null = null
    let minaKimesBuffer: Buffer | null = null

    try {
      richEisenBuffer = fs.readFileSync(path.join(assetsPath, "rich-eisen.jpg"))
      minaKimesBuffer = fs.readFileSync(path.join(assetsPath, "minakimes.png"))
    } catch (e) {
      console.log("Could not load presenter images, continuing without them")
    }

    // Build embeds array
    const embeds = []

    // Embed 1: Welcome / Rich Eisen Intro
    embeds.push({
      title: "STATE OF THE NEL - Season 3 Draft Day Edition",
      description: `*Live from NEL Headquarters*\n\n**Rich Eisen:** Good evening, NEL Nation! As we prepare for the Season 3 Draft, let's look back at two incredible seasons of action. From perfect seasons to historic collapses, the NEL has delivered drama at every turn.`,
      color: COLORS.NEL_BLUE,
      thumbnail: richEisenBuffer ? { url: "attachment://rich-eisen.jpg" } : undefined,
      footer: { text: "NEL Network - Your Home for NEL Coverage" }
    })

    // Embed 2: Super Bowl Champions
    embeds.push({
      title: "SUPER BOWL CHAMPIONS",
      color: COLORS.GOLD,
      fields: [
        {
          name: "Super Bowl LIX (Season 1)",
          value: `**${NEL_DATA.superBowls.season1.champion}** defeat ${NEL_DATA.superBowls.season1.opponent}\n${NEL_DATA.superBowls.season1.score}\n*Perfect 19-0 season*`,
          inline: true
        },
        {
          name: "Super Bowl LX (Season 2)",
          value: `**${NEL_DATA.superBowls.season2.champion}** defeat ${NEL_DATA.superBowls.season2.opponent}\n${NEL_DATA.superBowls.season2.score}\n*The rematch that shocked the world*`,
          inline: true
        }
      ],
      footer: { text: "The Raiders and Cowboys: A rivalry for the ages" }
    })

    // Embed 3: Historic Records
    embeds.push({
      title: "HISTORIC RECORDS & STORYLINES",
      color: COLORS.RAIDERS,
      fields: [
        {
          name: "The Raiders Dynasty",
          value: `**35-1** combined record over 2 seasons\nS1: 19-0 (Perfect Season + Super Bowl)\nS2: 16-1 (Super Bowl Appearance)\n*Only loss: Super Bowl LX to the Cowboys*`,
          inline: false
        },
        {
          name: "Cowboys' Legendary Turnaround",
          value: `S1: 6-11 (Basement Dwellers)\nS2: 16-1 (Super Bowl Champions)\n**+27 game swing** - Greatest turnaround in league history`,
          inline: false
        },
        {
          name: "Dolphins' Historic Collapse",
          value: `S1: 12-6 (Playoff Contender)\nS2: 0-17 (Winless Season)\n**-29 game swing** - From division winner to historic futility`,
          inline: false
        }
      ]
    })

    // Embed 4: Division Winners Season 1
    const s1Divs = NEL_DATA.divisionWinners.season1
    embeds.push({
      title: "SEASON 1 DIVISION CHAMPIONS",
      color: COLORS.SILVER,
      fields: [
        { name: "AFC East", value: `${s1Divs["AFC East"].team} (${s1Divs["AFC East"].record})`, inline: true },
        { name: "AFC North", value: `${s1Divs["AFC North"].team} (${s1Divs["AFC North"].record})`, inline: true },
        { name: "AFC South", value: `${s1Divs["AFC South"].team} (${s1Divs["AFC South"].record})`, inline: true },
        { name: "AFC West", value: `${s1Divs["AFC West"].team} (${s1Divs["AFC West"].record})`, inline: true },
        { name: "NFC East", value: `${s1Divs["NFC East"].team} (${s1Divs["NFC East"].record})`, inline: true },
        { name: "NFC North", value: `${s1Divs["NFC North"].team} (${s1Divs["NFC North"].record})`, inline: true },
        { name: "NFC South", value: `${s1Divs["NFC South"].team} (${s1Divs["NFC South"].record})`, inline: true },
        { name: "NFC West", value: `${s1Divs["NFC West"].team} (${s1Divs["NFC West"].record})`, inline: true }
      ]
    })

    // Embed 5: Division Winners Season 2
    const s2Divs = NEL_DATA.divisionWinners.season2
    embeds.push({
      title: "SEASON 2 DIVISION CHAMPIONS",
      color: COLORS.COWBOYS,
      fields: [
        { name: "AFC East", value: `${s2Divs["AFC East"].team} (${s2Divs["AFC East"].record})`, inline: true },
        { name: "AFC North", value: `${s2Divs["AFC North"].team} (${s2Divs["AFC North"].record})`, inline: true },
        { name: "AFC South", value: `${s2Divs["AFC South"].team} (${s2Divs["AFC South"].record})`, inline: true },
        { name: "AFC West", value: `${s2Divs["AFC West"].team} (${s2Divs["AFC West"].record})`, inline: true },
        { name: "NFC East", value: `${s2Divs["NFC East"].team} (${s2Divs["NFC East"].record})`, inline: true },
        { name: "NFC North", value: `${s2Divs["NFC North"].team} (${s2Divs["NFC North"].record})`, inline: true },
        { name: "NFC South", value: `${s2Divs["NFC South"].team} (${s2Divs["NFC South"].record})`, inline: true },
        { name: "NFC West", value: `${s2Divs["NFC West"].team} (${s2Divs["NFC West"].record})`, inline: true }
      ]
    })

    // Embed 6: Mina Kimes Stats Intro
    embeds.push({
      title: "TWO-SEASON STATISTICAL LEADERS",
      description: `**Mina Kimes:** Let's dive into the numbers, because the stats tell the story of this league.\n\nThese are the cumulative leaders across both Season 1 and Season 2:`,
      color: COLORS.STATS_PURPLE,
      thumbnail: minaKimesBuffer ? { url: "attachment://minakimes.png" } : undefined
    })

    // Embed 7: Passing Leaders
    const passingLeaders = NEL_DATA.statsLeaders.passing
      .map((p, i) => `**${i + 1}.** ${p.name} (${p.team}) - ${p.yards.toLocaleString()} YDS, ${p.tds} TD, ${p.ints} INT`)
      .join("\n")
    embeds.push({
      title: "PASSING LEADERS (2 Seasons)",
      description: passingLeaders,
      color: COLORS.STATS_PURPLE,
      footer: { text: "Brock Purdy leads by just 205 yards over C.J. Stroud" }
    })

    // Embed 8: Rushing Leaders
    const rushingLeaders = NEL_DATA.statsLeaders.rushing
      .map((p, i) => `**${i + 1}.** ${p.name} (${p.team}) - ${p.yards.toLocaleString()} YDS, ${p.tds} TD`)
      .join("\n")
    embeds.push({
      title: "RUSHING LEADERS (2 Seasons)",
      description: rushingLeaders,
      color: COLORS.STATS_PURPLE,
      footer: { text: "Joe Mixon: 3,513 yards and 41 TDs - Dominant" }
    })

    // Embed 9: Receiving Leaders
    const receivingLeaders = NEL_DATA.statsLeaders.receiving
      .map((p, i) => `**${i + 1}.** ${p.name} (${p.team}) - ${p.yards.toLocaleString()} YDS, ${p.tds} TD`)
      .join("\n")
    embeds.push({
      title: "RECEIVING LEADERS (2 Seasons)",
      description: receivingLeaders,
      color: COLORS.STATS_PURPLE,
      footer: { text: "CeeDee Lamb: 4,006 yards - The only 4K receiver in NEL history" }
    })

    // Embed 10: Defensive Leaders
    const sackLeaders = NEL_DATA.statsLeaders.sacks
      .map((p, i) => `**${i + 1}.** ${p.name} (${p.team}) - ${p.sacks} sacks`)
      .join("\n")
    embeds.push({
      title: "SACK LEADERS (2 Seasons)",
      description: sackLeaders,
      color: COLORS.STATS_PURPLE,
      footer: { text: "Micah Parsons: 35 sacks - 11 more than anyone else" }
    })

    const targetChannel: ChannelId = { id: channelId, id_type: DiscordIdType.CHANNEL }

    // First message: Embeds 1-5 with Rich Eisen image - POST TO TARGET CHANNEL
    const formData1 = new FormData()

    // Prepare first batch embeds (with thumbnail reference if image exists)
    const firstBatchEmbeds = embeds.slice(0, 5).map((embed, idx) => {
      if (idx === 0 && richEisenBuffer) {
        return { ...embed, thumbnail: { url: "attachment://rich-eisen.jpg" } }
      }
      const { thumbnail, ...rest } = embed as any
      return rest
    })

    if (richEisenBuffer) {
      const richBlob = new Blob([richEisenBuffer], { type: 'image/jpeg' })
      formData1.append('files[0]', richBlob, 'rich-eisen.jpg')
    }
    formData1.append('payload_json', JSON.stringify({
      content: roleId ? `<@&${roleId}>` : undefined,
      embeds: firstBatchEmbeds
    }))

    try {
      // Post first batch to target channel (not edit original)
      await client.createMessageWithForm(targetChannel, formData1)
      console.log("First batch of embeds sent successfully")
    } catch (e) {
      console.error("Error sending first batch:", e)
    }

    // Confirm to user
    await client.editOriginalInteraction(token, {
      content: `✅ State of the League posted to <#${channelId}>`
    })

    // Small delay to ensure messages appear in order
    await new Promise(resolve => setTimeout(resolve, 500))

    // Prepare second batch embeds (with thumbnail reference if image exists)
    const secondBatchEmbeds = embeds.slice(5).map((embed, idx) => {
      if (idx === 0 && minaKimesBuffer) {
        return { ...embed, thumbnail: { url: "attachment://minakimes.png" } }
      }
      const { thumbnail, ...rest } = embed as any
      return rest
    })

    const formData2 = new FormData()
    if (minaKimesBuffer) {
      const minaBlob = new Blob([minaKimesBuffer], { type: 'image/png' })
      formData2.append('files[0]', minaBlob, 'minakimes.png')
    }
    formData2.append('payload_json', JSON.stringify({
      embeds: secondBatchEmbeds
    }))

    try {
      await client.createMessageWithForm(targetChannel, formData2)
      console.log("Second batch of embeds sent successfully")
    } catch (e) {
      console.error("Error sending second batch:", e)
    }

    console.log(`State of the League posted successfully`)

  } catch (e) {
    console.error("Error posting state of the league:", e)
    await client.editOriginalInteraction(token, {
      content: `Failed to post State of the League: ${e}`
    })
  }
}

export default {
  async handleCommand(command: Command, client: DiscordClient, db: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token, channel_id } = command

    // Get target channel from options, default to current channel
    const options = command.data.options || []
    const channelOption = options.find(o => o.name === "channel") as APIApplicationCommandInteractionDataChannelOption | undefined
    const targetChannelId = channelOption ? channelOption.value : channel_id

    // Get optional role to ping
    const roleOption = options.find(o => o.name === "role") as APIApplicationCommandInteractionDataRoleOption | undefined
    const roleId = roleOption ? roleOption.value : undefined

    // Defer immediately
    respond(ctx, deferMessage())

    // Post the state of the league
    postStateOfTheLeague(client, token, guild_id, targetChannelId, roleId)
  },

  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "stateoftheleague",
      description: "Post the State of the NEL - A comprehensive look at 2 seasons of history",
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: "channel",
          description: "Channel to post the State of the League in",
          channel_types: [ChannelType.GuildText],
          required: true
        },
        {
          type: ApplicationCommandOptionType.Role,
          name: "role",
          description: "Role to ping when posting",
          required: false
        }
      ]
    }
  }
} as CommandHandler
