/**
 * sniperSizing.js
 * Time-based multiplier for sniper bet sizing.
 * All time windows are specified in UTC+8.
 */

import config from '../config/index.js';

const UTC8_OFFSET = 8;

/**
 * Convert HH:MM (UTC+8) to minutes-since-midnight UTC.
 */
function utc8ToUtcMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    let totalMin = (h * 60 + m) - (UTC8_OFFSET * 60);
    if (totalMin < 0) totalMin += 1440;
    if (totalMin >= 1440) totalMin -= 1440;
    return totalMin;
}

function inRange(nowMin, startMin, endMin) {
    if (startMin <= endMin) {
        return nowMin >= startMin && nowMin < endMin;
    }
    // overnight wrap
    return nowMin >= startMin || nowMin < endMin;
}

/**
 * Get the current time multiplier based on configured SNIPER_MULTIPLIERS windows.
 * Returns { multiplier, label } where label describes the active window (or 'default').
 */
export function getTimeMultiplier() {
    const windows = config.sniperMultipliers;
    if (!windows || windows.length === 0) return { multiplier: 1.0, label: 'default' };

    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

    for (const w of windows) {
        const startMin = utc8ToUtcMinutes(w.start);
        const endMin = utc8ToUtcMinutes(w.end);
        if (inRange(nowMin, startMin, endMin)) {
            return { multiplier: w.multiplier, label: `${w.start}-${w.end} UTC+8 → ${w.multiplier}x` };
        }
    }

    return { multiplier: 1.0, label: 'default' };
}
