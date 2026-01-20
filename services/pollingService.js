const axios = require('axios');
const pharmacyModel = require('../models/pharmacyStatusModel');

// Configuration
const STATUS_API_URL = process.env.STATUS_API_URL || 'https://api.example.com'; // Needs real URL
const API_LOGIN = process.env.EXTERNAL_API_LOGIN;
const API_PASSWORD = process.env.EXTERNAL_API_PASSWORD;

// Helper to check if date is valid/present
function processDate(d) {
    return d && new Date(d).getTime() > 0;
}

let isRunning = false;
let pollingInterval = null;

async function authenticate() {
    if (!API_LOGIN || !API_PASSWORD) {
        console.warn("Missing EXTERNAL_API_LOGIN or EXTERNAL_API_PASSWORD. Polling skipped.");
        return null;
    }

    try {
        const response = await axios.post(`${STATUS_API_URL}/auth/admin-login`, {
            login: API_LOGIN,
            password: API_PASSWORD
        });

        // Correct path based on frontend LoginResponse interface
        const token = response.data?.payload?.token?.token;

        if (!token) {
            console.error("Auth response missing token. Structure:", JSON.stringify(response.data).substring(0, 200));
            return null;
        }
        return token;
    } catch (error) {
        console.error("Polling Auth Failed:", error.message);
        if (error.response) {
            console.error("Auth Response Data:", JSON.stringify(error.response.data));
        }
        return null;
    }
}

async function fetchExternalPharmacies(token) {
    try {
        // Market List
        const response = await axios.post(`${STATUS_API_URL}/market/list`, {
            page: 0,
            size: 10000,
            active: null
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.payload.list || [];
    } catch (error) {
        console.error("Polling Fetch Market Failed:", error.message);
        return [];
    }
}

async function fetchExternalLeads(token) {
    try {
        // Lead List
        const response = await axios.post(`${STATUS_API_URL}/lead/list`, {
            page: 0,
            size: 10000
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.payload.list || [];
    } catch (error) {
        console.error("Polling Fetch Leads Failed:", error.message);
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
            console.log("Auth failed, stopping sync.");
            isRunning = false;
            return;
        }
        console.log("Auth successful. Fetching lists...");

        // Fetch both lists in parallel
        const [marketList, leadList] = await Promise.all([
            fetchExternalPharmacies(token),
            fetchExternalLeads(token)
        ]);

        console.log(`Fetched ${marketList.length} market items and ${leadList.length} leads.`);

        // Filter leads that are already converted (status === 'CONVERTED')
        // According to requirements: converted leads are already in marketList, so we skip them in leadList
        const activeLeads = leadList.filter(l => l.status !== 'CONVERTED');

        console.log(`Filtered down to ${activeLeads.length} non-converted leads.`);

        const internalPharmacies = await pharmacyModel.getAllPharmacies();

        // Create a map for quick lookup
        const internalMap = new Map();
        internalPharmacies.forEach(p => internalMap.set(String(p.pharmacy_id), p));

        let stats = { checked: 0, events: 0 };

        // Process Market List (the main active/inactive pharmacies)
        for (const item of marketList) {
            await processPharmacyItem(item, internalMap, stats, true);
        }

        // Process Lead List (treated as inactive/potential pharmacies)
        // explicitly set 'active' field to false for leads if it doesn't exist, 
        // to ensure they are treated as inactive by default logic.
        for (const item of activeLeads) {
            // Leads usually don't have an 'active' boolean at root level like market items might.
            // We force it to false or whatever the logic dictates.
            // Requirement: "show them via market/list", but for leads we just want to list them.
            // The prompt implies we just merge them. 
            // If a lead becomes ACTIVE it likely moves to market list and becomes CONVERTED.
            // So a non-converted lead is inherently INACTIVE in the context of "Pharmacy Status".

            // We clone/modify to match expected shape if needed, or just pass as is with override
            const leadItem = { ...item, active: false };
            await processPharmacyItem(leadItem, internalMap, stats, false);
        }

        console.log(`Polling Complete. Checked: ${stats.checked}, Events: ${stats.events}`);

    } catch (error) {
        console.error("Sync Error:", error);
    } finally {
        isRunning = false;
    }
}

async function processPharmacyItem(extP, internalMap, stats, isMarketItem) {
    const pharmacyId = String(extP.id);
    const isExternalActive = extP.active; // true | false

    const internalState = internalMap.get(pharmacyId) || {
        pharmacy_id: pharmacyId,
        last_active: true, // Default heuristic for new items
        first_deactivated_at: null,
        first_trained_activation_at: null
    };

    let newLastActive = internalState.last_active;
    let newFirstDeactivated = internalState.first_deactivated_at;
    let newFirstTrained = internalState.first_trained_activation_at;

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
        if (!internalMap.has(pharmacyId)) {
            // New item insert
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
