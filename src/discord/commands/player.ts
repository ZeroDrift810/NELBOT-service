import { ParameterizedContext } from "koa"
import { CommandHandler, Command, AutocompleteHandler, Autocomplete, MessageComponentHandler, MessageComponentInteraction } from "../commands_handler"
import { respond, DiscordClient, deferMessage, getTeamEmoji, SnallabotTeamEmojis } from "../discord_utils"
import { APIApplicationCommandInteractionDataStringOption, APIApplicationCommandInteractionDataSubcommandOption, APIMessageStringSelectInteractionData, ApplicationCommandOptionType, ButtonStyle, ComponentType, InteractionResponseType, RESTPostAPIApplicationCommandsJSONBody, SeparatorSpacingSize } from "discord-api-types/v10"
import { Firestore } from "firebase-admin/firestore"
import { playerSearchIndex, discordLeagueView, teamSearchView, LeagueLogos, leagueLogosView } from "../../db/view"
import fuzzysort from "fuzzysort"
import MaddenDB, { PlayerListQuery, PlayerStatType, PlayerStats, TeamList } from "../../db/madden_db"
import { DevTrait, LBStyleTrait, MADDEN_SEASON, MaddenGame, POSITIONS, POSITION_GROUP, PlayBallTrait, Player, QBStyleTrait, SensePressureTrait, YesNoTrait } from "../../export/madden_league_types"

// EA's public CDN for Madden player portraits
const MADDEN_PORTRAIT_CDN = "https://ratings-images-prod.pulse.ea.com/madden-nfl-26/portraits"

function getPlayerPortraitUrl(portraitId: number): string {
  return `${MADDEN_PORTRAIT_CDN}/${portraitId}.png`
}

enum PlayerSelection {
  PLAYER_OVERVIEW = "po",
  PLAYER_FULL_RATINGS = "pr",
  PLAYER_WEEKLY_STATS = "pw",
  PLAYER_SEASON_STATS = "ps",
  PLAYER_CONTRACT = "pc"
}

type Selection = { r: number, s: PlayerSelection, q?: PlayerPagination }

function formatPlaceholder(selection: PlayerSelection): string {
  switch (selection) {
    case PlayerSelection.PLAYER_OVERVIEW:
      return "Overview"
    case PlayerSelection.PLAYER_FULL_RATINGS:
      return "Full Ratings"
    case PlayerSelection.PLAYER_SEASON_STATS:
      return "Season Stats"
    case PlayerSelection.PLAYER_WEEKLY_STATS:
      return "Weekly Stats"
    case PlayerSelection.PLAYER_CONTRACT:
      return "Contract"
  }
}

function generatePlayerOptions(rosterId: number, pagination?: PlayerPagination) {
  return [
    {
      label: "Overview",
      value: { r: rosterId, s: PlayerSelection.PLAYER_OVERVIEW },
    },
    {
      label: "Full Ratings",
      value: { r: rosterId, s: PlayerSelection.PLAYER_FULL_RATINGS }
    },
    {
      label: "Weekly Stats",
      value: { r: rosterId, s: PlayerSelection.PLAYER_WEEKLY_STATS }
    },
    {
      label: "Season Stats",
      value: { r: rosterId, s: PlayerSelection.PLAYER_SEASON_STATS }
    },
    {
      label: "Contract",
      value: { r: rosterId, s: PlayerSelection.PLAYER_CONTRACT }
    }
  ].map(option => {
    if (pagination) (option.value as Selection).q = pagination
    return option
  })
    .map(option => ({ ...option, value: JSON.stringify(option.value) }))
}

function generatePlayerZoomOptions(players: Player[], currentPagination: PlayerPagination) {
  return players.map(p => ({ label: `${p.position} ${p.firstName} ${p.lastName}`, value: { r: p.rosterId, s: PlayerSelection.PLAYER_OVERVIEW, q: currentPagination } }))
    .map(option => ({ ...option, value: JSON.stringify(option.value) }))
}

async function showPlayerCard(playerSearch: string, client: DiscordClient, token: string, guild_id: string, pagination?: PlayerPagination) {
  try {
    const discordLeague = await discordLeagueView.createView(guild_id)
    const leagueId = discordLeague?.leagueId
    if (!leagueId) {
      throw new Error(`No League connected to snallabot`)
    }
    let searchRosterId = Number(playerSearch)
    if (isNaN(searchRosterId)) {
      // get top search result
      const results = await searchPlayerForRosterId(playerSearch, leagueId)
      if (results.length === 0) {
        throw new Error(`No player results for ${playerSearch} in ${leagueId}`)
      }
      searchRosterId = results[0].rosterId
    }
    const [player, teamList] = await Promise.all([MaddenDB.getPlayer(leagueId, `${searchRosterId}`), MaddenDB.getLatestTeams(leagueId)])
    const backToSearch = pagination ? [
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            label: "Back to List",
            custom_id: `${JSON.stringify(pagination)}`
          }
        ]
      }

    ] : []
    const logos = await leagueLogosView.createView(leagueId)
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: 9, // Section
          components: [
            {
              type: ComponentType.TextDisplay,
              content: formatPlayerCard(player, teamList, logos)
            }
          ],
          accessory: {
            type: 11, // Thumbnail
            media: {
              url: getPlayerPortraitUrl(player.portraitId)
            }
          }
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Large
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "player_card",
              placeholder: formatPlaceholder(PlayerSelection.PLAYER_OVERVIEW),
              options: generatePlayerOptions(searchRosterId, pagination)
            }
          ]
        },
        ...backToSearch
      ]
    })
  } catch (e) {
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Could not show player card ${e}`
        }
      ]
    })
  }
}

async function showPlayerFullRatings(rosterId: number, client: DiscordClient, token: string, guild_id: string, pagination?: PlayerPagination) {
  const discordLeague = await discordLeagueView.createView(guild_id)
  const leagueId = discordLeague?.leagueId
  if (!leagueId) {
    throw new Error(`No League connected to snallabot`)
  }
  const [player, teamList] = await Promise.all([MaddenDB.getPlayer(leagueId, `${rosterId}`), MaddenDB.getLatestTeams(leagueId)])
  // 0 team id means the player is a free agent
  const backToSearch = pagination ? [
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Back to List",
          custom_id: `${JSON.stringify(pagination)}`
        }
      ]
    }

  ] : []
  const logos = await leagueLogosView.createView(leagueId)
  await client.editOriginalInteraction(token, {
    flags: 32768,
    components: [
      {
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: formatFullRatings(player, teamList, logos)
          }
        ],
        accessory: {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(player.portraitId)
          }
        }
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Large
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "player_card",
            placeholder: formatPlaceholder(PlayerSelection.PLAYER_FULL_RATINGS),
            options: generatePlayerOptions(rosterId, pagination)
          }
        ]
      },
      ...backToSearch
    ]
  })
}

async function showPlayerWeeklyStats(rosterId: number, client: DiscordClient, token: string, guild_id: string, pagination?: PlayerPagination) {
  const discordLeague = await discordLeagueView.createView(guild_id)
  const leagueId = discordLeague?.leagueId
  if (!leagueId) {
    throw new Error(`No League connected to snallabot`)
  }
  const [player, teamList] = await Promise.all([MaddenDB.getPlayer(leagueId, `${rosterId}`), MaddenDB.getLatestTeams(leagueId)])
  const playerStats = await MaddenDB.getPlayerStats(leagueId, player)
  const statGames = new Map<String, { id: number, week: number, season: number }>()
  Object.values(playerStats).flat().forEach(p => statGames.set(`${p.scheduleId}|${p.weekIndex}|${p.seasonIndex}`, { id: p.scheduleId, week: p.weekIndex + 1, season: p.seasonIndex }))
  const games = await MaddenDB.getGamesForSchedule(leagueId, Array.from(statGames.values()))
  const backToSearch = pagination ? [
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Back to List",
          custom_id: `${JSON.stringify(pagination)}`
        }
      ]
    }

  ] : []
  const logos = await leagueLogosView.createView(leagueId)
  await client.editOriginalInteraction(token, {
    flags: 32768,
    components: [
      {
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: formatWeeklyStats(player, teamList, playerStats, games, logos)
          }
        ],
        accessory: {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(player.portraitId)
          }
        }
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Large
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "player_card",
            placeholder: formatPlaceholder(PlayerSelection.PLAYER_WEEKLY_STATS),
            options: generatePlayerOptions(rosterId, pagination)
          }
        ]
      },
      ...backToSearch
    ]
  })
}

async function showPlayerYearlyStats(rosterId: number, client: DiscordClient, token: string, guild_id: string, pagination?: PlayerPagination) {
  const discordLeague = await discordLeagueView.createView(guild_id)
  const leagueId = discordLeague?.leagueId
  if (!leagueId) {
    throw new Error(`No League connected to snallabot`)
  }
  const [player, teamList] = await Promise.all([MaddenDB.getPlayer(leagueId, `${rosterId}`), MaddenDB.getLatestTeams(leagueId)])
  const playerStats = await MaddenDB.getPlayerStats(leagueId, player)
  const backToSearch = pagination ? [
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Back to List",
          custom_id: `${JSON.stringify(pagination)}`
        }
      ]
    }

  ] : []
  const logos = await leagueLogosView.createView(leagueId)
  await client.editOriginalInteraction(token, {
    flags: 32768,
    components: [
      {
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: formatSeasonStats(player, playerStats, teamList, logos)
          }
        ],
        accessory: {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(player.portraitId)
          }
        }
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Large
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "player_card",
            placeholder: formatPlaceholder(PlayerSelection.PLAYER_SEASON_STATS),
            options: generatePlayerOptions(rosterId, pagination)
          }
        ]
      },
      ...backToSearch
    ]
  })
}

async function showPlayerContract(rosterId: number, client: DiscordClient, token: string, guild_id: string, pagination?: PlayerPagination) {
  const discordLeague = await discordLeagueView.createView(guild_id)
  const leagueId = discordLeague?.leagueId
  if (!leagueId) {
    throw new Error(`No League connected to snallabot`)
  }
  const [player, teamList] = await Promise.all([MaddenDB.getPlayer(leagueId, `${rosterId}`), MaddenDB.getLatestTeams(leagueId)])
  const backToSearch = pagination ? [
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Back to List",
          custom_id: `${JSON.stringify(pagination)}`
        }
      ]
    }
  ] : []
  const logos = await leagueLogosView.createView(leagueId)
  await client.editOriginalInteraction(token, {
    flags: 32768,
    components: [
      {
        type: 9, // Section
        components: [
          {
            type: ComponentType.TextDisplay,
            content: formatContract(player, teamList, logos)
          }
        ],
        accessory: {
          type: 11, // Thumbnail
          media: {
            url: getPlayerPortraitUrl(player.portraitId)
          }
        }
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Large
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "player_card",
            placeholder: formatPlaceholder(PlayerSelection.PLAYER_CONTRACT),
            options: generatePlayerOptions(rosterId, pagination)
          }
        ]
      },
      ...backToSearch
    ]
  })
}

type ShortPlayerListQuery = { t?: number, p?: string, r?: boolean }
function toShortQuery(q: PlayerListQuery) {
  const query: ShortPlayerListQuery = {}
  if (q.teamId === 0 || (q.teamId && q.teamId !== -1)) query.t = q.teamId
  if (q.position) query.p = q.position
  if (q.rookie) query.r = q.rookie
  return query
}

function fromShortQuery(q: ShortPlayerListQuery) {
  const query: PlayerListQuery = {}
  if (q.t === 0 || (q.t && q.t !== -1)) query.teamId = q.t
  if (q.p) query.position = q.p
  if (q.r) query.rookie = q.r
  return query
}
type PlayerPagination = { q: ShortPlayerListQuery, s?: number, b?: number }
const PAGINATION_LIMIT = 5

async function getPlayers(leagueId: string, query: PlayerListQuery, startAfterPlayer?: number, endBeforePlayer?: number) {
  // if we reach the end just start over 
  if (startAfterPlayer) {
    const player = await MaddenDB.getPlayer(leagueId, `${startAfterPlayer}`)
    const players = await MaddenDB.getPlayers(leagueId, query, PAGINATION_LIMIT, player)
    if (players.length === 0) {
      return await MaddenDB.getPlayers(leagueId, query, PAGINATION_LIMIT)
    }
    return players
  }
  else if (endBeforePlayer) {
    const player = await MaddenDB.getPlayer(leagueId, `${endBeforePlayer}`)
    const players = await MaddenDB.getPlayers(leagueId, query, PAGINATION_LIMIT, undefined, player)
    if (players.length === 0) {
      return await MaddenDB.getPlayers(leagueId, query, PAGINATION_LIMIT)
    }
    return players
  } else {
    return await MaddenDB.getPlayers(leagueId, query, PAGINATION_LIMIT)
  }
}

async function showPlayerList(playerSearch: string, client: DiscordClient, token: string, guild_id: string, startAfterPlayer?: number, endBeforePlayer?: number) {
  try {
    const discordLeague = await discordLeagueView.createView(guild_id)
    const leagueId = discordLeague?.leagueId
    if (!leagueId) {
      throw new Error(`No League connected to snallabot`)
    }
    let query: PlayerListQuery;
    try {
      query = JSON.parse(playerSearch) as PlayerListQuery
    } catch (e) {
      const results = await searchPlayerListForQuery(playerSearch, leagueId)
      if (results.length === 0) {
        throw new Error(`No listable results for ${playerSearch} in ${leagueId}`)
      }
      const { teamId, rookie, position } = results[0]
      query = { teamId, rookie: rookie ? true : false, position }
    }
    const [players, teamList, logos] = await Promise.all([getPlayers(leagueId, query, startAfterPlayer, endBeforePlayer), MaddenDB.getLatestTeams(leagueId), leagueLogosView.createView(leagueId)])
    const message = players.length === 0 ? `# No results` : formatPlayerList(players, teamList, logos)
    const backDisabled = startAfterPlayer || endBeforePlayer ? false : true
    const nextDisabled = players.length < PAGINATION_LIMIT ? true : false
    const nextPagination = players.length === 0 ? startAfterPlayer : players[players.length - 1].rosterId
    const previousPagination = players.length === 0 ? endBeforePlayer : players[0].rosterId
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: message
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: "Back",
              disabled: backDisabled,
              custom_id: `${JSON.stringify({ q: toShortQuery(query), b: previousPagination })}`
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: "Next",
              custom_id: `${JSON.stringify({ q: toShortQuery(query), s: nextPagination })}`,
              disabled: nextDisabled
            }
          ]
        },
        {
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Large
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "player_card",
              placeholder: `Show Player Card`,
              options: generatePlayerZoomOptions(players, { q: toShortQuery(query), s: startAfterPlayer, b: endBeforePlayer })
            }
          ]
        }
      ]
    })
  } catch (e) {
    await client.editOriginalInteraction(token, {
      flags: 32768,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `Could not list players  ${e} `
        }
      ]
    })
  }
}

function getTopAttributesByPosition(player: Player): Array<{ name: string, value: number }> {
  const attributes: Array<{ name: string, value: number }> = []
  attributes.push(
    { name: "Speed", value: player.speedRating },
    { name: "Accel", value: player.accelRating },
    { name: "Agility", value: player.agilityRating },
    { name: "Awareness", value: player.awareRating },
    { name: "Injury", value: player.injuryRating }
  )

  switch (player.position) {
    case "QB":
      attributes.push(
        { name: "Throw Power", value: player.throwPowerRating },
        { name: "Deep Acc", value: player.throwAccDeepRating },
        { name: "Medium Acc", value: player.throwAccMidRating },
        { name: "Short Acc", value: player.throwAccShortRating },
        { name: "Play Action", value: player.playActionRating },
        { name: "Throw Under Pressure", value: player.throwUnderPressureRating },
        { name: "Break Sack", value: player.breakSackRating },
      )
      break
    case "FB":
      attributes.push(
        { name: "Impact Blocking", value: player.impactBlockRating },
        { name: "Lead Block", value: player.leadBlockRating },
        { name: "Run Block", value: player.runBlockRating },
        { name: "Strength", value: player.strengthRating },
        { name: "Pass Block", value: player.passBlockRating },
        { name: "Truck", value: player.truckRating },
        { name: "Stiff Arm", value: player.stiffArmRating },
        { name: "Carrying", value: player.carryRating },
        { name: "Break Tackle", value: player.breakTackleRating },
      )
      break
    case "HB":
      attributes.push(
        { name: "Break Tackle", value: player.breakTackleRating },
        { name: "Carrying", value: player.carryRating },
        { name: "BC Vision", value: player.bCVRating },
        { name: "Truck", value: player.truckRating },
        { name: "Stiff Arm", value: player.stiffArmRating },
        { name: "Juke Move", value: player.jukeMoveRating },
        { name: "Spin Move", value: player.spinMoveRating },
        { name: "COD", value: player.changeOfDirectionRating },
        { name: "Strength", value: player.strengthRating }
      )
      break
    // catching, catch in traffic, short route, medium route, deep route, spec, release, jumping
    // secondary: BC vision, carryign, cod, trucking, break tackle, stiff arm, juke, spin, run, pass, impact, kick, injury, stamin, toughness
    case "WR":
      attributes.push(
        { name: "Catching", value: player.catchRating },
        { name: "Catch in Traffic", value: player.cITRating },
        { name: "Short Route", value: player.routeRunShortRating },
        { name: "Medium Route", value: player.routeRunMedRating },
        { name: "Deep Route", value: player.routeRunDeepRating },
        { name: "Spectacular Catch", value: player.specCatchRating },
        { name: "Release", value: player.releaseRating },
        { name: "Jumping", value: player.jumpRating },
      )
      break
    // speed, catching, run block, awarness, short, medium, deep, acc, cit, spec, impact, pass, lead, break
    // secondary: run power, run finess, pass power, pass finess, trucking, stif, carrying, cod, spin, juke, bc, injury, stamina, toughness
    case "TE":
      attributes.push(
        { name: "Catching", value: player.catchRating },
        { name: "Run Block", value: player.runBlockRating },
        { name: "Short Route", value: player.routeRunShortRating },
        { name: "Medium Route", value: player.routeRunMedRating },
        { name: "Deep Route", value: player.routeRunDeepRating },
        { name: "Catch in Traffic", value: player.cITRating },
        { name: "Spectacular Catch", value: player.specCatchRating },
        { name: "Impact Blocking", value: player.impactBlockRating },
        { name: "Pass Blocking", value: player.passBlockRating },
        { name: "Lead Blocking", value: player.leadBlockRating },
        { name: "Break Tackle", value: player.breakTackleRating },
      )
      break
    case "LT":
    case "LG":
    case "C":
    case "RG":
    case "RT":
      attributes.push(
        { name: "Strength", value: player.strengthRating },
        { name: "Run Block", value: player.runBlockRating },
        { name: "Pass Block", value: player.passBlockRating },
        { name: "Run Block Power", value: player.runBlockPowerRating },
        { name: "Run Block Finesse", value: player.runBlockFinesseRating },
        { name: "Pass Block Power", value: player.passBlockPowerRating },
        { name: "Pass Block Finesse", value: player.passBlockFinesseRating },
        { name: "Lead Block", value: player.leadBlockRating },
        { name: "Impact Blocking", value: player.impactBlockRating },
        { name: "Long Snap", value: player.longSnapRating }
      )
      break
    case "LEDGE":
    case "REDGE":
      attributes.push(
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Block Shedding", value: player.blockShedRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Strength", value: player.strengthRating },
      )
      break
    case "DT":
      attributes.push(
        { name: "Strength", value: player.strengthRating },
        { name: "Block Shedding", value: player.blockShedRating },
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Play Rec", value: player.playRecRating },
      )
      break
    case "SAM":
    case "WILL":
      attributes.push(
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Block Shedding", value: player.blockShedRating },
        { name: "Play Rec", value: player.playRecRating },
      )
      break
    case "MIKE":
      attributes.push(
        { name: "Tackle", value: player.tackleRating },
        { name: "Block Shedding", value: player.blockShedRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Strength", value: player.strengthRating },
        { name: "Zone Coverage", value: player.zoneCoverRating },
      )
      break
    case "CB":
      attributes.push(
        { name: "Man Coverage", value: player.manCoverRating },
        { name: "Zone Coverage", value: player.zoneCoverRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Press", value: player.pressRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Jumping", value: player.jumpRating },
        { name: "Catching", value: player.catchRating },
      )
      break
    case "FS":
    case "SS":
      attributes.push(
        { name: "Man Coverage", value: player.manCoverRating },
        { name: "Zone Coverage", value: player.zoneCoverRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Block Shedding", value: player.blockShedRating },
      )
      break
    case "K":
    case "P":
      attributes.push(
        { name: "Kick Power", value: player.kickPowerRating },
        { name: "Kick Accuracy", value: player.kickAccRating },
      )
      break
  }

  return attributes
}

function getPositionalTraits(player: Player) {
  const attributes: Array<{ name: string, value: string }> = []
  const yesNoAttributes: { name: string, value: YesNoTrait }[] = []

  switch (player.position) {
    case "QB":
      attributes.push(
        { name: "QB Style", value: formatQbStyle(player.qBStyleTrait) },
        { name: "Sense Pressure", value: formatSensePressure(player.sensePressureTrait) },
      )
      yesNoAttributes.push({ name: "Throw Away", value: player.throwAwayTrait },
        { name: "Tight Spiral", value: player.tightSpiralTrait })
      break
    case "FB":
    case "HB":
    case "WR":
    case "TE":
      yesNoAttributes.push(
        { name: "YAC Catch", value: player.yACCatchTrait },
        { name: "Possesion Catch", value: player.posCatchTrait },
        { name: "Aggressive Catch", value: player.hPCatchTrait },
        { name: "Fight for Yards", value: player.fightForYardsTrait },
        { name: "Feet in Bounds", value: player.feetInBoundsTrait },
        { name: "Drop Open Passes", value: player.dropOpenPassTrait }
      )
      break
    case "LT":
    case "LG":
    case "C":
    case "RG":
    case "RT":
      break
    case "LE":
    case "RE":
    case "DT":
      yesNoAttributes.push(
        { name: "DL Swim Move", value: player.dLSwimTrait },
        { name: "DL Spin Move", value: player.dLSpinTrait },
        { name: "DL Bull Rush", value: player.dLBullRushTrait },
        { name: "Strip Ball", value: player.stripBallTrait },
        { name: "High Motor", value: player.highMotorTrait },
      )
      break
    case "LOLB":
    case "ROLB":
    case "MLB":
      attributes.push(
        { name: "LB Style", value: formatLbStyle(player.lBStyleTrait) },
        { name: "Play Ball", value: formatPlayBallTrait(player.playBallTrait) }
      )
      yesNoAttributes.push(
        { name: "DL Swim Move", value: player.dLSwimTrait },
        { name: "DL Spin Move", value: player.dLSpinTrait },
        { name: "DL Bull Rush", value: player.dLBullRushTrait },
        { name: "Strip Ball", value: player.stripBallTrait },
        { name: "High Motor", value: player.highMotorTrait },
        { name: "Big Hitter", value: player.bigHitTrait },
      )
      break
    case "CB":
    case "FS":
    case "SS":
      attributes.push(
        { name: "Play Ball", value: formatPlayBallTrait(player.playBallTrait) }
      )
      yesNoAttributes.push(
        { name: "Strip Ball", value: player.stripBallTrait },
        { name: "High Motor", value: player.highMotorTrait },
        { name: "Big Hitter", value: player.bigHitTrait },
      )
      break
    case "K":
    case "P":
      break
  }

  const yesNoTraits = yesNoAttributes.filter(trait => trait.value === YesNoTrait.YES)
    .map(attr => `> **${attr.name}:** ${formatYesNoTrait(attr.value)}`).join('\n')
  const customAttributes = attributes.map(attr => `> **${attr.name}:** ${attr.value}`).join('\n')
  return `${yesNoTraits} \n${customAttributes}`

}


function getDevTraitName(devTrait: DevTrait, yearsPro: number): string {
  // non normal dev rookies get hidden dev
  if (yearsPro === 0 && devTrait !== DevTrait.NORMAL) {
    return SnallabotDevEmojis.HIDDEN
  }
  switch (devTrait) {
    case DevTrait.NORMAL: return SnallabotDevEmojis.NORMAL
    case DevTrait.STAR: return SnallabotDevEmojis.STAR
    case DevTrait.SUPERSTAR: return SnallabotDevEmojis.SUPERSTAR
    case DevTrait.XFACTOR: return SnallabotDevEmojis.XFACTOR
    default: return "Unknown"
  }
}

enum SnallabotDevEmojis {
  NORMAL = "<:snallabot_normal_dev:1450281729825833104>",
  STAR = "<:snallabot_star_dev:1450281736020820222>",
  SUPERSTAR = "<:snallabot_superstar_dev:1450281741171425313>",
  XFACTOR = "<:snallabot_xfactor_dev:1450281747152371944>",
  HIDDEN = "<:snallabot_hidden_dev:1450281724855713882>"
}
const rules = new Intl.PluralRules("en-US", { type: "ordinal" })
const suffixes = new Map([
  ["one", "st"],
  ["two", "nd"],
  ["few", "rd"],
  ["other", "th"],
])

function getSeasonFormatting(yearsPro: number) {
  if (yearsPro === 0) {
    return "Rookie"
  }
  const rule = rules.select(yearsPro + 1)
  const suffix = suffixes.get(rule)
  return `${yearsPro + 1}${suffix} Season`
}

function formatMoney(m: number) {
  if (m >= 1000000) {
    return `$${(m / 1000000).toFixed(2)}M`
  } else if (m >= 1000) {
    return `$${(m / 1000).toFixed(0)}K`
  }
  return `$${m.toLocaleString()}`
}

function getTeamAbbr(teamId: number, teams: TeamList) {
  if (teamId === 0) {
    return "FA"
  }
  return teams.getTeamForId(teamId).abbrName
}

function formatAttributes(topAttributes: { name: string, value: number }[]): string {
  const lines: string[] = [];

  for (let i = 0; i < topAttributes.length; i += 2) {
    const attr1 = topAttributes[i];
    const attr2 = topAttributes[i + 1];

    if (attr2) {
      // Both attributes exist
      lines.push(`> **${attr1.name}:** ${attr1.value} | **${attr2.name}:** ${attr2.value}`);
    } else {
      // Only first attribute exists (odd number of attributes)
      lines.push(`> **${attr1.name}:** ${attr1.value}`);
    }
  }

  return lines.join('\n');
}

function formatPlayerCard(player: Player, teams: TeamList, logos: LeagueLogos) {

  const teamAbbr = getTeamAbbr(player.teamId, teams)
  const heightFeet = Math.floor(player.height / 12)
  const heightInches = player.height % 12
  const formattedHeight = `${heightFeet}'${heightInches}"`

  let age = player.age

  const contractStatus = player.isFreeAgent ? "Free Agent" :
    `> **Length**: ${player.contractYearsLeft}/${player.contractLength} yrs | **Salary**: $${formatMoney(player.contractSalary)}\n> **Cap Hit**: $${formatMoney(player.capHit)} | **Bonus**: $${formatMoney(player.contractBonus)}\n> **Savings**: $${formatMoney(player.capReleaseNetSavings)} | **Penalty**: $${formatMoney(player.capReleasePenalty)}`

  const topAttributes = getTopAttributesByPosition(player)

  const abilities = player.signatureSlotList && player.signatureSlotList.length > 0
    ? "\n**Abilities:** " + player.signatureSlotList
      .filter(ability => !ability.isEmpty && ability.signatureAbility)
      .map(ability => {
        return ability.signatureAbility?.signatureTitle || "Unnamed Ability"
      })
      .join(", ")
    : ""
  return `
  # ${getTeamEmoji(teamAbbr, logos)} ${player.position} ${player.firstName} ${player.lastName}
## ${getDevTraitName(player.devTrait, player.yearsPro)} **${player.playerBestOvr} OVR**
**${age} yrs** | **${getSeasonFormatting(player.yearsPro)}** | **${formattedHeight}, ${player.weight} lbs**
### Contract
${contractStatus}
### Ratings
${formatAttributes(topAttributes)}${getPositionalTraits(player)}${abilities}`
}

function formatYesNoTrait(trait: YesNoTrait) {
  switch (trait) {
    case YesNoTrait.YES: return "<:snallabot_yes:1368090206867030056>"
    case YesNoTrait.NO: return "<:snallabot_nope:1368090205525115030>"
    default: return "Unknown"
  }
}

function formatSensePressure(sensePressureTrait: SensePressureTrait) {
  switch (sensePressureTrait) {
    case SensePressureTrait.AVERAGE: return "Average"
    case SensePressureTrait.IDEAL: return "Ideal"
    case SensePressureTrait.OBLIVIOUS: return "Oblivious"
    case SensePressureTrait.PARANOID: return "Paranoid"
    case SensePressureTrait.TRIGGER_HAPPY: return "Trigger Happy"
    default: return "Unknown"
  }
}

function formatPlayBallTrait(playBallTrait: PlayBallTrait) {
  switch (playBallTrait) {
    case PlayBallTrait.AGGRESSIVE: return "Aggressive"
    case PlayBallTrait.BALANCED: return "Balanced"
    case PlayBallTrait.CONSERVATIVE: return "Conservative"
  }
}

function formatQbStyle(qbStyle: QBStyleTrait) {
  switch (qbStyle) {
    case QBStyleTrait.BALANCED: return "Balanced"
    case QBStyleTrait.POCKET: return "Pocket"
    case QBStyleTrait.SCRAMBLING: return "Scrambling"
  }
}

function formatLbStyle(lbStyle: LBStyleTrait) {
  switch (lbStyle) {
    case LBStyleTrait.BALANCED: return "Balanced"
    case LBStyleTrait.COVER_LB: return "Cover LB"
    case LBStyleTrait.PASS_RUSH: return "Pass Rush"
  }
}


function getAllRatingsByPosition(player: Player): { physical: Array<{ name: string, value: number }>, primary: Array<{ name: string, value: number }>, secondary: Array<{ name: string, value: number }> } {
  const physical = [
    { name: "Speed", value: player.speedRating },
    { name: "Accel", value: player.accelRating },
    { name: "Agility", value: player.agilityRating },
    { name: "Strength", value: player.strengthRating },
    { name: "Jump", value: player.jumpRating },
    { name: "Stamina", value: player.staminaRating },
    { name: "Injury", value: player.injuryRating },
    { name: "Toughness", value: player.toughRating },
    { name: "Awareness", value: player.awareRating }
  ]

  let primary: Array<{ name: string, value: number }> = []
  let secondary: Array<{ name: string, value: number }> = []

  switch (player.position) {
    case "QB":
      primary = [
        { name: "Throw Power", value: player.throwPowerRating },
        { name: "Throw Acc", value: player.throwAccRating },
        { name: "Deep Acc", value: player.throwAccDeepRating },
        { name: "Mid Acc", value: player.throwAccMidRating },
        { name: "Short Acc", value: player.throwAccShortRating },
        { name: "Throw on Run", value: player.throwOnRunRating },
        { name: "Play Action", value: player.playActionRating },
        { name: "Under Pressure", value: player.throwUnderPressureRating },
        { name: "Break Sack", value: player.breakSackRating }
      ]
      secondary = [
        { name: "Carrying", value: player.carryRating },
        { name: "BC Vision", value: player.bCVRating },
        { name: "Juke Move", value: player.jukeMoveRating },
        { name: "Spin Move", value: player.spinMoveRating }
      ]
      break
    case "HB":
      primary = [
        { name: "Carrying", value: player.carryRating },
        { name: "BC Vision", value: player.bCVRating },
        { name: "Break Tackle", value: player.breakTackleRating },
        { name: "Trucking", value: player.truckRating },
        { name: "Stiff Arm", value: player.stiffArmRating },
        { name: "Juke Move", value: player.jukeMoveRating },
        { name: "Spin Move", value: player.spinMoveRating },
        { name: "COD", value: player.changeOfDirectionRating }
      ]
      secondary = [
        { name: "Catching", value: player.catchRating },
        { name: "Short Route", value: player.routeRunShortRating },
        { name: "Pass Block", value: player.passBlockRating }
      ]
      break
    case "FB":
      primary = [
        { name: "Impact Block", value: player.impactBlockRating },
        { name: "Lead Block", value: player.leadBlockRating },
        { name: "Run Block", value: player.runBlockRating },
        { name: "Pass Block", value: player.passBlockRating },
        { name: "Carrying", value: player.carryRating },
        { name: "Trucking", value: player.truckRating },
        { name: "Break Tackle", value: player.breakTackleRating }
      ]
      secondary = [
        { name: "Catching", value: player.catchRating },
        { name: "Short Route", value: player.routeRunShortRating }
      ]
      break
    case "WR":
      primary = [
        { name: "Catching", value: player.catchRating },
        { name: "Catch in Traffic", value: player.cITRating },
        { name: "Spec Catch", value: player.specCatchRating },
        { name: "Short Route", value: player.routeRunShortRating },
        { name: "Med Route", value: player.routeRunMedRating },
        { name: "Deep Route", value: player.routeRunDeepRating },
        { name: "Release", value: player.releaseRating }
      ]
      secondary = [
        { name: "BC Vision", value: player.bCVRating },
        { name: "Juke Move", value: player.jukeMoveRating },
        { name: "Break Tackle", value: player.breakTackleRating },
        { name: "Run Block", value: player.runBlockRating }
      ]
      break
    case "TE":
      primary = [
        { name: "Catching", value: player.catchRating },
        { name: "Catch in Traffic", value: player.cITRating },
        { name: "Spec Catch", value: player.specCatchRating },
        { name: "Short Route", value: player.routeRunShortRating },
        { name: "Med Route", value: player.routeRunMedRating },
        { name: "Run Block", value: player.runBlockRating },
        { name: "Pass Block", value: player.passBlockRating },
        { name: "Impact Block", value: player.impactBlockRating }
      ]
      secondary = [
        { name: "Deep Route", value: player.routeRunDeepRating },
        { name: "Release", value: player.releaseRating },
        { name: "Break Tackle", value: player.breakTackleRating }
      ]
      break
    case "LT":
    case "LG":
    case "C":
    case "RG":
    case "RT":
      primary = [
        { name: "Run Block", value: player.runBlockRating },
        { name: "Pass Block", value: player.passBlockRating },
        { name: "RB Power", value: player.runBlockPowerRating },
        { name: "RB Finesse", value: player.runBlockFinesseRating },
        { name: "PB Power", value: player.passBlockPowerRating },
        { name: "PB Finesse", value: player.passBlockFinesseRating },
        { name: "Lead Block", value: player.leadBlockRating },
        { name: "Impact Block", value: player.impactBlockRating }
      ]
      if (player.position === "C") {
        primary.push({ name: "Long Snap", value: player.longSnapRating })
      }
      break
    case "LEDGE":
    case "REDGE":
      primary = [
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Block Shed", value: player.blockShedRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Play Rec", value: player.playRecRating }
      ]
      secondary = [
        { name: "Man Coverage", value: player.manCoverRating },
        { name: "Zone Coverage", value: player.zoneCoverRating }
      ]
      break
    case "DT":
      primary = [
        { name: "Block Shed", value: player.blockShedRating },
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Play Rec", value: player.playRecRating }
      ]
      break
    case "SAM":
    case "WILL":
    case "MIKE":
      primary = [
        { name: "Tackle", value: player.tackleRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Block Shed", value: player.blockShedRating },
        { name: "Power Moves", value: player.powerMovesRating },
        { name: "Finesse Moves", value: player.finesseMovesRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Zone Coverage", value: player.zoneCoverRating },
        { name: "Man Coverage", value: player.manCoverRating }
      ]
      secondary = [
        { name: "Press", value: player.pressRating },
        { name: "Catching", value: player.catchRating }
      ]
      break
    case "CB":
      primary = [
        { name: "Man Coverage", value: player.manCoverRating },
        { name: "Zone Coverage", value: player.zoneCoverRating },
        { name: "Press", value: player.pressRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Catching", value: player.catchRating }
      ]
      secondary = [
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating }
      ]
      break
    case "FS":
    case "SS":
      primary = [
        { name: "Zone Coverage", value: player.zoneCoverRating },
        { name: "Man Coverage", value: player.manCoverRating },
        { name: "Play Rec", value: player.playRecRating },
        { name: "Tackle", value: player.tackleRating },
        { name: "Hit Power", value: player.hitPowerRating },
        { name: "Pursuit", value: player.pursuitRating },
        { name: "Press", value: player.pressRating },
        { name: "Catching", value: player.catchRating }
      ]
      secondary = [
        { name: "Block Shed", value: player.blockShedRating }
      ]
      break
    case "K":
    case "P":
      primary = [
        { name: "Kick Power", value: player.kickPowerRating },
        { name: "Kick Accuracy", value: player.kickAccRating }
      ]
      break
  }

  return { physical, primary, secondary }
}

function getAllPositionalTraits(player: Player): { styles: Array<{ name: string, value: string }>, traits: Array<{ name: string, value: string }> } {
  const styles: Array<{ name: string, value: string }> = []
  const traits: Array<{ name: string, value: string }> = []

  // Add general traits if YES
  if (player.clutchTrait === YesNoTrait.YES) traits.push({ name: "Clutch", value: formatYesNoTrait(player.clutchTrait) })
  if (player.predictTrait === YesNoTrait.YES) traits.push({ name: "Predictable", value: formatYesNoTrait(player.predictTrait) })

  switch (player.position) {
    case "QB":
      styles.push({ name: "QB Style", value: formatQbStyle(player.qBStyleTrait) })
      if (player.sensePressureTrait !== SensePressureTrait.AVERAGE) {
        styles.push({ name: "Sense Pressure", value: formatSensePressure(player.sensePressureTrait) })
      }
      if (player.throwAwayTrait === YesNoTrait.YES) traits.push({ name: "Throw Away", value: formatYesNoTrait(player.throwAwayTrait) })
      if (player.tightSpiralTrait === YesNoTrait.YES) traits.push({ name: "Tight Spiral", value: formatYesNoTrait(player.tightSpiralTrait) })
      break
    case "FB":
    case "HB":
    case "WR":
    case "TE":
      if (player.fightForYardsTrait === YesNoTrait.YES) traits.push({ name: "Fight for Yards", value: formatYesNoTrait(player.fightForYardsTrait) })
      if (player.yACCatchTrait === YesNoTrait.YES) traits.push({ name: "YAC Catch", value: formatYesNoTrait(player.yACCatchTrait) })
      if (player.posCatchTrait === YesNoTrait.YES) traits.push({ name: "Possession Catch", value: formatYesNoTrait(player.posCatchTrait) })
      if (player.hPCatchTrait === YesNoTrait.YES) traits.push({ name: "Aggressive Catch", value: formatYesNoTrait(player.hPCatchTrait) })
      if (player.feetInBoundsTrait === YesNoTrait.YES) traits.push({ name: "Feet In Bounds", value: formatYesNoTrait(player.feetInBoundsTrait) })
      if (player.dropOpenPassTrait === YesNoTrait.YES) traits.push({ name: "Drops Passes", value: formatYesNoTrait(player.dropOpenPassTrait) })
      break
    case "LEDGE":
    case "REDGE":
    case "DT":
      if (player.dLSwimTrait === YesNoTrait.YES) traits.push({ name: "DL Swim", value: formatYesNoTrait(player.dLSwimTrait) })
      if (player.dLSpinTrait === YesNoTrait.YES) traits.push({ name: "DL Spin", value: formatYesNoTrait(player.dLSpinTrait) })
      if (player.dLBullRushTrait === YesNoTrait.YES) traits.push({ name: "DL Bull Rush", value: formatYesNoTrait(player.dLBullRushTrait) })
      if (player.highMotorTrait === YesNoTrait.YES) traits.push({ name: "High Motor", value: formatYesNoTrait(player.highMotorTrait) })
      if (player.stripBallTrait === YesNoTrait.YES) traits.push({ name: "Strip Ball", value: formatYesNoTrait(player.stripBallTrait) })
      break
    case "SAM":
    case "WILL":
    case "MIKE":
      styles.push({ name: "LB Style", value: formatLbStyle(player.lBStyleTrait) })
      styles.push({ name: "Play Ball", value: formatPlayBallTrait(player.playBallTrait) })
      if (player.dLSwimTrait === YesNoTrait.YES) traits.push({ name: "DL Swim", value: formatYesNoTrait(player.dLSwimTrait) })
      if (player.dLSpinTrait === YesNoTrait.YES) traits.push({ name: "DL Spin", value: formatYesNoTrait(player.dLSpinTrait) })
      if (player.dLBullRushTrait === YesNoTrait.YES) traits.push({ name: "DL Bull Rush", value: formatYesNoTrait(player.dLBullRushTrait) })
      if (player.highMotorTrait === YesNoTrait.YES) traits.push({ name: "High Motor", value: formatYesNoTrait(player.highMotorTrait) })
      if (player.bigHitTrait === YesNoTrait.YES) traits.push({ name: "Big Hitter", value: formatYesNoTrait(player.bigHitTrait) })
      if (player.stripBallTrait === YesNoTrait.YES) traits.push({ name: "Strip Ball", value: formatYesNoTrait(player.stripBallTrait) })
      break
    case "CB":
    case "FS":
    case "SS":
      styles.push({ name: "Play Ball", value: formatPlayBallTrait(player.playBallTrait) })
      if (player.highMotorTrait === YesNoTrait.YES) traits.push({ name: "High Motor", value: formatYesNoTrait(player.highMotorTrait) })
      if (player.bigHitTrait === YesNoTrait.YES) traits.push({ name: "Big Hitter", value: formatYesNoTrait(player.bigHitTrait) })
      if (player.stripBallTrait === YesNoTrait.YES) traits.push({ name: "Strip Ball", value: formatYesNoTrait(player.stripBallTrait) })
      break
  }

  return { styles, traits }
}

function formatRatingSection(title: string, attrs: Array<{ name: string, value: number }>): string {
  if (attrs.length === 0) return ""
  const lines: string[] = [`### ${title}`]
  for (let i = 0; i < attrs.length; i += 3) {
    const row = attrs.slice(i, i + 3).map(a => `**${a.name}:** ${a.value}`).join(" | ")
    lines.push(`> ${row}`)
  }
  return lines.join("\n")
}

function formatFullRatings(player: Player, teams: TeamList, logos: LeagueLogos) {
  const teamAbbr = getTeamAbbr(player.teamId, teams)
  const { physical, primary, secondary } = getAllRatingsByPosition(player)
  const { styles, traits } = getAllPositionalTraits(player)

  const physicalSection = formatRatingSection("Physical", physical)
  const primarySection = formatRatingSection("Primary Skills", primary)
  const secondarySection = secondary.length > 0 ? formatRatingSection("Secondary", secondary) : ""

  let stylesSection = ""
  if (styles.length > 0) {
    stylesSection = "\n### Styles\n" + styles.map(s => `> **${s.name}:** ${s.value}`).join(" | ")
  }

  let traitsSection = ""
  if (traits.length > 0) {
    traitsSection = "\n### Traits\n" + traits.map(t => `> ${t.name} ${t.value}`).join(" ")
  }

  const abilities = player.signatureSlotList && player.signatureSlotList.length > 0
    ? "\n### Abilities\n> " + player.signatureSlotList
      .filter(ability => !ability.isEmpty && ability.signatureAbility)
      .map(ability => ability.signatureAbility?.signatureTitle || "Unnamed")
      .join(", ")
    : ""

  return `# ${getTeamEmoji(teamAbbr, logos)} ${player.position} ${player.firstName} ${player.lastName}
## ${getDevTraitName(player.devTrait, player.yearsPro)} **${player.playerBestOvr} OVR**
${physicalSection}
${primarySection}
${secondarySection}${stylesSection}${traitsSection}${abilities}`
}

function formatContract(player: Player, teams: TeamList, logos: LeagueLogos) {
  const teamAbbr = getTeamAbbr(player.teamId, teams)
  const team = player.teamId !== 0 ? teams.getTeamForId(player.teamId) : null

  const isFreeAgent = player.isFreeAgent || player.teamId === 0

  let contractDetails = ""

  if (isFreeAgent) {
    contractDetails = `## 🏷️ Free Agent

### Asking Price
> **Desired Salary:** ${formatMoney(player.desiredSalary)}/yr
> **Desired Bonus:** ${formatMoney(player.desiredBonus)}
> **Desired Length:** ${player.desiredLength} years`
  } else {
    const totalValue = (player.contractSalary * player.contractLength) + player.contractBonus

    contractDetails = `## 📋 Current Contract

### Contract Value
> **Total Value:** ${formatMoney(totalValue)}
> **Length:** ${player.contractLength} years (${player.contractYearsLeft} remaining)

### Annual Breakdown
> **Base Salary:** ${formatMoney(player.contractSalary)}/yr
> **Signing Bonus:** ${formatMoney(player.contractBonus)}
> **Cap Hit:** ${formatMoney(player.capHit)}

### Release Info
> **Dead Cap:** ${formatMoney(player.capReleasePenalty)}
> **Cap Savings:** ${formatMoney(player.capReleaseNetSavings)}`
  }

  return `# ${getTeamEmoji(teamAbbr, logos)} ${player.position} ${player.firstName} ${player.lastName}
**${player.playerBestOvr} OVR** | Age ${player.age} | ${player.yearsPro} yrs pro
${contractDetails}`
}

type GameStatLine = { scheduleId: string, type: string, line: string }

function formatStatsGrouped(stats: PlayerStats): GameStatLine[] {
  const formattedStats: GameStatLine[] = []

  if (stats[PlayerStatType.PASSING]) {
    stats[PlayerStatType.PASSING].forEach(ps => {
      const pct = ps.passAtt > 0 ? ((ps.passComp / ps.passAtt) * 100).toFixed(0) : "0"
      let line = `**${ps.passComp}/${ps.passAtt}** (${pct}%) | **${ps.passYds}** yds`
      if (ps.passTDs > 0) line += ` | **${ps.passTDs}** TD`
      if (ps.passInts > 0) line += ` | ${ps.passInts} INT`
      line += ` | ${ps.passerRating.toFixed(1)} rtg`
      formattedStats.push({ scheduleId: formatGameKey(ps), type: "pass", line })
    })
  }

  if (stats[PlayerStatType.RUSHING]) {
    stats[PlayerStatType.RUSHING].forEach(rs => {
      if (rs.rushAtt > 0) {
        let line = `**${rs.rushAtt}** att | **${rs.rushYds}** yds`
        if (rs.rushTDs > 0) line += ` | **${rs.rushTDs}** TD`
        if (rs.rushFum > 0) line += ` | ${rs.rushFum} fum`
        line += ` | ${rs.rushYdsPerAtt.toFixed(1)} avg`
        formattedStats.push({ scheduleId: formatGameKey(rs), type: "rush", line })
      }
    })
  }

  if (stats[PlayerStatType.RECEIVING]) {
    stats[PlayerStatType.RECEIVING].forEach(rs => {
      let line = `**${rs.recCatches}** rec | **${rs.recYds}** yds`
      if (rs.recTDs > 0) line += ` | **${rs.recTDs}** TD`
      if (rs.recYdsPerCatch > 0) line += ` | ${rs.recYdsPerCatch.toFixed(1)} avg`
      formattedStats.push({ scheduleId: formatGameKey(rs), type: "rec", line })
    })
  }

  if (stats[PlayerStatType.DEFENSE]) {
    stats[PlayerStatType.DEFENSE].forEach(ds => {
      const parts = [`**${ds.defTotalTackles}** tkl`]
      if (ds.defSacks > 0) parts.push(`**${ds.defSacks}** sck`)
      if (ds.defInts > 0) parts.push(`**${ds.defInts}** INT`)
      if (ds.defForcedFum > 0) parts.push(`${ds.defForcedFum} FF`)
      if (ds.defFumRec > 0) parts.push(`${ds.defFumRec} FR`)
      if (ds.defTDs > 0) parts.push(`**${ds.defTDs}** TD`)
      if (ds.defDeflections > 0) parts.push(`${ds.defDeflections} PD`)
      formattedStats.push({ scheduleId: formatGameKey(ds), type: "def", line: parts.join(" | ") })
    })
  }

  if (stats[PlayerStatType.KICKING]) {
    stats[PlayerStatType.KICKING].forEach(ks => {
      const fgPct = ks.fGAtt > 0 ? ((ks.fGMade / ks.fGAtt) * 100).toFixed(0) : "0"
      let line = `**${ks.fGMade}/${ks.fGAtt}** FG (${fgPct}%) | **${ks.xPMade}/${ks.xPAtt}** XP`
      if (ks.fGLongest > 0) line += ` | ${ks.fGLongest} lng`
      line += ` | **${ks.kickPts}** pts`
      formattedStats.push({ scheduleId: formatGameKey(ks), type: "kick", line })
    })
  }

  if (stats[PlayerStatType.PUNTING]) {
    stats[PlayerStatType.PUNTING].forEach(ps => {
      let line = `**${ps.puntAtt}** punts | **${ps.puntYds}** yds | ${ps.puntYdsPerAtt.toFixed(1)} avg`
      if (ps.puntsIn20 > 0) line += ` | ${ps.puntsIn20} in20`
      if (ps.puntTBs > 0) line += ` | ${ps.puntTBs} TB`
      formattedStats.push({ scheduleId: formatGameKey(ps), type: "punt", line })
    })
  }

  return formattedStats
}

function formatScore(game: MaddenGame) {
  if (game.awayScore === game.homeScore) {
    return `${game.awayScore} - ${game.homeScore}`
  }
  if (game.awayScore > game.homeScore) {
    return `**${game.awayScore}** - ${game.homeScore}`
  }
  if (game.awayScore < game.homeScore) {
    return `${game.awayScore} - **${game.homeScore}**`
  }
}

enum SnallabotGameResult {
  WIN = "<:snallabot_win:1368708001548079304>",
  LOSS = "<:snallabot_loss:1368726069963653171>",
  TIE = "<:snallabot_tie:1368713402016337950>"
}

function formatGameEmoji(game: MaddenGame, playerTeam: number, teams: TeamList) {
  if (game.awayScore === game.homeScore) {
    return SnallabotGameResult.TIE
  }
  if (game.awayScore > game.homeScore) {
    return teams.getTeamForId(game.awayTeamId).teamId === playerTeam ? SnallabotGameResult.WIN : SnallabotGameResult.LOSS
  }
  if (game.awayScore < game.homeScore) {
    return teams.getTeamForId(game.homeTeamId).teamId === playerTeam ? SnallabotGameResult.WIN : SnallabotGameResult.LOSS
  }
}

function formatWeek(game: MaddenGame) {
  if (game.weekIndex < 18) {
    return `Wk ${game.weekIndex + 1}`
  } if (game.weekIndex === 18) {
    return `Wildcard`
  } if (game.weekIndex === 19) {
    return `Divisional`
  } if (game.weekIndex === 20) {
    return `Conference`
  } if (game.weekIndex === 22) {
    return `Superbowl`
  }
}

function formatGameKey(g: { scheduleId: number, weekIndex: number, seasonIndex: number }) {
  return `${g.scheduleId}|${g.weekIndex}|${g.seasonIndex}`
}

const STAT_TYPE_ICONS: Record<string, string> = {
  pass: "🎯",
  rush: "🏃🏿",
  rec: "🙌🏿",
  def: "🛡️",
  kick: "🦶🏿",
  punt: "📍"
}

function formatGameHeader(game: MaddenGame, player: Player, teams: TeamList, logos: LeagueLogos) {
  const playerTeam = teams.getTeamForId(player.teamId)?.teamId || 0
  const homeTeam = teams.getTeamForId(game.homeTeamId)?.teamId || 0
  const awayTeam = teams.getTeamForId(game.awayTeamId)?.teamId || 0
  const opponentTeamId = playerTeam === awayTeam ? homeTeam : awayTeam
  const opponentAbbr = getTeamAbbr(opponentTeamId, teams)
  const opponentEmoji = getTeamEmoji(opponentAbbr, logos)
  const isHome = playerTeam === homeTeam
  const location = isHome ? "vs" : "@"

  return `**${formatWeek(game)}** ${location} ${opponentEmoji} ${formatGameEmoji(game, playerTeam, teams)} ${formatScore(game)}`
}

function formatWeeklyStats(player: Player, teams: TeamList, stats: PlayerStats, games: MaddenGame[], logos: LeagueLogos) {
  const currentSeason = Math.max(...games.map(g => g.seasonIndex))
  const currentGameIds = new Set(games.filter(g => g.seasonIndex === currentSeason && g.stageIndex > 0).map(g => formatGameKey(g)))
  const gameResults = Object.groupBy(games.filter(g => currentGameIds.has(formatGameKey(g))), g => formatGameKey(g))
  const gameStats = formatStatsGrouped(stats)

  // Group stats by game
  const statsByGame = Object.groupBy(gameStats.filter(s => currentGameIds.has(s.scheduleId)), g => g.scheduleId)

  const weekStats = Object.entries(statsByGame).map(([gameKey, gameStatLines]) => {
    const result = gameResults[gameKey]
    if (!result) return { weekIndex: -1, value: "" }

    const game = result[0]
    const header = formatGameHeader(game, player, teams, logos)

    // Format each stat type on its own line with icon
    const statLines = gameStatLines?.map(s => `> ${STAT_TYPE_ICONS[s.type] || "📊"} ${s.line}`) || []

    return {
      weekIndex: game.weekIndex,
      value: `${header}\n${statLines.join("\n")}`
    }
  }).filter(g => g.value).sort((a, b) => a.weekIndex - b.weekIndex).map(g => g.value)

  const teamAbbr = getTeamAbbr(player.teamId, teams)

  // Calculate record
  const wins = games.filter(g => currentGameIds.has(formatGameKey(g))).filter(g => {
    const playerTeam = teams.getTeamForId(player.teamId)?.teamId || 0
    if (g.awayScore > g.homeScore) return teams.getTeamForId(g.awayTeamId)?.teamId === playerTeam
    if (g.homeScore > g.awayScore) return teams.getTeamForId(g.homeTeamId)?.teamId === playerTeam
    return false
  }).length
  const losses = games.filter(g => currentGameIds.has(formatGameKey(g))).filter(g => {
    const playerTeam = teams.getTeamForId(player.teamId)?.teamId || 0
    if (g.awayScore > g.homeScore) return teams.getTeamForId(g.homeTeamId)?.teamId === playerTeam
    if (g.homeScore > g.awayScore) return teams.getTeamForId(g.awayTeamId)?.teamId === playerTeam
    return false
  }).length

  return `# ${getTeamEmoji(teamAbbr, logos)} ${player.position} ${player.firstName} ${player.lastName}
## ${getDevTraitName(player.devTrait, player.yearsPro)} **${player.playerBestOvr} OVR** | ${wins}-${losses}
${weekStats.join("\n\n")}`
}
export type StatItem = {
  value: number;
  name: string;
}
export type RatioItem = {
  top: number,
  bottom: number,
}

export type SeasonAggregation = {
  [seasonIndex: number]: {
    // Passing stats
    passYds?: StatItem,
    passTDs?: StatItem,
    passInts?: StatItem,
    passPercent?: RatioItem,
    passSacks?: StatItem,

    // Rushing stats
    rushYds?: StatItem,
    rushTDs?: StatItem,
    rushAtt?: StatItem,
    rushFum?: StatItem,

    // Receiving stats
    recYds?: StatItem,
    recTDs?: StatItem,
    recCatches?: StatItem,
    recDrops?: StatItem,

    // Defensive stats
    defTotalTackles?: StatItem,
    defSacks?: StatItem,
    defInts?: StatItem,
    defFumRec?: StatItem,
    defForcedFum?: StatItem,
    defTDs?: StatItem,

    // Kicking stats
    fGMade?: StatItem,
    fGAtt?: StatItem,
    xPMade?: StatItem,
    xPAtt?: StatItem,
    kickPts?: StatItem,

    // Punting stats
    puntYds?: StatItem,
    puntAtt?: StatItem,
    puntsIn20?: StatItem,
    puntNetYds?: StatItem,
    puntsBlocked?: StatItem,
    puntTBs?: StatItem,
  }
}

function formatSeasonAggregation(agg: SeasonAggregation): string {
  const seasonIndices = Object.keys(agg).map(Number).sort((a, b) => b - a) // Most recent first
  const seasons: string[] = []

  for (const seasonIndex of seasonIndices) {
    const s = agg[seasonIndex]
    const lines: string[] = []

    // Passing stats
    if (s.passPercent && s.passYds) {
      const pct = s.passPercent.bottom > 0 ? ((s.passPercent.top / s.passPercent.bottom) * 100).toFixed(1) : "0"
      let line = `> 🎯 **${s.passPercent.top}/${s.passPercent.bottom}** (${pct}%) | **${s.passYds.value.toLocaleString()}** yds`
      if (s.passTDs) line += ` | **${s.passTDs.value}** TD`
      if (s.passInts && s.passInts.value > 0) line += ` | ${s.passInts.value} INT`
      if (s.passSacks && s.passSacks.value > 0) line += ` | ${s.passSacks.value} sck`
      lines.push(line)
    }

    // Rushing stats
    if (s.rushAtt && s.rushYds) {
      const avg = s.rushAtt.value > 0 ? (s.rushYds.value / s.rushAtt.value).toFixed(1) : "0"
      let line = `> 🏃🏿 **${s.rushAtt.value}** att | **${s.rushYds.value.toLocaleString()}** yds`
      if (s.rushTDs && s.rushTDs.value > 0) line += ` | **${s.rushTDs.value}** TD`
      if (s.rushFum && s.rushFum.value > 0) line += ` | ${s.rushFum.value} fum`
      line += ` | ${avg} avg`
      lines.push(line)
    }

    // Receiving stats
    if (s.recCatches && s.recYds) {
      const avg = s.recCatches.value > 0 ? (s.recYds.value / s.recCatches.value).toFixed(1) : "0"
      let line = `> 🙌🏿 **${s.recCatches.value}** rec | **${s.recYds.value.toLocaleString()}** yds`
      if (s.recTDs && s.recTDs.value > 0) line += ` | **${s.recTDs.value}** TD`
      line += ` | ${avg} avg`
      lines.push(line)
    }

    // Defensive stats
    if (s.defTotalTackles && s.defTotalTackles.value > 0) {
      const parts = [`**${s.defTotalTackles.value}** tkl`]
      if (s.defSacks && s.defSacks.value > 0) parts.push(`**${s.defSacks.value}** sck`)
      if (s.defInts && s.defInts.value > 0) parts.push(`**${s.defInts.value}** INT`)
      if (s.defForcedFum && s.defForcedFum.value > 0) parts.push(`${s.defForcedFum.value} FF`)
      if (s.defFumRec && s.defFumRec.value > 0) parts.push(`${s.defFumRec.value} FR`)
      if (s.defTDs && s.defTDs.value > 0) parts.push(`**${s.defTDs.value}** TD`)
      lines.push(`> 🛡️ ${parts.join(" | ")}`)
    }

    // Kicking stats
    if (s.fGMade && s.fGAtt) {
      const fgPct = s.fGAtt.value > 0 ? ((s.fGMade.value / s.fGAtt.value) * 100).toFixed(0) : "0"
      let line = `> 🦶🏿 **${s.fGMade.value}/${s.fGAtt.value}** FG (${fgPct}%)`
      if (s.xPMade && s.xPAtt) line += ` | **${s.xPMade.value}/${s.xPAtt.value}** XP`
      if (s.kickPts) line += ` | **${s.kickPts.value}** pts`
      lines.push(line)
    }

    // Punting stats
    if (s.puntAtt && s.puntYds) {
      const avg = s.puntAtt.value > 0 ? (s.puntYds.value / s.puntAtt.value).toFixed(1) : "0"
      let line = `> 📍 **${s.puntAtt.value}** punts | **${s.puntYds.value}** yds | ${avg} avg`
      if (s.puntsIn20 && s.puntsIn20.value > 0) line += ` | ${s.puntsIn20.value} in20`
      lines.push(line)
    }

    if (lines.length > 0) {
      seasons.push(`### ${seasonIndex + MADDEN_SEASON} Season\n${lines.join("\n")}`)
    }
  }

  return seasons.join("\n\n")
}


function aggregateSeason(stats: PlayerStats): SeasonAggregation {
  const seasonAggregation: SeasonAggregation = {};

  // Process passing stats
  if (stats[PlayerStatType.PASSING]) {
    for (const passStat of stats[PlayerStatType.PASSING]) {
      if (!seasonAggregation[passStat.seasonIndex]) {
        seasonAggregation[passStat.seasonIndex] = {}
      }

      const season = seasonAggregation[passStat.seasonIndex];

      // Initialize or add to existing values
      if (!season.passYds) {
        season.passYds = { value: passStat.passYds, name: 'PASS YDS' };
      } else {
        season.passYds.value += passStat.passYds;
      }

      if (!season.passTDs) {
        season.passTDs = { value: passStat.passTDs, name: 'TD' };
      } else {
        season.passTDs.value += passStat.passTDs;
      }

      if (!season.passInts) {
        season.passInts = { value: passStat.passInts, name: 'INT' };
      } else {
        season.passInts.value += passStat.passInts;
      }


      if (!season.passPercent) {
        season.passPercent = { top: passStat.passComp, bottom: passStat.passAtt }
      } else {
        season.passPercent.top += passStat.passComp
        season.passPercent.bottom += passStat.passAtt
      }

      if (!season.passSacks) {
        season.passSacks = { value: passStat.passSacks, name: 'SCKS' };
      } else {
        season.passSacks.value += passStat.passSacks;
      }
    }
  }

  // Process rushing stats
  if (stats[PlayerStatType.RUSHING]) {
    for (const rushStat of stats[PlayerStatType.RUSHING]) {
      if (!seasonAggregation[rushStat.seasonIndex]) {
        seasonAggregation[rushStat.seasonIndex] = {
        }
      }

      const season = seasonAggregation[rushStat.seasonIndex];

      if (!season.rushYds) {
        season.rushYds = { value: rushStat.rushYds, name: 'RUSH YDS' };
      } else {
        season.rushYds.value += rushStat.rushYds;
      }

      if (!season.rushTDs) {
        season.rushTDs = { value: rushStat.rushTDs, name: 'TD' };
      } else {
        season.rushTDs.value += rushStat.rushTDs;
      }

      if (!season.rushAtt) {
        season.rushAtt = { value: rushStat.rushAtt, name: 'ATT' };
      } else {
        season.rushAtt.value += rushStat.rushAtt;
      }

      if (!season.rushFum) {
        season.rushFum = { value: rushStat.rushFum, name: 'FUM' };
      } else {
        season.rushFum.value += rushStat.rushFum;
      }
    }
  }

  // Process receiving stats
  if (stats[PlayerStatType.RECEIVING]) {
    for (const recStat of stats[PlayerStatType.RECEIVING]) {
      if (!seasonAggregation[recStat.seasonIndex]) {
        seasonAggregation[recStat.seasonIndex] = {}
      }

      const season = seasonAggregation[recStat.seasonIndex];

      if (!season.recYds) {
        season.recYds = { value: recStat.recYds, name: 'REC YDS' };
      } else {
        season.recYds.value += recStat.recYds;
      }

      if (!season.recTDs) {
        season.recTDs = { value: recStat.recTDs, name: 'TD' };
      } else {
        season.recTDs.value += recStat.recTDs;
      }

      if (!season.recCatches) {
        season.recCatches = { value: recStat.recCatches, name: 'REC' };
      } else {
        season.recCatches.value += recStat.recCatches;
      }

      if (!season.recDrops) {
        season.recDrops = { value: recStat.recDrops, name: 'DROPS' };
      } else {
        season.recDrops.value += recStat.recDrops;
      }
    }
  }

  // Process defensive stats
  if (stats[PlayerStatType.DEFENSE]) {
    for (const defStat of stats[PlayerStatType.DEFENSE]) {
      if (!seasonAggregation[defStat.seasonIndex]) {
        seasonAggregation[defStat.seasonIndex] = {
        };
      }

      const season = seasonAggregation[defStat.seasonIndex];

      if (!season.defTotalTackles) {
        season.defTotalTackles = { value: defStat.defTotalTackles, name: 'TCKLS' };
      } else {
        season.defTotalTackles.value += defStat.defTotalTackles;
      }

      if (!season.defSacks) {
        season.defSacks = { value: defStat.defSacks, name: 'SCKS' };
      } else {
        season.defSacks.value += defStat.defSacks;
      }

      if (!season.defInts) {
        season.defInts = { value: defStat.defInts, name: 'INT' };
      } else {
        season.defInts.value += defStat.defInts;
      }

      if (!season.defFumRec) {
        season.defFumRec = { value: defStat.defFumRec, name: 'FR' };
      } else {
        season.defFumRec.value += defStat.defFumRec;
      }

      if (!season.defForcedFum) {
        season.defForcedFum = { value: defStat.defForcedFum, name: 'FF' };
      } else {
        season.defForcedFum.value += defStat.defForcedFum;
      }

      if (!season.defTDs) {
        season.defTDs = { value: defStat.defTDs, name: 'TD' };
      } else {
        season.defTDs.value += defStat.defTDs;
      }
    }
  }

  // Process kicking stats
  if (stats[PlayerStatType.KICKING]) {
    for (const kickStat of stats[PlayerStatType.KICKING]) {
      if (!seasonAggregation[kickStat.seasonIndex]) {
        seasonAggregation[kickStat.seasonIndex] = {}
      }

      const season = seasonAggregation[kickStat.seasonIndex];

      if (!season.fGMade) {
        season.fGMade = { value: kickStat.fGMade, name: 'FGS' };
      } else {
        season.fGMade.value += kickStat.fGMade;
      }

      if (!season.fGAtt) {
        season.fGAtt = { value: kickStat.fGAtt, name: 'FG ATT' };
      } else {
        season.fGAtt.value += kickStat.fGAtt;
      }

      if (!season.xPMade) {
        season.xPMade = { value: kickStat.xPMade, name: 'XP' };
      } else {
        season.xPMade.value += kickStat.xPMade;
      }

      if (!season.xPAtt) {
        season.xPAtt = { value: kickStat.xPAtt, name: 'XP ATT' };
      } else {
        season.xPAtt.value += kickStat.xPAtt;
      }

      if (!season.kickPts) {
        season.kickPts = { value: kickStat.kickPts, name: 'PTS' };
      } else {
        season.kickPts.value += kickStat.kickPts;
      }
    }
  }

  // Process punting stats
  if (stats[PlayerStatType.PUNTING]) {
    for (const puntStat of stats[PlayerStatType.PUNTING]) {
      if (!seasonAggregation[puntStat.seasonIndex]) {
        seasonAggregation[puntStat.seasonIndex] = {}
      }

      const season = seasonAggregation[puntStat.seasonIndex];

      if (!season.puntYds) {
        season.puntYds = { value: puntStat.puntYds, name: 'PUNT YDS' };
      } else {
        season.puntYds.value += puntStat.puntYds;
      }

      if (!season.puntAtt) {
        season.puntAtt = { value: puntStat.puntAtt, name: 'ATT' };
      } else {
        season.puntAtt.value += puntStat.puntAtt;
      }

      if (!season.puntsIn20) {
        season.puntsIn20 = { value: puntStat.puntsIn20, name: 'INS 20' };
      } else {
        season.puntsIn20.value += puntStat.puntsIn20;
      }

      if (!season.puntNetYds) {
        season.puntNetYds = { value: puntStat.puntNetYds, name: 'PUNT YDS NET' };
      } else {
        season.puntNetYds.value += puntStat.puntNetYds;
      }

      if (!season.puntsBlocked) {
        season.puntsBlocked = { value: puntStat.puntsBlocked, name: 'BLOCK' };
      } else {
        season.puntsBlocked.value += puntStat.puntsBlocked;
      }

      if (!season.puntTBs) {
        season.puntTBs = { value: puntStat.puntTBs, name: 'TBS' };
      } else {
        season.puntTBs.value += puntStat.puntTBs;
      }
    }
  }

  return seasonAggregation;
}

function formatSeasonStats(player: Player, stats: PlayerStats, teams: TeamList, logos: LeagueLogos) {
  const teamAbbr = getTeamAbbr(player.teamId, teams)
  const agg = aggregateSeason(stats)
  const formattedAgg = formatSeasonAggregation(agg)

  return `# ${getTeamEmoji(teamAbbr, logos)} ${player.position} ${player.firstName} ${player.lastName}
## ${getDevTraitName(player.devTrait, player.yearsPro)} **${player.playerBestOvr} OVR**
${formattedAgg}`
}

function formatPlayerList(players: Player[], teams: TeamList, logos: LeagueLogos) {
  const playerCards = players.map(player => {
    const teamName = getTeamAbbr(player.teamId, teams)
    const fullName = `${player.firstName} ${player.lastName}`
    const heightFeet = Math.floor(player.height / 12)
    const heightInches = player.height % 12
    const teamEmoji = getTeamEmoji(teamName, logos) === SnallabotTeamEmojis.NFL ? `**${teamName}**` : getTeamEmoji(teamName, logos)
    const devTraitEmoji = getDevTraitName(player.devTrait, player.yearsPro)

    return `### ${teamEmoji} ${player.position} ${fullName}
> ${devTraitEmoji} **${player.playerBestOvr} OVR** | ${player.age} yrs | ${heightFeet}'${heightInches}" ${player.weight}lbs`
  })

  return `# Player Results\n${playerCards.join("\n")}`
}

type PlayerFound = { teamAbbr: string, rosterId: number, firstName: string, lastName: string, teamId: number, position: string }

async function searchPlayerForRosterId(query: string, leagueId: string): Promise<PlayerFound[]> {
  const [playersToSearch, teamsIndex] = await Promise.all([playerSearchIndex.createView(leagueId), teamSearchView.createView(leagueId)])
  if (playersToSearch && teamsIndex) {
    const players = Object.fromEntries(Object.entries(playersToSearch).map(entry => {
      const [rosterId, roster] = entry
      const abbr = roster.teamId === 0 ? "FA" : teamsIndex?.[roster.teamId]?.abbrName
      return [rosterId, { teamAbbr: abbr, ...roster }]
    }))
    const results = fuzzysort.go(query, Object.values(players), {
      keys: ["firstName", "lastName", "position", "teamAbbr"], threshold: 0.4, limit: 25
    })
    return results.map(r => r.obj)
  }
  return []
}
const positions = POSITIONS.concat(POSITION_GROUP).map(p => ({ teamDisplayName: "", teamId: -1, teamNickName: "", position: p, rookie: "" }))
const rookies = [{
  teamDisplayName: "", teamId: -1, teamNickName: "", position: "", rookie: "Rookies"
}]
const rookiePositions = positions.map(p => ({ ...p, rookie: "Rookies" }))
type PlayerListSearchQuery = { teamDisplayName: string, teamId: number, teamNickName: string, position: string, rookie: string }


// to boost top level queries like team names, position groups, and rookies
function isTopLevel(q: PlayerListSearchQuery) {
  if (q.teamDisplayName && !q.position && !q.rookie) {
    return true
  }
  if (!q.teamDisplayName && q.position && !q.rookie) {
    return true
  }
  if (!q.teamDisplayName && !q.position && q.rookie) {
    return true
  }
  return false
}

function formatQuery(q: PlayerListSearchQuery) {
  const teamName = q.teamDisplayName ? [q.teamDisplayName] : []
  const position = q.position ? [q.position] : []
  const rookie = q.rookie ? [q.rookie] : []
  return [teamName, rookie, position].join(" ")
}

async function searchPlayerListForQuery(textQuery: string, leagueId: string): Promise<PlayerListSearchQuery[]> {
  const teamIndex = await teamSearchView.createView(leagueId)
  if (teamIndex) {
    const fullTeams = Object.values(teamIndex).map(t => ({ teamDisplayName: t.displayName, teamId: t.id, teamNickName: t.nickName, position: "", rookie: "" })).concat([{ teamDisplayName: "Free Agents", teamId: 0, teamNickName: "FA", position: "", rookie: "" }])
    const teamPositions = fullTeams.flatMap(t => positions.map(p => ({ teamDisplayName: t.teamDisplayName, teamId: t.teamId, teamNickName: t.teamNickName, position: p.position, rookie: "" })))
    const teamRookies = fullTeams.map(t => ({ ...t, rookie: "Rookies" }))
    const allQueries: PlayerListSearchQuery[] = fullTeams.concat(positions).concat(rookies).concat(rookiePositions).concat(teamPositions).concat(teamRookies)
    const results = fuzzysort.go(textQuery, allQueries, {
      keys: ["teamDisplayName", "teamNickName", "position", "rookie"],
      scoreFn: r => r.score * (isTopLevel(r.obj) ? 2 : 1),
      threshold: 0.4,
      limit: 25
    })
    return results.map(r => r.obj)
  }
  return []
}

export default {
  async handleCommand(command: Command, client: DiscordClient, _: Firestore, ctx: ParameterizedContext) {
    const { guild_id, token } = command
    if (!command.data.options) {
      throw new Error("logger command not defined properly")
    }
    const options = command.data.options
    const playerCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const subCommand = playerCommand.name
    if (subCommand === "get") {
      if (!playerCommand.options || !playerCommand.options[0]) {
        throw new Error("player get misconfigured")
      }
      const playerSearch = (playerCommand.options[0] as APIApplicationCommandInteractionDataStringOption).value
      respond(ctx, deferMessage())
      showPlayerCard(playerSearch, client, token, guild_id)
    } else if (subCommand === "list") {
      if (!playerCommand.options || !playerCommand.options[0]) {
        throw new Error("player get misconfigured")
      }
      const playerSearch = (playerCommand.options[0] as APIApplicationCommandInteractionDataStringOption).value
      respond(ctx, deferMessage())
      showPlayerList(playerSearch, client, token, guild_id)
    } else {
      throw new Error(`Missing player command ${subCommand}`)
    }

  },
  commandDefinition(): RESTPostAPIApplicationCommandsJSONBody {
    return {
      name: "player",
      description: "retrieves the players in your league",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "get",
          description: "gets the player and shows their card",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "player",
              description:
                "search for the player",
              required: true,
              autocomplete: true
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "list",
          description: "list the players matching search",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "players",
              description:
                "players to search for",
              required: true,
              autocomplete: true
            },
          ],
        }
      ],
      type: 1,
    }
  },
  async choices(command: Autocomplete) {
    const { guild_id } = command
    if (!command.data.options) {
      throw new Error("player command not defined properly")
    }
    const options = command.data.options
    const playerCommand = options[0] as APIApplicationCommandInteractionDataSubcommandOption
    const subCommand = playerCommand.name
    if (subCommand === "get") {
      const view = await discordLeagueView.createView(guild_id)
      const leagueId = view?.leagueId
      if (leagueId && (playerCommand?.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.focused && playerCommand?.options?.[0]?.value) {
        const playerSearchPhrase = playerCommand.options[0].value as string
        const results = await searchPlayerForRosterId(playerSearchPhrase, leagueId)
        return results.map(r => ({ name: `${r.teamAbbr} ${r.position.toUpperCase()} ${r.firstName} ${r.lastName}`, value: `${r.rosterId}` }))
      }
    } else if (subCommand === "list") {
      const view = await discordLeagueView.createView(guild_id)
      const leagueId = view?.leagueId
      if (leagueId && (playerCommand?.options?.[0] as APIApplicationCommandInteractionDataStringOption)?.focused && playerCommand?.options?.[0]?.value) {
        const playerListSearchPhrase = playerCommand.options[0].value as string
        const results = await searchPlayerListForQuery(playerListSearchPhrase, leagueId)
        return results.map(r => {
          const { teamId, rookie, position } = r
          return { name: formatQuery(r), value: JSON.stringify({ teamId: teamId, rookie: !!rookie, position: position }) }
        })
      }
    }

    return []
  },
  async handleInteraction(interaction: MessageComponentInteraction, client: DiscordClient) {
    const customId = interaction.custom_id
    if (customId === "player_card") {
      const data = interaction.data as APIMessageStringSelectInteractionData
      if (data.values.length !== 1) {
        throw new Error("Somehow did not receive just one selection from player card " + data.values)
      }
      const { r: rosterId, s: selected, q: pagination } = JSON.parse(data.values[0]) as Selection
      try {
        if (selected === PlayerSelection.PLAYER_OVERVIEW) {
          showPlayerCard(`${rosterId}`, client, interaction.token, interaction.guild_id, pagination)
        } else if (selected === PlayerSelection.PLAYER_FULL_RATINGS) {
          showPlayerFullRatings(rosterId, client, interaction.token, interaction.guild_id, pagination)
        } else if (selected === PlayerSelection.PLAYER_WEEKLY_STATS) {
          showPlayerWeeklyStats(rosterId, client, interaction.token, interaction.guild_id, pagination)
        } else if (selected === PlayerSelection.PLAYER_SEASON_STATS) {
          showPlayerYearlyStats(rosterId, client, interaction.token, interaction.guild_id, pagination)
        } else if (selected === PlayerSelection.PLAYER_CONTRACT) {
          showPlayerContract(rosterId, client, interaction.token, interaction.guild_id, pagination)
        } else {
          console.error("should not have gotten here")
        }
      } catch (e) {
        await client.editOriginalInteraction(interaction.token, {
          flags: 32768,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: `Could not show player card Error: ${e}`
            },
            {
              type: ComponentType.Separator,
              divider: true,
              spacing: SeparatorSpacingSize.Large
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.StringSelect,
                  custom_id: "player_card",
                  placeholder: formatPlaceholder(PlayerSelection.PLAYER_OVERVIEW),
                  options: generatePlayerOptions(rosterId)
                }
              ]
            }
          ]
        })
      }
    } else {
      try {
        const { q: query, s: next, b: prev } = JSON.parse(customId) as PlayerPagination
        showPlayerList(JSON.stringify(fromShortQuery(query)), client, interaction.token, interaction.guild_id, next, prev)
      } catch (e) {
        await client.editOriginalInteraction(interaction.token, {
          flags: 32768,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: `Could not list players Error: ${e}`
            }
          ]
        })
      }
    }
    return {
      type: InteractionResponseType.DeferredMessageUpdate,
    }
  }
} as CommandHandler & AutocompleteHandler & MessageComponentHandler
