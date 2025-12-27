/**
 * ================================================
 * NEL HQ BOT - WEBHOOK NOTIFIER FOR NEL UTILITY BOT
 * ================================================
 * Sends stream detection events to NEL Utility Bot
 * for automatic AP logging and rewards
 */

// Configuration from environment
const WEBHOOK_URL = process.env.NEL_UTILITY_WEBHOOK_URL || 'http://localhost:3001/api';
const WEBHOOK_SECRET = process.env.NEL_UTILITY_WEBHOOK_SECRET || 'your-secret-key-change-this';

// Validate configuration on load
if (!process.env.NEL_UTILITY_WEBHOOK_URL) {
    console.warn('[WEBHOOK] NEL_UTILITY_WEBHOOK_URL not set in environment. Using default: http://localhost:3001/api');
}

if (!process.env.NEL_UTILITY_WEBHOOK_SECRET || process.env.NEL_UTILITY_WEBHOOK_SECRET === 'your-secret-key-change-this') {
    console.warn('[WEBHOOK] ⚠️  NEL_UTILITY_WEBHOOK_SECRET not set or using default value! Webhook authentication will fail in production.');
}

interface StreamStartedEvent {
    player_id: string;
    twitch_url: string;
    twitch_username: string;
    stream_title: string;
}

interface StreamEndedEvent {
    player_id: string;
    twitch_url: string;
}

/**
 * Notify NEL Utility Bot that a stream has started
 */
export async function notifyStreamStarted(event: StreamStartedEvent): Promise<void> {
    try {
        // Validate required fields
        if (!event.player_id || !event.twitch_url || !event.twitch_username) {
            console.error('[WEBHOOK] Missing required fields in stream started event:', event);
            return;
        }

        console.log(`[WEBHOOK] Notifying stream started for ${event.twitch_username} (player: ${event.player_id})`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
            const response = await fetch(`${WEBHOOK_URL}/stream-started`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${WEBHOOK_SECRET}`
                },
                body: JSON.stringify(event),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Webhook failed: ${response.status} - ${error}`);
            }

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const result = await response.json();
                console.log(`[WEBHOOK] Stream started notification sent successfully:`, result);
            } else {
                console.log(`[WEBHOOK] Stream started notification sent successfully (status: ${response.status})`);
            }
        } finally {
            clearTimeout(timeout);
        }

    } catch (error: any) {
        if (error.name === 'AbortError') {
            console.error('[WEBHOOK] Stream started notification timed out after 10 seconds');
        } else {
            console.error('[WEBHOOK] Failed to notify stream started:', error.message || error);
        }
        // Don't throw - webhook failure shouldn't break stream detection
    }
}

/**
 * Notify NEL Utility Bot that a stream has ended
 */
export async function notifyStreamEnded(event: StreamEndedEvent): Promise<void> {
    try {
        // Validate required fields
        if (!event.player_id || !event.twitch_url) {
            console.error('[WEBHOOK] Missing required fields in stream ended event:', event);
            return;
        }

        console.log(`[WEBHOOK] Notifying stream ended for player ${event.player_id}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
            const response = await fetch(`${WEBHOOK_URL}/stream-ended`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${WEBHOOK_SECRET}`
                },
                body: JSON.stringify(event),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Webhook failed: ${response.status} - ${error}`);
            }

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const result = await response.json();
                console.log(`[WEBHOOK] Stream ended notification sent successfully:`, result);
            } else {
                console.log(`[WEBHOOK] Stream ended notification sent successfully (status: ${response.status})`);
            }
        } finally {
            clearTimeout(timeout);
        }

    } catch (error: any) {
        if (error.name === 'AbortError') {
            console.error('[WEBHOOK] Stream ended notification timed out after 10 seconds');
        } else {
            console.error('[WEBHOOK] Failed to notify stream ended:', error.message || error);
        }
        // Don't throw - webhook failure shouldn't break stream detection
    }
}
