/**
 * Simple script to register schedule_export command only
 * Run with: node --env-file=.env dist/scripts/register_commands_simple.js
 */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.APPLICATION_ID;

if (!DISCORD_TOKEN || !APP_ID) {
  console.error('❌ Missing DISCORD_TOKEN or APPLICATION_ID in .env');
  process.exit(1);
}

async function registerScheduleExport() {
  console.log('🔧 Registering /schedule_export command...\n');

  const command = {
    name: "schedule_export",
    description: "Export schedule data as JSON for use with external tools",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "current",
        description: "Export the current week's schedule",
        options: []
      },
      {
        type: 1, // SUB_COMMAND
        name: "week",
        description: "Export a specific week's schedule",
        options: [
          {
            type: 4, // INTEGER
            name: "week",
            description: "Week number to export (1-18 regular season, 19-23 playoffs)",
            required: true
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Successfully registered /schedule_export command!');
      console.log(`   Command ID: ${data.id}`);
    } else {
      const error = await response.json();
      console.error('❌ Failed to register command:', JSON.stringify(error, null, 2));

      // If command already exists, try to update it
      if (error.code === 30032 || error.message?.includes('already')) {
        console.log('\n⚠️  Command might already exist. Fetching existing commands...');

        const getResponse = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
          headers: {
            'Authorization': `Bot ${DISCORD_TOKEN}`
          }
        });

        const commands = await getResponse.json();
        const existing = commands.find((c: any) => c.name === 'schedule_export');

        if (existing) {
          console.log(`   Found existing command with ID: ${existing.id}`);
          console.log('   Updating...');

          const updateResponse = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands/${existing.id}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bot ${DISCORD_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(command)
          });

          if (updateResponse.ok) {
            console.log('✅ Successfully updated /schedule_export command!');
          } else {
            const updateError = await updateResponse.json();
            console.error('❌ Failed to update:', JSON.stringify(updateError, null, 2));
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

registerScheduleExport()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
