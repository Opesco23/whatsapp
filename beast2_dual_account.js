const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION ---
const OPPONENT_IDS = ['BM-KXU7QZ'];
// const OPPONENT_IDS = ['BM-FWPUN7'];
const BEASTS = ['Eevee', 'Arceus'];
// const BEASTS = ['PX-8', 'PX-9', 'PX-13', 'PX-14', 'Pup'];

// --- TIMEOUT SETTINGS ---
const FETCH_TIMEOUT = 15000;
const MAX_BATTLE_DURATION = 300000;
const LINK_PAIR_TIMEOUT = 25000; // Time to wait for paired link

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
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

// ============================================
// DUAL CLIENT SETUP
// ============================================
const clientChallenger = new Client({
    authStrategy: new LocalAuth({ clientId: 'challenger' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

const clientDefender = new Client({
    authStrategy: new LocalAuth({ clientId: 'defender' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// ============================================
// SHARED STATE
// ============================================
let otakuGroup = null;
let activeBattles = new Map();
let activeCombos = new Set();
let battleIdCounter = 0;

// Link pairing - UNIFIED STRUCTURE
// battleId -> { challengerUrl, defenderUrl, combo, timestamp, hasChallenger, hasDefender }
let pendingBattles = new Map();

// Challenge tracking
let lastSentCombo = null;
let lastSentTime = null;

// ============================================
// UTILITY FUNCTIONS
// ============================================
function getBattleIdFromUrl(url) {
    const match = url.match(/\/battle\/([a-f0-9]+)/);
    return match ? match[1] : null;
}

function extractBattleUrl(text) {
    // Extract first battle URL found
    const urlPattern = /https:\/\/quizmd\.online\/battle\/[a-f0-9]+\/[^\/]+\/[a-f0-9a-z]+/;
    const match = text.match(urlPattern);
    return match ? match[0] : null;
}

function getChallengerIdFromDM(text) {
    // Extract challenger ID from DM message
    // Pattern: "el challenged you" or similar
    const match = text.match(/\*([^*]+)\*\s+challenged you/);
    return match ? match[1] : null;
}

// ============================================
// CHALLENGER CLIENT (el) - SENDS CHALLENGES
// ============================================
clientChallenger.on('qr', (qr) => {
    console.log('\n[CHALLENGER QR] Scan to login as el (Challenger):');
    qrcode.generate(qr, { small: true });
});

clientChallenger.on('ready', async () => {
    console.log('\n✓ CHALLENGER CLIENT (el) is ready!\n');

    try {
        await sleep(3000);
        const chats = await clientChallenger.getChats();
        otakuGroup = chats.find(chat => chat.isGroup && chat.name === 'Phantom Troupe');

        if (otakuGroup) {
            console.log('✓ Group "Phantom Troupe" found!');
            console.log(`\n🔧 SETUP:`);
            console.log(`   Opponents: ${OPPONENT_IDS.length} | Beasts: ${BEASTS.length}`);
            console.log(`   Total combos: ${OPPONENT_IDS.length * BEASTS.length}`);
            console.log(`   Link pair timeout: ${LINK_PAIR_TIMEOUT / 1000}s`);
            console.log(`   ✓ Challenger link from GROUP`);
            console.log(`   ✓ Defender link from DM\n`);

            challengeLoop();
        } else {
            console.log('❌ Error: Group "Phantom Troupe" not found.');
        }
    } catch (err) {
        console.error('Error fetching chats:', err);
    }
});

/**
 * CHALLENGER: Capture challenger link from group message
 */
clientChallenger.on('message', async (msg) => {
    // Only process group messages with battle links
    if (!msg.from.endsWith('@g.us') || !msg.body.includes('quizmd.online/battle/')) {
        return;
    }

    // Look for "Challenger:" line in group message
    if (!msg.body.includes('Challenger:')) {
        return;
    }

    const challengerUrl = extractBattleUrl(msg.body.split('Challenger:')[1]);

    if (!challengerUrl || !lastSentCombo || !lastSentTime) {
        return;
    }

    const battleId = getBattleIdFromUrl(challengerUrl);
    if (!battleId) return;

    const timeDiff = Date.now() - lastSentTime;

    // TOLERANCE: Allow 15 seconds for message to arrive
    if (timeDiff > LINK_PAIR_TIMEOUT) {
        console.log(`[WARNING] Challenger link arrived ${timeDiff}ms after challenge - stale, skipping`);
        return;
    }

    // Initialize battle entry
    if (!pendingBattles.has(battleId)) {
        pendingBattles.set(battleId, {
            challengerUrl: null,
            defenderUrl: null,
            combo: null,
            timestamp: Date.now(),
            hasChallenger: false,
            hasDefender: false
        });
    }

    const battle = pendingBattles.get(battleId);
    battle.challengerUrl = challengerUrl;
    battle.hasChallenger = true;
    battle.combo = lastSentCombo;
    battle.timestamp = Date.now();

    console.log(`\n[CHALLENGER] ✓ Captured from GROUP for Battle: ${battleId}`);
    console.log(`             Combo: ${lastSentCombo.comboKey}`);
    console.log(`             Time since challenge: ${timeDiff}ms`);
    console.log(`             Waiting for defender link from DM...`);

    lastSentCombo = null;
    lastSentTime = null;

    tryStartBattle(battleId);
});

// ============================================
// DEFENDER CLIENT (Atsuomi) - CAPTURES DM LINK
// ============================================
clientDefender.on('qr', (qr) => {
    console.log('\n[DEFENDER QR] Scan to login as Atsuomi (Defender):');
    qrcode.generate(qr, { small: true });
});

clientDefender.on('ready', async () => {
    console.log('\n✓ DEFENDER CLIENT (Atsuomi) is ready!');
    console.log('   Listening for defender links in DMs...\n');
});

/**
 * DEFENDER: Capture defender link from DM
 * Bot sends: "el challenged you to a Beast Battle! Open your private defender link..."
 * Format: "https://quizmd.online/battle/ID/p/HASH" (defender gets a challenger-style URL)
 */
clientDefender.on('message', async (msg) => {
    // Only process DMs (not group messages)
    if (msg.from.endsWith('@g.us') || !msg.body.includes('challenged you')) {
        return;
    }

    // Check if this is a challenge notification
    if (!msg.body.includes('quizmd.online/battle/')) {
        return;
    }

    const defenderUrl = extractBattleUrl(msg.body);
    if (!defenderUrl) return;

    const battleId = getBattleIdFromUrl(defenderUrl);
    if (!battleId) return;

    // Extract challenger name from DM
    const challengerName = getChallengerIdFromDM(msg.body);

    // Initialize battle entry if needed
    if (!pendingBattles.has(battleId)) {
        pendingBattles.set(battleId, {
            challengerUrl: null,
            defenderUrl: null,
            combo: null,
            timestamp: Date.now(),
            hasChallenger: false,
            hasDefender: false
        });
    }

    const battle = pendingBattles.get(battleId);

    // Store defender URL
    battle.defenderUrl = defenderUrl;
    battle.hasDefender = true;

    console.log(`\n[DEFENDER] ✓ Captured from DM for Battle: ${battleId}`);
    console.log(`           Challenger: ${challengerName}`);
    console.log(`           Time to receive: ${Date.now() - battle.timestamp}ms`);

    if (battle.hasChallenger) {
        console.log(`           ✓ Challenger link already present`);
    } else {
        console.log(`           Waiting for challenger link from group...`);
    }

    tryStartBattle(battleId);
});

// ============================================
// LINK PAIRING & BATTLE EXECUTION
// ============================================
function tryStartBattle(battleId) {
    const battle = pendingBattles.get(battleId);
    if (!battle) return;

    // Both links must be present AND combo must be set
    if (battle.hasChallenger && battle.hasDefender && battle.combo) {
        console.log(`\n[PAIR] ✓ Both links ready! Starting Battle #${battleId}`);
        console.log(`       Combo: ${battle.combo.comboKey}`);
        console.log(`       Time to pair: ${Date.now() - battle.timestamp}ms`);

        pendingBattles.delete(battleId);

        // Mark combo as fighting
        activeCombos.add(battle.combo.comboKey);

        // Execute the battle
        const battlePromise = executeBattle(battleId, battle.challengerUrl, battle.defenderUrl)
            .then(() => {
                console.log(`[BATTLE END] Battle #${battleId} ✓ Completed successfully`);
            })
            .catch((err) => {
                console.error(`[BATTLE ERROR] Battle #${battleId} failed:`, err.message);
            })
            .finally(() => {
                // Release combo
                if (activeCombos.has(battle.combo.comboKey)) {
                    activeCombos.delete(battle.combo.comboKey);
                    const totalCombos = OPPONENT_IDS.length * BEASTS.length;
                    console.log(`[CLEANUP] Released combo: ${battle.combo.comboKey} | Remaining: ${activeCombos.size}/${totalCombos}`);
                }

                activeBattles.delete(battleId);
                console.log(`[STATUS] Active battles remaining: ${activeBattles.size}`);
            });

        activeBattles.set(battleId, { promise: battlePromise, combo: battle.combo.comboKey });
        console.log(`[TRACKING] Total concurrent battles: ${activeBattles.size}`);

        return true;
    }

    return false;
}

// Cleanup for stale battles
setInterval(() => {
    const now = Date.now();
    for (const [battleId, battle] of pendingBattles.entries()) {
        if (now - battle.timestamp > LINK_PAIR_TIMEOUT) {
            console.log(`[TIMEOUT] Battle ${battleId} link pair timeout. Releasing combo.`);
            if (battle.combo && activeCombos.has(battle.combo.comboKey)) {
                activeCombos.delete(battle.combo.comboKey);
            }
            pendingBattles.delete(battleId);
        }
    }
}, 5000);

// ============================================
// BATTLE EXECUTION
// ============================================
async function executeBattle(battleId, challengerUrl, defenderUrl) {
    console.log(`[EXEC] [Battle #${battleId}] Initializing...`);
    const battleStartTime = Date.now();

    try {
        // Ready up both players
        console.log(`[EXEC] [Battle #${battleId}] [STEP 1/3] Readying players...`);
        const [challengerReady, defenderReady] = await Promise.all([
            readyUpPlayer(challengerUrl, 'Challenger', battleId),
            readyUpPlayer(defenderUrl, 'Defender', battleId)
        ]);

        if (!challengerReady || !defenderReady) {
            throw new Error('Failed to ready up both players');
        }

        console.log(`[EXEC] [Battle #${battleId}] ✓ Both players ready!`);
        await sleep(500);

        // Execute strike loops
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

    // Rest after battle
    console.log(`[EXEC] [Battle #${battleId}] Resting 5s before next battle...`);
    await sleep(5000);
}

// ============================================
// CHALLENGE LOOP (CHALLENGER CLIENT)
// ============================================
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

async function challengeLoop() {
    let challengeCount = 0;
    const totalCombos = OPPONENT_IDS.length * BEASTS.length;

    while (true) {
        try {
            const available = getAvailableCombos();

            if (available.length === 0) {
                console.log(`[QUEUE] All ${totalCombos} combos in battle. Waiting... (${activeCombos.size}/${totalCombos})`);
                await sleep(3000);
                continue;
            }

            const combo = available[Math.floor(Math.random() * available.length)];

            // Recovery failsafe - if battle link pair doesn't happen within timeout
            setTimeout(() => {
                const isFighting = Array.from(activeBattles.values()).some(b => b.combo === combo.comboKey);
                if (!isFighting && activeCombos.has(combo.comboKey)) {
                    console.log(`[RECOVERY] Missed battle links for ${combo.comboKey}. Releasing back to pool.`);
                    activeCombos.delete(combo.comboKey);
                }
            }, LINK_PAIR_TIMEOUT);

            lastSentCombo = combo;
            lastSentTime = Date.now();

            challengeCount++;

            // Send challenge
            await otakuGroup.sendStateTyping();
            await sleep(1500);

            const challengeCommand = `.beast challenge ${combo.opponentId} ${combo.beast}`;
            await otakuGroup.sendMessage(challengeCommand);

            console.log(`[SEND] Challenge #${challengeCount}: ${challengeCommand}`);
            console.log(`       [Queue: ${activeCombos.size}/${totalCombos} | Battles: ${activeBattles.size}]`);

            await otakuGroup.clearState();
            await sleep(3000);

        } catch (error) {
            console.error('[LOOP] Challenge loop error:', error.message);
            await sleep(5000);
        }
    }
}

// ============================================
// PLAYER READY & STRIKE LOOPS
// ============================================
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

            const beastsRes = await fetchWithTimeout(`${apiUrl}/beasts`, { headers, method: 'GET' });
            if (!beastsRes.ok) {
                throw new Error(`API returned status ${beastsRes.status}`);
            }

            const beastsData = await beastsRes.json();
            if (beastsData.beasts && beastsData.beasts.length > 0) {
                const randomBeast = beastsData.beasts[Math.floor(Math.random() * beastsData.beasts.length)];
                const selectRes = await fetchWithTimeout(`${apiUrl}/select-beast`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ beastQuery: randomBeast.cardId })
                });

                if (!selectRes.ok) {
                    throw new Error(`Failed to select beast - Status ${selectRes.status}`);
                }

                console.log(`[READY] [Battle #${battleId}] [${role}] ✓ Selected: ${randomBeast.name}`);
            } else {
                throw new Error('No beasts available');
            }
        }

        // Ready up
        const readyRes = await fetchWithTimeout(`${apiUrl}/ready`, {
            method: 'POST',
            headers,
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
            if (Date.now() - strikeStartTime > MAX_BATTLE_DURATION) {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] ⚠️  Max duration exceeded. Stopping.`);
                break;
            }

            const actionResponse = await fetchWithTimeout(`${apiUrl}/action`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ action: 'strike' })
            });

            if (!actionResponse.ok) {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] Server rejected (Status ${actionResponse.status})`);
                break;
            }

            const data = await actionResponse.json();
            if (data.error || data.status === 'error') {
                console.log(`[STRIKE] [Battle #${battleId}] [${role}] Battle ended`);
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
    console.log(`[STRIKE] [Battle #${battleId}] [${role}] Completed: ${strikeCount} strikes (${strikeDuration}s)`);
}

// ============================================
// INITIALIZE
// ============================================
console.log('\n🚀 Starting Beast Battle Bot - DUAL ACCOUNT\n');
console.log('Setup:');
console.log('  • Challenger (el): Sends challenges to group');
console.log('  • Defender (Atsuomi): Receives defender link via DM');
console.log('  • Both links paired automatically');
console.log('  • Battle execution starts when both ready\n');

clientChallenger.initialize();
clientDefender.initialize();
