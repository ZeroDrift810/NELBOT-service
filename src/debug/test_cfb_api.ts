/**
 * Test script for investigating EA Sports College Football 26 API
 *
 * Usage:
 * 1. Get an access token from your dashboard (after linking EA account)
 * 2. Replace YOUR_ACCESS_TOKEN below with your actual token
 * 3. Run: npx ts-node src/debug/test_cfb_api.ts
 */

import { Agent, fetch } from "undici";
import { constants } from "crypto";

// EA uses legacy SSL
const dispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
    secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  },
});

// Test configurations
const ACCESS_TOKEN = "YOUR_ACCESS_TOKEN"; // Replace with your actual token
const CONSOLE = "ps5"; // or 'xone', 'ps4', 'xbsx', 'pc'

// Possible service name patterns
const SERVICE_PATTERNS = [
  // College Football 26 variations (following Madden's pattern: 25→2026, so 26→2027)
  'cfb-2027',
  'college-2027',
  'ncaa-2027',
  'collegefootball-2027',
  'cfb26-2027',
  // Also try 2026 in case EA uses different numbering
  'cfb-2026',
  'college-2026',
  'ncaa-2026',
  'collegefootball-2026',
  'cfb26-2026',
];

// Possible application keys
const APP_KEYS = [
  'CFB-MCA',
  'COLLEGE-MCA',
  'NCAA-MCA',
  'CFBALL-MCA',
  'CFB26-MCA',
  'CFB25-MCA', // Just in case they kept the same key
];

async function testEntitlements() {
  console.log('\n🔍 Checking EA Entitlements...\n');

  try {
    const res = await fetch(
      "https://gateway.ea.com/proxy/identity/pids/me/entitlements",
      {
        headers: {
          "Authorization": `Bearer ${ACCESS_TOKEN}`,
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) {
      console.error('❌ Failed to fetch entitlements:', res.status, res.statusText);
      return;
    }

    const data = await res.json() as any;
    const entitlements = data.entitlements?.entitlement || [];

    console.log(`📋 Total Entitlements: ${entitlements.length}\n`);

    // Look for College Football related entitlements
    const cfbKeywords = ['CFB', 'COLLEGE', 'NCAA', 'FOOTBALL'];
    const cfbEntitlements = entitlements.filter((e: any) =>
      cfbKeywords.some(keyword =>
        e.entitlementTag?.toUpperCase().includes(keyword)
      )
    );

    if (cfbEntitlements.length > 0) {
      console.log('🏈 College Football Entitlements Found:\n');
      cfbEntitlements.forEach((e: any) => {
        console.log(`  ✅ ${e.entitlementTag}`);
        console.log(`     Product: ${e.productId}`);
        console.log(`     Group: ${e.groupName}`);
        console.log('');
      });
    } else {
      console.log('⚠️  No College Football entitlements found.');
      console.log('   Make sure you own EA Sports College Football 26.\n');
    }

    // Also show Madden entitlements for comparison
    const maddenEntitlements = entitlements.filter((e: any) =>
      e.entitlementTag?.toUpperCase().includes('MADDEN')
    );

    if (maddenEntitlements.length > 0) {
      console.log('🏈 Madden Entitlements (for comparison):\n');
      maddenEntitlements.forEach((e: any) => {
        console.log(`  ✅ ${e.entitlementTag}`);
      });
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error checking entitlements:', error);
  }
}

async function testBlazeService(serviceName: string, appKey: string) {
  const fullServiceName = `${serviceName}-${CONSOLE}`;
  const productName = `${fullServiceName}-mca`;

  try {
    const res = await fetch(
      `https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login`,
      {
        dispatcher: dispatcher,
        method: "POST",
        headers: {
          "Accept-Charset": "UTF-8",
          "Accept": "application/json",
          "X-BLAZE-ID": fullServiceName,
          "X-BLAZE-VOID-RESP": "XML",
          "X-Application-Key": appKey,
          "Content-Type": "application/json",
          "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)",
        },
        body: JSON.stringify({
          accessToken: ACCESS_TOKEN,
          productName: productName,
        }),
      }
    );

    const responseText = await res.text();

    if (res.ok) {
      console.log(`✅ SUCCESS! Found working configuration:`);
      console.log(`   Service: ${fullServiceName}`);
      console.log(`   App Key: ${appKey}`);
      console.log(`   Product: ${productName}`);
      console.log(`   Response:`, JSON.parse(responseText));
      return true;
    }

    // Log failures only if they're not 404s (expected for wrong names)
    if (res.status !== 404) {
      console.log(`⚠️  Unexpected response for ${fullServiceName} + ${appKey}:`, res.status);
      console.log(`   Response:`, responseText.substring(0, 200));
    }

    return false;

  } catch (error: any) {
    // Silently skip network errors for non-existent services
    if (!error.message?.includes('ENOTFOUND')) {
      console.error(`❌ Error testing ${fullServiceName}:`, error.message);
    }
    return false;
  }
}

async function testAllCombinations() {
  console.log('\n🔍 Testing Blaze Service Combinations...\n');
  console.log(`   Console: ${CONSOLE}`);
  console.log(`   Testing ${SERVICE_PATTERNS.length} service patterns × ${APP_KEYS.length} app keys\n`);

  let foundWorking = false;

  for (const pattern of SERVICE_PATTERNS) {
    for (const appKey of APP_KEYS) {
      const result = await testBlazeService(pattern, appKey);
      if (result) {
        foundWorking = true;
        break;
      }
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (foundWorking) break;
  }

  if (!foundWorking) {
    console.log('\n❌ No working Blaze service combinations found.');
    console.log('   This could mean:');
    console.log('   1. College Football uses a different API structure');
    console.log('   2. The API requires different authentication');
    console.log('   3. Try using network sniffing on the companion app\n');
  }
}

async function main() {
  console.log('🏈 EA Sports College Football 26 API Investigation Tool\n');
  console.log('='.repeat(60));

  if (ACCESS_TOKEN === 'YOUR_ACCESS_TOKEN') {
    console.error('\n❌ Error: Please set ACCESS_TOKEN in the script!');
    console.log('\n📝 To get your access token:');
    console.log('   1. Link your EA account via /dashboard command');
    console.log('   2. Check the Firebase database for your access token');
    console.log('   3. Or add logging to src/dashboard/ea_client.ts\n');
    return;
  }

  // Step 1: Check entitlements
  await testEntitlements();

  // Step 2: Test Blaze services
  await testAllCombinations();

  console.log('='.repeat(60));
  console.log('\n✅ Investigation complete!');
  console.log('\n📚 See COLLEGE_FOOTBALL_API_INVESTIGATION.md for next steps.\n');
}

main().catch(console.error);
