/**
 * ================================================
 * NEL HQ BOT - GAME RESULT NOTIFIER
 * ================================================
 * Sends game result events to NEL Utility Bot
 * for automatic schedule updates and team stats
 */

// Configuration from environment
const WEBHOOK_URL = process.env.NEL_UTILITY_WEBHOOK_URL || 'http://localhost:3001/api';
const WEBHOOK_SECRET = process.env.NEL_UTILITY_WEBHOOK_SECRET || 'your-secret-key-change-this';

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
    try {
        console.log(`[WEBHOOK] Notifying game result: ${event.away_team} @ ${event.home_team} (Week ${event.week_number})`);

        const response = await fetch(`${WEBHOOK_URL}/game-result`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WEBHOOK_SECRET}`
            },
            body: JSON.stringify(event)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Webhook failed: ${response.status} - ${error}`);
        }

        const result = await response.json();
        console.log(`[WEBHOOK] Game result notification sent successfully:`, result);

    } catch (error) {
        console.error('[WEBHOOK] Failed to notify game result:', error);
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
