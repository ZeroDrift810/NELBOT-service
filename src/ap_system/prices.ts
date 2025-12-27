// AP Shop Price List Configuration
// Based on "No Excuses League - Official AP Shop Costs"

export const AP_PRICES = {
  physical: {
    speed: 15,
    changeOfDirection: 12,
    acceleration: 12,
    throwPower: 12,
    agility: 10,
    strength: 10,
    jumping: 8
  },
  offensive: {
    deepRouteRunning: 8,
    mediumRouteRunning: 6,
    shortRouteRunning: 6,
    catching: 6,
    cit: 6,
    specCatch: 6,
    breakTackle: 6,
    trucking: 6,
    stiffArm: 6,
    jukeMove: 5,
    spinMove: 5,
    carrying: 5,
    throwAccuracyShort: 6,
    throwAccuracyMid: 6,
    throwAccuracyDeep: 6
  },
  defensive: {
    manCoverage: 8,
    zoneCoverage: 8,
    press: 6,
    powerMoves: 8,
    finesseMoves: 8,
    blockShedding: 8,
    tackling: 6,
    hitPower: 6,
    pursuit: 5
  },
  blocking: {
    passBlockPower: 6,
    passBlockFinesse: 6,
    runBlockPower: 6,
    runBlockFinesse: 6,
    impactBlock: 5,
    awareness: 3,
    playRecognition: 4,
    stamina: 2,
    injury: 2,
    toughness: 2
  }
}

// Friendly names for display
const FRIENDLY_NAMES: { [key: string]: string } = {
  // Physical
  speed: "Speed",
  changeOfDirection: "Change of Direction",
  acceleration: "Acceleration",
  throwPower: "Throw Power",
  agility: "Agility",
  strength: "Strength",
  jumping: "Jumping",
  
  // Offensive
  deepRouteRunning: "Deep Route Running",
  mediumRouteRunning: "Medium Route Running",
  shortRouteRunning: "Short Route Running",
  catching: "Catching",
  cit: "CIT (Catch in Traffic)",
  specCatch: "Spectacular Catch",
  breakTackle: "Break Tackle",
  trucking: "Trucking",
  stiffArm: "Stiff Arm",
  jukeMove: "Juke Move",
  spinMove: "Spin Move",
  carrying: "Carrying",
  throwAccuracyShort: "Throw Accuracy Short",
  throwAccuracyMid: "Throw Accuracy Mid",
  throwAccuracyDeep: "Throw Accuracy Deep",
  
  // Defensive
  manCoverage: "Man Coverage",
  zoneCoverage: "Zone Coverage",
  press: "Press",
  powerMoves: "Power Moves",
  finesseMoves: "Finesse Moves",
  blockShedding: "Block Shedding",
  tackling: "Tackling",
  hitPower: "Hit Power",
  pursuit: "Pursuit",
  
  // Blocking
  passBlockPower: "Pass Block Power",
  passBlockFinesse: "Pass Block Finesse",
  runBlockPower: "Run Block Power",
  runBlockFinesse: "Run Block Finesse",
  impactBlock: "Impact Block",
  awareness: "Awareness",
  playRecognition: "Play Recognition",
  stamina: "Stamina",
  injury: "Injury",
  toughness: "Toughness"
}

export function formatPriceList(): string {
  let message = "# 🛒 No Excuses League - Official AP Shop Costs\n\n"
  message += "Use this price list to plan your upgrades. All costs are for a +1 boost to the attribute.\n\n"
  
  // Physical
  message += "### **Elite Physical Ratings**\n"
  Object.entries(AP_PRICES.physical).forEach(([key, price]) => {
    message += `- **${FRIENDLY_NAMES[key]}:** ${price} AP\n`
  })
  message += "\n"
  
  // Offensive
  message += "### **Offensive Skill Ratings**\n"
  Object.entries(AP_PRICES.offensive).forEach(([key, price]) => {
    message += `- **${FRIENDLY_NAMES[key]}:** ${price} AP\n`
  })
  message += "\n"
  
  // Defensive
  message += "### **Defensive Skill Ratings**\n"
  Object.entries(AP_PRICES.defensive).forEach(([key, price]) => {
    message += `- **${FRIENDLY_NAMES[key]}:** ${price} AP\n`
  })
  message += "\n"
  
  // Blocking
  message += "### **Blocking & Utility Ratings**\n"
  Object.entries(AP_PRICES.blocking).forEach(([key, price]) => {
    message += `- **${FRIENDLY_NAMES[key]}:** ${price} AP\n`
  })
  
  return message
}

export function getPricesByCategory(category: string): string | null {
  const categories: { [key: string]: any } = {
    physical: AP_PRICES.physical,
    offensive: AP_PRICES.offensive,
    defensive: AP_PRICES.defensive,
    blocking: AP_PRICES.blocking
  }
  
  const categoryTitles: { [key: string]: string } = {
    physical: "Elite Physical Ratings",
    offensive: "Offensive Skill Ratings",
    defensive: "Defensive Skill Ratings",
    blocking: "Blocking & Utility Ratings"
  }
  
  const prices = categories[category]
  if (!prices) return null
  
  let message = `### **${categoryTitles[category]}**\n\n`
  Object.entries(prices).forEach(([key, price]) => {
    message += `- **${FRIENDLY_NAMES[key]}:** ${price} AP\n`
  })
  
  return message
}

// Helper to get price by attribute name
export function getPrice(attribute: string): number | null {
  const allPrices = {
    ...AP_PRICES.physical,
    ...AP_PRICES.offensive,
    ...AP_PRICES.defensive,
    ...AP_PRICES.blocking
  }
  
  return allPrices[attribute as keyof typeof allPrices] || null
}
