import db from "../db/firebase";
import { MaddenEvents } from "../db/madden_db";

/**
 * Diagnostic script to check database health
 * Run with: npm run diagnose <leagueId>
 */

async function diagnoseDatabaseHealth(leagueId: string) {
  console.log(`\n🔍 Database Diagnostics for League ${leagueId}\n`);
  console.log('='.repeat(60));

  // Check league document
  const leagueDoc = await db.collection("madden_data26").doc(leagueId).get();
  if (!leagueDoc.exists) {
    console.log(`❌ League ${leagueId} not found in database!`);
    return;
  }

  console.log(`\n✅ League document exists`);
  const leagueData = leagueDoc.data();
  console.log(`   Blaze ID: ${leagueData?.blazeId}`);

  // Check teams
  console.log(`\n📊 TEAMS:`);
  const teamDocs = await db.collection("madden_data26").doc(leagueId).collection(MaddenEvents.MADDEN_TEAM).get();
  console.log(`   Total teams: ${teamDocs.size}`);

  const validTeams = teamDocs.docs.filter(doc => {
    const team = doc.data();
    return team.divName && team.displayName;
  });

  const invalidTeams = teamDocs.docs.filter(doc => {
    const team = doc.data();
    return !team.divName || !team.displayName;
  });

  console.log(`   ✅ Valid teams (with divName): ${validTeams.length}`);
  console.log(`   ❌ Ghost teams (no divName): ${invalidTeams.length}`);

  if (invalidTeams.length > 0) {
    console.log(`\n   🔍 Ghost teams details:`);
    invalidTeams.forEach(doc => {
      const team = doc.data();
      console.log(`      - teamId=${team.teamId}, displayName="${team.displayName || 'MISSING'}", divName="${team.divName || 'MISSING'}"`);
    });
  }

  const validTeamIds = new Set(validTeams.map(doc => doc.data().teamId));
  console.log(`   Valid team IDs: ${Array.from(validTeamIds).sort((a, b) => a - b).join(', ')}`);

  // Check standings
  console.log(`\n📊 STANDINGS:`);
  const standingDocs = await db.collection("madden_data26").doc(leagueId).collection(MaddenEvents.MADDEN_STANDING).get();
  console.log(`   Total standings: ${standingDocs.size}`);

  // Check schedules
  console.log(`\n📊 SCHEDULES:`);
  const scheduleDocs = await db.collection("madden_data26").doc(leagueId).collection(MaddenEvents.MADDEN_SCHEDULE).get();
  console.log(`   Total schedule entries: ${scheduleDocs.size}`);

  const schedulesByWeek = new Map<string, any[]>();
  const invalidSchedules: any[] = [];
  const validSchedules: any[] = [];

  scheduleDocs.docs.forEach(doc => {
    const game = doc.data();
    const weekKey = `S${game.seasonIndex}-W${game.weekIndex + 1}`;

    if (!schedulesByWeek.has(weekKey)) {
      schedulesByWeek.set(weekKey, []);
    }
    schedulesByWeek.get(weekKey)!.push(game);

    const isInvalid =
      !game.awayTeamId ||
      !game.homeTeamId ||
      game.awayTeamId === 0 ||
      game.homeTeamId === 0 ||
      !validTeamIds.has(game.awayTeamId) ||
      !validTeamIds.has(game.homeTeamId);

    if (isInvalid) {
      invalidSchedules.push({ id: doc.id, ...game });
    } else {
      validSchedules.push({ id: doc.id, ...game });
    }
  });

  console.log(`   ✅ Valid schedule entries: ${validSchedules.length}`);
  console.log(`   ❌ Invalid schedule entries: ${invalidSchedules.length}`);

  console.log(`\n   📅 Games by week:`);
  Array.from(schedulesByWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([week, games]) => {
      const played = games.filter(g => g.status !== 1).length;
      const notPlayed = games.filter(g => g.status === 1).length;
      console.log(`      ${week}: ${games.length} games (${played} played, ${notPlayed} not played)`);
    });

  if (invalidSchedules.length > 0) {
    console.log(`\n   🔍 Invalid schedule entries:`);
    invalidSchedules.slice(0, 10).forEach(game => {
      const reason = !game.awayTeamId || game.awayTeamId === 0 ? 'Invalid away team' :
                     !game.homeTeamId || game.homeTeamId === 0 ? 'Invalid home team' :
                     !validTeamIds.has(game.awayTeamId) ? `Away team ${game.awayTeamId} not in valid teams` :
                     `Home team ${game.homeTeamId} not in valid teams`;
      console.log(`      - scheduleId=${game.scheduleId}, S${game.seasonIndex}-W${game.weekIndex + 1}`);
      console.log(`        awayTeamId=${game.awayTeamId}, homeTeamId=${game.homeTeamId} - ${reason}`);
    });
    if (invalidSchedules.length > 10) {
      console.log(`      ... and ${invalidSchedules.length - 10} more`);
    }
  }

  // Check export status
  console.log(`\n📊 EXPORT STATUS:`);
  const exportStatus = leagueData?.exportStatus;
  if (exportStatus) {
    console.log(`   Last team export: ${exportStatus[MaddenEvents.MADDEN_TEAM]?.lastExported || 'Never'}`);
    console.log(`   Last standings export: ${exportStatus[MaddenEvents.MADDEN_STANDING]?.lastExported || 'Never'}`);

    const weeklyStatus = exportStatus.weeklyStatus || {};
    const exportedWeeks = Object.keys(weeklyStatus).length;
    console.log(`   Weeks with exports: ${exportedWeeks}`);
  } else {
    console.log(`   ⚠️  No export status recorded`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`\n💡 RECOMMENDATIONS:\n`);

  if (invalidTeams.length > 0) {
    console.log(`   ⚠️  ${invalidTeams.length} ghost teams found - these may cause issues`);
    console.log(`      These are usually from league resets or relocations`);
  }

  if (invalidSchedules.length > 0) {
    console.log(`   ⚠️  ${invalidSchedules.length} invalid schedule entries found`);
    console.log(`      Run: npm run cleanup-schedules ${leagueId} --live`);
    console.log(`      This will delete invalid schedule entries`);
  }

  if (invalidTeams.length === 0 && invalidSchedules.length === 0) {
    console.log(`   ✅ Database looks healthy!`);
  }

  console.log();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('❌ Usage: npm run diagnose <leagueId>');
    process.exit(1);
  }

  const leagueId = args[0];

  try {
    await diagnoseDatabaseHealth(leagueId);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error during diagnosis:', error);
    process.exit(1);
  }
}

main();
