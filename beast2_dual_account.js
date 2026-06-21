const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION LISTS ---
const OPPONENT_IDS = ['BM-KXU7QZ'];
const BEASTS = ['Sybil', 'Rune', 'Goliath'];

// --- TIMEOUT SETTINGS ---
const FETCH_TIMEOUT = 15000;
const MAX_BATTLE_DURATION = 300000;
const LINK_PAIR_TIMEOUT = 40000; // 40 seconds to allow defender link to arrive

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// ============================================
// CLIENT 1: CHALLENGER (el)
// ============================================
const clientChallenger = new Client({
    authStrategy: new LocalAuth({ clientId: 'challenger' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// ============================================
// CLIENT 2: DEFENDER (Atsuomi)
// ============================================
const clientDefender = new Client({
    authStrategy: new LocalAuth({ clientId: 'defender' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let otakuGroup = null;
let activeBattles = new Map();
let activeCombos = new Set();
let battleIdCounter = 0;

let pendingChallengerLinks = new Map();
let pendingDefenderLinks = new Map();

// ============================================
// CHALLENGER CLIENT SETUP
// ============================================
clientChallenger.on('qr', (qr) => {
    console.log('\n[CHALLENGER QR] Scan this to log in as el:');
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
            console.log(`   ✓ CHALLENGER (el): Sending challenges & capturing challenger links`);
            console.log(`   ✓ DEFENDER (Atsuomi): Receiving defender links via DM\n`);

            challengeLoop();
        } else {
            console.log('❌ Error: Group "Phantom Troupe" not found.');
        }
    } catch (err) {
        console.error('Error fetching chats:', err);
    }
});

let lastSentCombo = null;
let lastSentTime = null;

function getBattleIdFromUrl(url) {
    const match = url.match(/\/battle\/([a-f0-9]+)\//);
    return match ? match[1] : null;
}

/**
 * CHALLENGER: Capture challenger link from group
 */
clientChallenger.on('message', async (msg) => {
    if (msg.isGroup && msg.body.includes('⚔️') && msg.body.includes('Challenger:') && msg.body.includes('https://quizmd.online/battle/')) {

        const challengerMatch = msg.body.match(/Challenger:\s*(https:\/\/quizmd\.online\/battle\/[^\s\n]+)/);

        if (challengerMatch && lastSentCombo && lastSentTime) {
            const challengerUrl = challengerMatch[1];
            const timeDiff = Date.now() - lastSentTime;
            const battleId = getBattleIdFromUrl(challengerUrl);

            if (timeDiff > LINK_PAIR_TIMEOUT) {
                console.log(`[WARNING] Challenger link arrived ${timeDiff}ms after challenge - might be stale, skipping`);
                return;
            }

            const combo = lastSentCombo;

            console.log(`\n[CHALLENGER] ✓ Captured challenger link for Battle: ${battleId}`);
            console.log(`             Combo: ${combo.comboKey}`);
            console.log(`             Time since challenge: ${timeDiff}ms`);

            pendingChallengerLinks.set(battleId, {
                challengerUrl,
                combo,
                timestamp: Date.now()
            });

            // Cleanup timeout
            setTimeout(() => {
                if (pendingChallengerLinks.has(battleId) && !pendingDefenderLinks.has(battleId)) {
                    console.log(`[TIMEOUT] No defender link for Battle ${battleId}. Releasing combo.`);
                    const c = pendingChallengerLinks.get(battleId);
                    if (c && activeCombos.has(c.combo.comboKey)) {
                        activeCombos.delete(c.combo.comboKey);
                    }
                    pendingChallengerLinks.delete(battleId);
                }
            }, LINK_PAIR_TIMEOUT);

            console.log(`[QUEUE] Waiting for defender link via DM... (Pending: ${pendingChallengerLinks.size})`);

            tryPairLinks(battleId);

            lastSentCombo = null;
            lastSentTime = null;
        }
    }
});

// ============================================
// DEFENDER CLIENT SETUP
// ============================================
clientDefender.on('qr', (qr) => {
    console.log('\n[DEFENDER QR] Scan this to log in as Atsuomi:');
    qrcode.generate(qr, { small: true });
});

clientDefender.on('ready', async () => {
    console.log('\n✓ DEFENDER CLIENT (Atsuomi) is ready!');
    console.log('   Listening for defender links in DMs...\n');
});

/**
 * DEFENDER: Capture defender link from DM
 */
clientDefender.on('message', async (msg) => {
    if (!msg.isGroup && msg.body.includes('🛡️') && msg.body.includes('defender link') && msg.body.includes('https://quizmd.online/battle/')) {

        const defenderMatch = msg.body.match(/https:\/\/quizmd\.online\/battle\/[^\s\n]+/);

        if (defenderMatch) {
            const defenderUrl = defenderMatch[0];
            const battleId = getBattleIdFromUrl(defenderUrl);

            console.log(`\n[DEFENDER] ✓ Captured defender link for Battle: ${battleId}`);
            console.log(`           From DM: ${msg.from}`);

            pendingDefenderLinks.set(battleId, {
                defenderUrl,
                timestamp: Date.now()
            });

            // Cleanup timeout
            setTimeout(() => {
                if (pendingDefenderLinks.has(battleId) && !pendingChallengerLinks.has(battleId)) {
                    console.log(`[TIMEOUT] No challenger link for Battle ${battleId}. Orphaned defender link.`);
                    pendingDefenderLinks.delete(battleId);
                }
            }, LINK_PAIR_TIMEOUT);

            console.log(`[QUEUE] Waiting for challenger link from group... (Pending: ${pendingDefenderLinks.size})`);

            tryPairLinks(battleId);
        }
    }
});

/**
 * Try to pair challenger and defender links
 */
function tryPairLinks(battleId) {
    const challenger = pendingChallengerLinks.get(battleId);
    const defender = pendingDefenderLinks.get(battleId);

    if (challenger && defender) {
        console.log(`\n[PAIR] ✓ Paired! Battle ${battleId} has both links`);
        console.log(`       Challenger: ${challenger.combo.comboKey}`);
        console.log(`       Time to pair: ${Date.now() - challenger.timestamp}ms`);

        pendingChallengerLinks.delete(battleId);
        pendingDefenderLinks.delete(battleId);

        startBattle(battleId, challenger.challengerUrl, defender.defenderUrl, challenger.combo);
    }
}

/**
 * Start battle after both links are paired
 */
function startBattle(battleId, challengerUrl, defenderUrl, combo) {
    const internalBattleId = ++battleIdCounter;

    console.log(`[BATTLE START] Battle #${internalBattleId} (Game: ${battleId})`);
    console.log(`               Combo: ${combo.comboKey}`);
    console.log(`               Active battles: ${activeBattles.size}`);

    const battlePromise = executeBattle(internalBattleId, challengerUrl, defenderUrl)
        .then(() => {
            console.log(`[BATTLE END] Battle #${internalBattleId} ✓ Completed successfully`);
        })
        .catch((err) => {
            console.error(`[BATTLE ERROR] Battle #${internalBattleId} failed:`, err.message);
        })
        .finally(() => {
            if (activeCombos.has(combo.comboKey)) {
                activeCombos.delete(combo.comboKey);
                const totalCombos = OPPONENT_IDS.length * BEASTS.length;
                console.log(`[CLEANUP] Released combo: ${combo.comboKey} | Remaining: ${activeCombos.size}/${totalCombos}`);
            }

            activeBattles.delete(internalBattleId);
            console.log(`[STATUS] Active battles remaining: ${activeBattles.size}`);
        });

    activeBattles.set(internalBattleId, { promise: battlePromise, combo: combo.comboKey });
}

/**
 * Execute battle
 */
async function executeBattle(battleId, challengerUrl, defenderUrl) {
    console.log(`[EXEC] [Battle #${battleId}] Initializing Lobby Setup...`);
    const battleStartTime = Date.now();

    try {
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

    console.log(`[EXEC] [Battle #${battleId}] Resting 5s before next battle...`);
    await sleep(5000);
}

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
 * Challenge loop - runs on CHALLENGER client
 */
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

            activeCombos.add(combo.comboKey);
            challengeCount++;

            setTimeout(() => {
                const isFighting = Array.from(activeBattles.values()).some(b => b.combo === combo.comboKey);
                if (!isFighting && activeCombos.has(combo.comboKey)) {
                    console.log(`[RECOVERY] Missed battle link pair for ${combo.comboKey}. Releasing back to pool.`);
                    activeCombos.delete(combo.comboKey);
                }
            }, LINK_PAIR_TIMEOUT);

            lastSentCombo = combo;
            lastSentTime = Date.now();

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

// ============================================
// INITIALIZE BOTH CLIENTS
// ============================================
console.log('\n🚀 Starting Beast Battle Bot with DUAL ACCOUNTS...\n');
clientChallenger.initialize();
clientDefender.initialize();
