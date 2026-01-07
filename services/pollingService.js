const axios = require('axios');
const pharmacyModel = require('../models/pharmacyStatusModel');

// Configuration
const STATUS_API_URL = process.env.STATUS_API_URL || 'https://api.example.com'; // Needs real URL
const API_LOGIN = process.env.EXTERNAL_API_LOGIN;
const API_PASSWORD = process.env.EXTERNAL_API_PASSWORD;

let isRunning = false;
let pollingInterval = null;

async function authenticate() {
    if (!API_LOGIN || !API_PASSWORD) {
        console.warn("Missing EXTERNAL_API_LOGIN or EXTERNAL_API_PASSWORD. Polling skipped.");
        return null;
    }

    try {
        const response = await axios.post(`${STATUS_API_URL}/auth/login`, {
            phone: API_LOGIN,
            password: API_PASSWORD
        });
        return response.data.token;
    } catch (error) {
        console.error("Polling Auth Failed:", error.message);
        return null;
    }
}

async function fetchExternalPharmacies(token) {
    try {
        // Assuming the API supports a large size or pagination loop. 
        // Using size=10000 based on usage in reportsApi.ts
        const response = await axios.post(`${STATUS_API_URL}/market/list`, {
            page: 0,
            size: 10000,
            active: null // active: null usually means "all" in this API logic based on reportsApi.ts
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.payload.list || [];
    } catch (error) {
        console.error("Polling Fetch Failed:", error.message);
        return [];
    }
}

async function syncPharmacies() {
    if (isRunning) return;
    isRunning = true;
    console.log("Starting Pharmacy Polling Sync...");

    try {
        const token = await authenticate();
        if (!token) {
            isRunning = false;
            return;
        }

        const externalPharmacies = await fetchExternalPharmacies(token);
        const internalPharmacies = await pharmacyModel.getAllPharmacies();

        // Create a map for quick lookup
        const internalMap = new Map();
        internalPharmacies.forEach(p => internalMap.set(String(p.pharmacy_id), p));

        let stats = { checked: 0, events: 0 };

        for (const extP of externalPharmacies) {
            const pharmacyId = String(extP.id);
            const isExternalActive = extP.active; // true | false

            const internalState = internalMap.get(pharmacyId) || {
                pharmacy_id: pharmacyId,
                last_active: true, // Default heuristic: new pharmacies start 'active' in external system usually? 
                // Spec says "True -> False: Set first_deactivated_at". 
                // If it's new and active, we effectively treat it as previously active (or just ignore until deactivation).
                first_deactivated_at: null,
                first_trained_activation_at: null
            };

            let newLastActive = internalState.last_active;
            let newFirstDeactivated = internalState.first_deactivated_at;
            let newFirstTrained = internalState.first_trained_activation_at;

            // Rule: Compare States
            // Note: internalState.last_active comes from DB boolean

            const wasActive = internalState.last_active;
            const isNowActive = isExternalActive;

            if (wasActive !== isNowActive) {
                // Change detected!

                // CASE 1: first_deactivated_at IS NULL
                if (!processDate(newFirstDeactivated)) { // Check if null/invalid
                    if (wasActive === true && isNowActive === false) {
                        // True -> False: Initial Deactivation
                        newFirstDeactivated = new Date();
                        await pharmacyModel.logEvent(pharmacyId, 'DEACTIVATED', 'polling');
                        stats.events++;
                    }
                    // Else: Do nothing (e.g. False -> True before first deactivation is ignored)
                }
                // CASE 2: first_deactivated_at IS NOT NULL
                else {
                    if (wasActive === false && isNowActive === true) {
                        // False -> True: Activation
                        await pharmacyModel.logEvent(pharmacyId, 'ACTIVATED', 'polling');
                        stats.events++;

                        // Mark "New Pharmacy" (First trained activation) if not set
                        if (!processDate(newFirstTrained)) {
                            newFirstTrained = new Date();
                        }
                    } else if (wasActive === true && isNowActive === false) {
                        // True -> False: Deactivation
                        await pharmacyModel.logEvent(pharmacyId, 'DEACTIVATED', 'polling');
                        stats.events++;
                    }
                }

                // Update State
                await pharmacyModel.updatePollingState(
                    pharmacyId,
                    isNowActive,
                    newFirstDeactivated,
                    newFirstTrained
                );
            } else {
                // Even if no change, we might want to ensure the record exists (e.g. for new pharmacies)
                // But the prompt says "First status active=true NOT counted".
                // But we need to save it so next time we know it was true.
                if (!internalMap.has(pharmacyId)) {
                    // It's a brand new pharmacy found in External API.
                    // We insert it with its current state.
                    await pharmacyModel.updatePollingState(
                        pharmacyId,
                        isNowActive,
                        null,
                        null
                    );
                }
            }
            stats.checked++;
        }

        console.log(`Polling Complete. Checked: ${stats.checked}, Events: ${stats.events}`);
        return stats; // Return stats for debug

    } catch (error) {
        console.error("Sync Error:", error);
        return { error: error.message };
    } finally {
        isRunning = false;
    }
}

// Cooldown to prevent spamming external API (e.g. 30 seconds)
let lastSyncTime = 0;
const COOLDOWN_MS = 1000;

async function triggerSyncSafely() {
    const now = Date.now();
    if (isRunning) {
        console.log("Sync already running, skipping trigger.");
        return;
    }
    if (now - lastSyncTime < COOLDOWN_MS) {
        console.log(`Sync cooldown active (` + ((COOLDOWN_MS - (now - lastSyncTime)) / 1000).toFixed(1) + `s remaining). Skipping.`);
        return;
    }

    // Update timestamp before starting to prevent race conditions roughly
    lastSyncTime = now;

    // Run sync but don't await the whole process if used in background, 
    // BUT for "Sync on Request" user wants fresh data. 
    // We will await it in the controller, so return the promise here.
    return syncPharmacies();
}

function startPolling() {
    // Run immediately on start
    syncPharmacies();

    // Schedule every 30 minutes
    pollingInterval = setInterval(syncPharmacies, 30 * 60 * 1000);
    console.log("Polling service scheduled (every 30m)");
}

module.exports = { startPolling, triggerSync: triggerSyncSafely };
