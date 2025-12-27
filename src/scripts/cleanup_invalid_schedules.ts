import db from "../db/firebase";
import { MaddenEvents } from "../db/madden_db";
import { MaddenGame } from "../export/madden_league_types";

/**
 * This script cleans up invalid schedule entries from Firestore
 * Run with: npm run cleanup-schedules <leagueId>
 */

async function getValidTeamIds(leagueId: string): Promise<Set<number>> {
  const teamDocs = await db.collection("madden_data26").doc(leagueId).collection(MaddenEvents.MADDEN_TEAM).get();
  const validTeamIds = new Set<number>();

  teamDocs.docs.forEach(doc => {
    const team = doc.data();
    // Only include teams with proper division names (not ghost teams)
    if (team.divName && team.displayName) {
      validTeamIds.add(team.teamId);
    }
  });

  console.log(`✅ Found ${validTeamIds.size} valid teams`);
  console.log(`   Valid team IDs: ${Array.from(validTeamIds).sort((a, b) => a - b).join(', ')}`);
  return validTeamIds;
}

async function cleanupInvalidSchedules(leagueId: string, dryRun: boolean = true) {
  console.log(`\n🔍 Analyzing schedule data for league ${leagueId}...`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will delete)'}\n`);

  const validTeamIds = await getValidTeamIds(leagueId);

  const scheduleDocs = await db
    .collection("madden_data26")
    .doc(leagueId)
    .collection(MaddenEvents.MADDEN_SCHEDULE)
    .get();

  console.log(`📊 Found ${scheduleDocs.size} total schedule entries\n`);

  const invalidDocs: any[] = [];
  const validDocs: any[] = [];

  scheduleDocs.docs.forEach(doc => {
    const game = doc.data() as MaddenGame;
    const isInvalid =
      !game.awayTeamId ||
      !game.homeTeamId ||
      game.awayTeamId === 0 ||
      game.homeTeamId === 0 ||
      !validTeamIds.has(game.awayTeamId) ||
      !validTeamIds.has(game.homeTeamId);

    if (isInvalid) {
      invalidDocs.push({ id: doc.id, ...game });
    } else {
      validDocs.push({ id: doc.id, ...game });
    }
  });

  console.log(`✅ Valid schedule entries: ${validDocs.length}`);
  console.log(`❌ Invalid schedule entries: ${invalidDocs.length}\n`);

  if (invalidDocs.length > 0) {
    console.log(`📋 Invalid entries details:`);
    invalidDocs.forEach(doc => {
      const reason = !doc.awayTeamId || doc.awayTeamId === 0 ? 'Invalid away team' :
                     !doc.homeTeamId || doc.homeTeamId === 0 ? 'Invalid home team' :
                     !validTeamIds.has(doc.awayTeamId) ? `Away team ${doc.awayTeamId} not found` :
                     `Home team ${doc.homeTeamId} not found`;

      console.log(`   - scheduleId=${doc.scheduleId}, week=${doc.weekIndex + 1}, season=${doc.seasonIndex}`);
      console.log(`     awayTeamId=${doc.awayTeamId}, homeTeamId=${doc.homeTeamId}`);
      console.log(`     Reason: ${reason}\n`);
    });

    if (!dryRun) {
      console.log(`\n🗑️  Deleting ${invalidDocs.length} invalid entries...`);
      const batch = db.batch();
      invalidDocs.forEach(doc => {
        const docRef = db
          .collection("madden_data26")
          .doc(leagueId)
          .collection(MaddenEvents.MADDEN_SCHEDULE)
          .doc(doc.id);
        batch.delete(docRef);
      });

      await batch.commit();
      console.log(`✅ Successfully deleted ${invalidDocs.length} invalid schedule entries`);
    } else {
      console.log(`\n⚠️  DRY RUN: Would delete ${invalidDocs.length} entries`);
      console.log(`   Run with --live flag to actually delete them`);
    }
  } else {
    console.log(`✅ No invalid entries found! Database is clean.`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('❌ Usage: npm run cleanup-schedules <leagueId> [--live]');
    console.error('   --live: Actually delete entries (default is dry run)');
    process.exit(1);
  }

  const leagueId = args[0];
  const isLive = args.includes('--live');

  try {
    await cleanupInvalidSchedules(leagueId, !isLive);
    console.log('\n✅ Cleanup complete!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error during cleanup:', error);
    process.exit(1);
  }
}

main();
