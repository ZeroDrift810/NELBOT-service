/**
 * Script to register Discord slash commands
 * Run with: npm run register-commands
 */

const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || 'http://localhost:3000';

async function registerCommands() {
  console.log('🔧 Registering Discord slash commands...\n');

  const response = await fetch(`${DEPLOYMENT_URL}/discord/webhook/commandsHandler`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      commandNames: [], // Empty array means register ALL commands
      mode: 'INSTALL' // INSTALL mode registers/updates commands
    })
  });

  if (response.ok) {
    console.log('✅ Successfully registered all Discord commands!');
    console.log('   Commands including schedule_export are now available in Discord.');
    console.log('\n💡 Note: It may take a few minutes for Discord to update globally.');
  } else {
    const error = await response.text();
    console.error('❌ Failed to register commands:', error);
    process.exit(1);
  }
}

registerCommands()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
