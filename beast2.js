const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION LISTS ---
const OPPONENT_IDS = ['BM-KXU7QZ', 'BM-VB62DY'];
const BEASTS = ['Sybil', 'Rune', 'Goliath'];

// --- TIMEOUT SETTINGS ---
const FETCH_TIMEOUT = 15000; // 15 second timeout for fetch requests
const MAX_BATTLE_DURATION = 300000; // 5 minute max per battle (safety cutoff)

// Helper function to create a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeout);
        return response;
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});
let otakuGroup = null;
let activeBattles = new Map(); // Maps battleId → { promise, combo }
let activeCombos = new Set(); // Set of comboKeys currently in battle
let pendingCombos = new Map(); // Maps timestamp → combo (for quick lookup)
let battleIdCounter = 0; // To generate unique battle IDs

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n--- Client is ready! ---');
    console.log(`\n🔧 SETUP:`);
    console.log(`   Opponents: ${OPPONENT_IDS.length} | Beasts: ${BEASTS.length}`);
    console.log(`   Total combos: ${OPPONENT_IDS.length * BEASTS.length}`);
    console.log(`   ✓ Running battle system with proper combo tracking\n`);

    try {
        await sleep(3000);
        const chats = await client.getChats();
        otakuGroup = chats.find(chat => chat.isGroup && chat.name === 'Phantom Troupe');

        if (otakuGroup) {
            console.log('✓ Group "Phantom Troupe" found! Starting battles...');
            challengeLoop();
        } else {
            console.log('❌ Error: Group "Phantom Troupe" not found.');
        }
    } catch (err) {
        console.error('Error fetching chats:', err);
    }
});

// Track which combo we just sent (with timestamp to avoid race conditions)
let lastSentCombo = null;
let lastSentTime = null;

client.on('message', async (msg) => {
    if (msg.body.includes('Challenger:') && msg.body.includes('Defender:')) {

        const challengerMatch = msg.body.match(/Challenger:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);
        const defenderMatch = msg.body.match(/Defender:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);

        if (challengerMatch && defenderMatch && lastSentCombo && lastSentTime) {
            const challengerUrl = challengerMatch[1];
            const defenderUrl = defenderMatch[1];

            // Use the combo that was just sent
            const combo = lastSentCombo;
            const timeDiff = Date.now() - lastSentTime;

            // INCREASED TOLERANCE: Allow up to 15 seconds for the message to arrive
            if (timeDiff > 15000) {
                console.log(`[WARNING] Message arrived ${timeDiff}ms after challenge - might be stale, skipping`);
                return;
            }

            const battleId = ++battleIdCounter;

            console.log(`\n[BATTLE START] Battle #${battleId} captured for combo: ${combo.comboKey}`);
            console.log(`               Time since challenge: ${timeDiff}ms`);
            console.log(`               Active battles: ${activeBattles.size}`);

            // Create battle promise that MUST complete before marking done
            const battlePromise = executeBattle(battleId, challengerUrl, defenderUrl)
            .then(() => {
                console.log(`[BATTLE END] Battle #${battleId} ✓ Completed successfully`);
            })
            .catch((err) => {
                console.error(`[BATTLE ERROR] Battle #${battleId} failed:`, err.message);
            })
            .finally(() => {
                // CLEANUP: Release this specific combo
                if (activeCombos.has(combo.comboKey)) {
                    activeCombos.delete(combo.comboKey);
                    const totalCombos = OPPONENT_IDS.length * BEASTS.length;
                    console.log(`[CLEANUP] Released combo: ${combo.comboKey} | Remaining: ${activeCombos.size}/${totalCombos}`);
                }

                // Remove battle from active
                activeBattles.delete(battleId);
                console.log(`[STATUS] Active battles remaining: ${activeBattles.size}`);
            });

            // Track this battle
            activeBattles.set(battleId, { promise: battlePromise, combo: combo.comboKey });
            console.log(`[TRACKING] Total concurrent battles: ${activeBattles.size}`);

            // Clear the last sent combo
            lastSentCombo = null;
            lastSentTime = null;
        }
    }
});

/**
 * Execute a single battle from start to finish - MUST COMPLETE
 */
async function executeBattle(battleId, challengerUrl, defenderUrl) {
    console.log(`[EXEC] [Battle #${battleId}] Initializing Lobby Setup...`);
    const battleStartTime = Date.now();

    try {
        // STEP 1: Ready up both players
        console.log(`[EXEC] [Battle #${battleId}] [STEP 1/3] Readying up players...`);
        const [challengerReady, defenderReady] = await Promise.all([
            readyUpPlayer(challengerUrl, 'Challenger', battleId),
                                                                   readyUpPlayer(defenderUrl, 'Defender', battleId)
        ]);

        if (!challengerReady || !defenderReady) {
            throw new Error('Failed to ready up both players');
        }

        console.log(`[EXEC] [Battle #${battleId}] ✓ Both players Ready!`);
        await sleep(500);

        // STEP 2: Run both strike loops concurrently
        console.log(`[EXEC] [Battle #${battleId}] [STEP 2/3] Battle in progress...`);
        await Promise.all([
            startStrikeLoop(challengerUrl, 'Challenger', battleId),
                          startStrikeLoop(defenderUrl, 'Defender', battleId)
        ]);

        const battleDuration = ((Date.now() - battleStartTime) / 1000).toFixed(1);
        console.log(`[EXEC] [Battle #${battleId}] [STEP 3/3] ✓ Battle Concluded! (Duration: ${battleDuration}s)`);

    } catch (err) {
        const battleDuration = ((Date.now() - battleStartTime) / 1000).toFixed(1);
        console.error(`[EXEC] [Battle #${battleId}] ❌ Error (${battleDuration}s):`, err.message);
        throw err;
    }

    // CRITICAL: Rest AFTER battle is fully done
    console.log(`[EXEC] [Battle #${battleId}] Resting 5s before next battle...`);
    await sleep(5000);
}

/**
 * Get a list of available (not currently fighting) opponent+beast combos
 */
function getAvailableCombos() {
    const available = [];

    for (const opponentId of OPPONENT_IDS) {
        for (const beast of BEASTS) {
            const comboKey = `${opponentId}:${beast}`;
            if (!activeCombos.has(comboKey)) {
                available.push({ opponentId, beast, comboKey });
            }
        }
    }
    return available;
}

/**
 * Continuously send challenges - one per battle
 */
async function challengeLoop() {
    let challengeCount = 0;
    const totalCombos = OPPONENT_IDS.length * BEASTS.length;

    while (true) {
        try {
            const available = getAvailableCombos();

            if (available.length === 0) {
                // All combos are fighting - wait
                console.log(`[QUEUE] All ${totalCombos} combos in battle. Waiting... (${activeCombos.size}/${totalCombos})`);
                await sleep(3000);
                continue;
            }

            // Pick random available combo
            const combo = available[Math.floor(Math.random() * available.length)];

            // Mark as active BEFORE sending challenge
            activeCombos.add(combo.comboKey);
            challengeCount++;

            // --- RECOVERY FAILSAFE ---
            // If the battle link isn't captured within 15 seconds, release the combo from the queue
            setTimeout(() => {
                const isFighting = Array.from(activeBattles.values()).some(b => b.combo === combo.comboKey);
                if (!isFighting && activeCombos.has(combo.comboKey)) {
                    console.log(`[RECOVERY] Missed battle link for ${combo.comboKey}. Releasing back to pool.`);
                    activeCombos.delete(combo.comboKey);
                }
            }, 15000);
            // -------------------------

            // Store this combo as "just sent" for message handler to link
            lastSentCombo = combo;
            lastSentTime = Date.now();

            // Send challenge with typing indicator
            await otakuGroup.sendStateTyping();
            await sleep(1500);

            const challengeCommand = `.beast challenge ${combo.opponentId} ${combo.beast}`;
            await otakuGroup.sendMessage(challengeCommand);

            console.log(`[SEND] Challenge #${challengeCount}: ${challengeCommand}`);
            console.log(`       [Queue: ${activeCombos.size}/${totalCombos} | Battles: ${activeBattles.size}]`);

            await otakuGroup.clearState();

            // Wait before next challenge
            await sleep(3000);

        } catch (error) {
            console.error('[LOOP] Challenge loop error:', error.message);
            await sleep(5000);
        }
    }
}

async function readyUpPlayer(webUrl, role, battleId) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
    };

    console.log(`[READY] [Battle #${battleId}] [${role}] Starting setup...`);

    try {
        if (role === 'Defender') {
            console.log(`[READY] [Battle #${battleId}] [${role}] Fetching available beasts...`);

            const beastsRes = await fetchWithTimeout(`${apiUrl}/beasts`, {
                headers,
                method: 'GET'
            });

            if (!beastsRes.ok) {
                throw new Error(`API returned status ${beastsRes.status} when fetching beasts`);
            }

            const beastsData = await beastsRes.json();

            if (beastsData.beasts && beastsData.beasts.length > 0) {
                const randomIndex = Math.floor(Math.random() * beastsData.beasts.length);
                const randomBeast = beastsData.beasts[randomIndex];
                const selectedBeastId = randomBeast.cardId;

                console.log(`[READY] [Battle #${battleId}] [${role}] Selecting beast: ${randomBeast.name} (${selectedBeastId})`);

                const selectRes = await fetchWithTimeout(`${apiUrl}/select-beast`, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ beastQuery: selectedBeastId })
                });

                if (!selectRes.ok) {
                    throw new Error(`Failed to select beast - Status ${selectRes.status}`);
                }

                console.log(`[READY] [Battle #${battleId}] [${role}] ✓ Beast locked in`);
            } else {
                throw new Error('No beasts found in defender deck');
            }
        }

        // Ready up
        console.log(`[READY] [Battle #${battleId}] [${role}] Sending ready signal...`);
        const readyRes = await fetchWithTimeout(`${apiUrl}/ready`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({})
        });

        if (!readyRes.ok) {
            throw new Error(`Failed to ready up - Status ${readyRes.status}`);
        }

        console.log(`[READY] [Battle #${battleId}] [${role}] ✓ Successfully readied up`);
        return true;

    } catch (error) {
        console.error(`[READY] [Battle #${battleId}] [${role}] ❌ Setup failed:`, error.message);
        return false;
    }
}

async function startStrikeLoop(webUrl, role, battleId) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
    };

    let strikeCount = 0;
    const strikeStartTime = Date.now();

    console.log(`[STRIKE] [Battle #${battleId}] [${role}] Strike loop started`);

    while (true) {
        try {
            // Safety: Don't let battle run forever
            if (Date.now() - strikeStartTime > MAX_BATTLE_DURATION) {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] ⚠️  Max battle duration exceeded. Stopping.`);
                break;
            }

            const actionResponse = await fetchWithTimeout(`${apiUrl}/action`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ action: 'strike' })
            });

            if (!actionResponse.ok) {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] Server rejected strike (Status ${actionResponse.status})`);
                break;
            }

            const data = await actionResponse.json();

            if (data.error || (data.status && data.status === 'error')) {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] Battle ended: ${data.error || 'Game finished'}`);
                break;
            }

            strikeCount++;
            console.log(`[STRIKE] [Battle #${battleId}] [${role}] Strike #${strikeCount} ✓`);

            await sleep(1500);

        } catch (error) {
            console.error(`[STRIKE] [Battle #${battleId}] [${role}] ❌ Error:`, error.message);
            break;
        }
    }

    const strikeDuration = ((Date.now() - strikeStartTime) / 1000).toFixed(1);
    console.log(`[STRIKE] [Battle #${battleId}] [${role}] Loop ended after ${strikeCount} strikes (${strikeDuration}s)`);
}

client.initialize();
