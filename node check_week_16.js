const https = require('https');

// --- CONFIGURATION ---
// Based on your URL provided in the log
const BASE_URL = 'https://nelbot.itsyamsayin.com'; 
const YEAR = '2026';
const WEEK_TYPE = 'reg'; // Regular Season
const WEEK_NUMBER = '16'; // The current week that is failing

const filesToCheck = [
    `/${YEAR}/${WEEK_TYPE}/${WEEK_NUMBER}/schedule.json`,
    `/${YEAR}/${WEEK_TYPE}/${WEEK_NUMBER}/teams.json`, // Sometimes teams are weekly, sometimes global
    `/teams.json` // Checking global teams location just in case
];

console.log(`\n🔍 CHECKING DATA INTEGRITY FOR WEEK ${WEEK_NUMBER}...\n`);

function checkUrl(path) {
    return new Promise((resolve) => {
        const fullUrl = BASE_URL + path;
        
        https.get(fullUrl, (res) => {
            let data = '';
            
            // A 200 OK means the file exists
            if (res.statusCode === 200) {
                res.on('data', (chunk) => data += chunk);
                
                res.on('end', () => {
                    try {
                        // Try to parse it to ensure it's valid JSON and not a corrupt text file
                        const json = JSON.parse(data);
                        const count = Array.isArray(json) ? json.length : Object.keys(json).length;
                        console.log(`✅ [SUCCESS] ${path}`);
                        console.log(`   Status: 200 OK | Type: Valid JSON | Items found: ${count}`);
                        resolve(true);
                    } catch (e) {
                        console.log(`❌ [FAILED]  ${path}`);
                        console.log(`   Status: 200 OK, but INVALID JSON. (File might be cut off)`);
                        resolve(false);
                    }
                });
            } else {
                console.log(`❌ [FAILED]  ${path}`);
                console.log(`   Status: ${res.statusCode} (File not found or Server Error)`);
                resolve(false);
            }
        }).on('error', (err) => {
            console.log(`❌ [ERROR]   ${path} - ${err.message}`);
            resolve(false);
        });
    });
}

async function runDiagnostics() {
    console.log(`Target: ${BASE_URL}`);
    console.log('---------------------------------------------------');
    
    // Check specific files needed for Game Chats
    await checkUrl(`/${YEAR}/${WEEK_TYPE}/${WEEK_NUMBER}/schedule.json`);
    
    // Check stats (usually the culprit for "Export Failed")
    await checkUrl(`/${YEAR}/${WEEK_TYPE}/${WEEK_NUMBER}/defense.json`);
    await checkUrl(`/${YEAR}/${WEEK_TYPE}/${WEEK_NUMBER}/passing.json`);
    
    console.log('---------------------------------------------------');
    console.log('DIAGNOSIS:');
    console.log('If "schedule.json" is SUCCESS, you can force your bot to run game chats.');
    console.log('If "schedule.json" is FAILED, you must re-export from the Madden Companion App.');
}

runDiagnostics();