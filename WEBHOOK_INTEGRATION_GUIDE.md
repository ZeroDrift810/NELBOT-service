# NEL HQ Bot Webhook Integration Guide

This guide shows how to integrate the NEL Utility Bot webhook system into NEL HQ Bot for automatic stream logging.

## Prerequisites

1. NEL Utility Bot webhook server running on port 3001
2. Environment variables configured (see below)

## Environment Variables

Add these to your `.env` file:

```bash
# NEL Utility Bot Webhook Integration
NEL_UTILITY_WEBHOOK_URL=http://localhost:3001/api
NEL_UTILITY_WEBHOOK_SECRET=your-secret-key-change-this-in-production
```

**Production URLs:**
- If NEL Utility Bot runs on different server: `http://utility-bot-server:3001/api`
- Or use ngrok/tunnel for testing

## Integration Steps

### Step 1: Install node-fetch (if not already installed)

```bash
npm install node-fetch
```

### Step 2: Import webhook notifier in routes.ts

At the top of `src/twitch-notifier/routes.ts`, add:

```typescript
import { notifyStreamStarted, notifyStreamEnded } from './webhook_notifier'
```

### Step 3: Modify handleStreamEvent function

Find the `handleStreamEvent` function (around line 128) and add webhook calls:

**BEFORE** (existing code):
```typescript
async function handleStreamEvent(twitchEvent: StreamUpEvent) {
  const twitchUser = twitchEvent.event.broadcaster_user_id
  const channelInformation = await twitchClient.retrieveChannelInformation(twitchUser)
  const broadcaster = channelInformation.data[0]
  const broadcasterName = broadcaster.broadcaster_name
  const broadcastTitle = broadcaster.title
  const subscriptionDoc = await db.collection("twitch_notifiers").doc(twitchUser).get()
  // ... rest of function
}
```

**AFTER** (with webhooks):
```typescript
async function handleStreamEvent(twitchEvent: StreamUpEvent) {
  const twitchUser = twitchEvent.event.broadcaster_user_id
  const channelInformation = await twitchClient.retrieveChannelInformation(twitchUser)
  const broadcaster = channelInformation.data[0]
  const broadcasterName = broadcaster.broadcaster_name
  const broadcastTitle = broadcaster.title
  const subscriptionDoc = await db.collection("twitch_notifiers").doc(twitchUser).get()

  // ... existing code ...

  await Promise.all(subscribedServers.map(async (server) => {
    const leagueSettings = await LeagueSettingsDB.getLeagueSettings(server)
    const configuration = leagueSettings.commands?.broadcast
    if (!configuration) {
      console.error(`${server} is not configured for Broadcasts`)
    } else {
      const titleKeyword = configuration.title_keyword
      if (broadcastTitle.toLowerCase().includes(titleKeyword.toLowerCase())) {

        // EXISTING: Post to broadcast channel
        await EventDB.appendEvents<MaddenBroadcastEvent>([{
          key: server, event_type: "MADDEN_BROADCAST", title: broadcastTitle, video: createTwitchUrl(broadcasterName)
        }], EventDelivery.EVENT_SOURCE)

        // NEW: Notify NEL Utility Bot via webhook
        // Get Discord user ID from team assignments
        const teamAssignments = await db.collection("league_settings")
          .doc(server)
          .collection("team_assignments")
          .where("twitchUsername", "==", broadcasterName)
          .get()

        if (!teamAssignments.empty) {
          const discordUserId = teamAssignments.docs[0].data().discordId

          // Send stream started webhook
          await notifyStreamStarted({
            player_id: discordUserId,
            twitch_url: createTwitchUrl(broadcasterName),
            twitch_username: broadcasterName,
            stream_title: broadcastTitle
          })
        }
      }
    }
  }))
}
```

### Step 4: Add stream offline webhook

Create a new webhook endpoint to listen for stream offline events:

```typescript
router.post("/stream-offline",
  async (ctx, next) => {
    const secret = getSecret()
    const message = getHmacMessage(ctx)
    const hmac = HMAC_PREFIX + getHmac(secret, message)
    if (verifyMessage(hmac, ctx.request.get(TWITCH_MESSAGE_SIGNATURE))) {
      await next()
    } else {
      ctx.status = 403
    }
  },
  async (ctx, next) => {
    const twitchEvent = ctx.request.body as StreamOfflineEvent
    ctx.status = 200
    await next()

    // Extract broadcaster info
    const broadcasterId = twitchEvent.event.broadcaster_user_id
    const broadcasterLogin = twitchEvent.event.broadcaster_user_login

    // Get Discord user ID
    const subscriptionDoc = await db.collection("twitch_notifiers").doc(broadcasterId).get()
    const subscription = subscriptionDoc.data() as SubscriptionDoc
    const subscribedServers = Object.entries(subscription.servers)
      .filter(entry => entry[1].subscribed)
      .map(entry => entry[0])

    // Notify NEL Utility Bot for each server
    for (const server of subscribedServers) {
      const teamAssignments = await db.collection("league_settings")
        .doc(server)
        .collection("team_assignments")
        .where("twitchUsername", "==", broadcasterLogin)
        .get()

      if (!teamAssignments.empty) {
        const discordUserId = teamAssignments.docs[0].data().discordId

        await notifyStreamEnded({
          player_id: discordUserId,
          twitch_url: createTwitchUrl(broadcasterLogin)
        })
      }
    }
  }
)
```

### Step 5: Subscribe to stream offline events

In `src/twitch-notifier/twitch_client.ts`, add a method to subscribe to offline events:

```typescript
async subscribeBroadcasterStreamOffline(broadcasterId: string) {
  return this.helixClient.post("eventsub/subscriptions", {
    json: {
      type: "stream.offline",
      version: "1",
      condition: {
        broadcaster_user_id: broadcasterId
      },
      transport: {
        method: "webhook",
        callback: `${this.callbackUrl}/stream-offline`,
        secret: this.secret
      }
    }
  }).json()
}
```

## Testing

### 1. Start NEL Utility Bot webhook server:
```bash
cd NEL-Utility-Bot
node webhook-server.js
```

### 2. Start NEL HQ Bot:
```bash
cd NELBOTMASTER
npm start
```

### 3. Test with a stream:
1. Go live on Twitch with "NEL" in the title
2. Check NEL Utility Bot logs for "Stream started webhook received"
3. End the stream
4. Check for "Stream ended webhook received"
5. Player should receive DM with auto-log notification

## Troubleshooting

### Webhook not receiving events
- Check `WEBHOOK_SECRET` matches in both bots
- Verify webhook server is running
- Check firewall/network settings

### Discord user ID not found
- Ensure team assignments include Twitch username mapping
- Add Twitch username to team assignments in Firebase

### Stream not auto-logging
- Check database migration ran successfully
- Verify player has a team assigned
- Check schedule table has upcoming games

## Alternative: Simple HTTP Monitoring

If you don't want to modify NEL HQ Bot extensively, you can use the NEL Utility Bot's message monitoring instead:

1. NEL HQ Bot posts stream announcement to broadcast channel
2. NEL Utility Bot monitors that channel
3. Parses stream URL from message
4. Stores in `detected_streams` table
5. When stream ends (detected by time or manual), triggers auto-log

This requires less integration but won't detect stream end automatically.
