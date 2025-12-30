/**
 * ================================================
 * NEL HQ BOT - GAME RESULT NOTIFIER
 * ================================================
 * Sends game result events to NEL Utility Bot
 * for automatic schedule updates and team stats
 */

// Configuration from environment - secrets must be set via env vars
const WEBHOOK_URL = process.env.NEL_UTILITY_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.NEL_UTILITY_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

// Warn if webhook is not configured (but don't crash - it's optional)
if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
    console.warn('[WEBHOOK] NEL Utility webhook not configured - game result notifications disabled. Set NEL_UTILITY_WEBHOOK_URL and NEL_UTILITY_WEBHOOK_SECRET env vars to enable.');
}

interface GameResultEvent {
    home_team: string;
    away_team: string;
    home_score: number;
    away_score: number;
    week_number: number;
    season: string;
}

/**
 * Notify NEL Utility Bot that a game has been completed
 */
export async function notifyGameResult(event: GameResultEvent): Promise<void> {
    // Skip if webhook not configured
    if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
        return;
    }

    try {
        console.log(`[WEBHOOK] Notifying game result: ${event.away_team} @ ${event.home_team} (Week ${event.week_number})`);

        // Add timeout to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        const response = await fetch(`${WEBHOOK_URL}/game-result`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHOOK_SECRET}`
            },
            body: JSON.stringify(event),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Webhook failed: ${response.status} - ${error}`);
        }

        const result = await response.json();
        console.log(`[WEBHOOK] Game result notification sent successfully:`, result);

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.error('[WEBHOOK] Game result notification timed out after 10 seconds');
        } else {
            console.error('[WEBHOOK] Failed to notify game result:', error);
        }
        // Don't throw - webhook failure shouldn't break game result detection
    }
}

/**
 * Example usage - call this when NEL HQ Bot detects a game completion
 *
 * This should be called from your game completion detection logic:
 *
 * import { notifyGameResult } from './twitch-notifier/game_result_notifier';
 *
 * // When game is detected as complete
 * await notifyGameResult({
 *     home_team: 'Cardinals',
 *     away_team: 'Seahawks',
 *     home_score: 24,
 *     away_score: 21,
 *     week_number: 5,
 *     season: 'Season 2'
 * });
 */
