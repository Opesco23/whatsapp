const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION LISTS ---
const OPPONENT_IDS = ['BM-KXU7QZ', 'BM-VB62DY'];
const BEASTS = ['Sybil', 'Rune', 'Goliath'];

// --- TIMEOUT SETTINGS ---
const FETCH_TIMEOUT = 15000; // 15 second timeout for fetch requests
const BATTLE_CHECK_INTERVAL = 2000; // Check battle status every 2 seconds
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
    authStrategy: new LocalAuth()
});

let otakuGroup = null;
let activeBattles = []; // List of active battle promises
let activeCombos = new Set(); // Track which opponent:beast combos are currently fighting
let battleInProgress = false; // Flag to ensure battles complete

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n--- Client is ready! ---');
    console.log(`\n🔧 SETUP:`);
    console.log(`   Opponents: ${OPPONENT_IDS.length} | Beasts: ${BEASTS.length}`);
    console.log(`   Total combos: ${OPPONENT_IDS.length * BEASTS.length}`);
    console.log(`   ✓ Running battle system with proper completion tracking\n`);

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

client.on('message', async (msg) => {
    if (msg.body.includes('Challenger:') && msg.body.includes('Defender:')) {

        const challengerMatch = msg.body.match(/Challenger:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);
        const defenderMatch = msg.body.match(/Defender:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);

        if (challengerMatch && defenderMatch) {
            const challengerUrl = challengerMatch[1];
            const defenderUrl = defenderMatch[1];

            console.log(`\n[BATTLE START] Battle captured! Active battles: ${activeBattles.length}`);

            // Create battle promise that MUST complete before marking done
            const battlePromise = executeBattle(challengerUrl, defenderUrl)
                .then(() => {
                    console.log(`[BATTLE END] ✓ Battle completed successfully`);
                })
                .catch((err) => {
                    console.error(`[BATTLE ERROR] Battle failed:`, err.message);
                })
                .finally(() => {
                    // Remove from active battles
                    activeBattles = activeBattles.filter(b => b !== battlePromise);
                    
                    // Release the combo
                    if (activeCombos.size > 0) {
                        console.log(`[CLEANUP] Released combos. Remaining active: ${activeCombos.size}`);
                    }
                    
                    console.log(`[STATUS] Active battles remaining: ${activeBattles.length}`);
                });

            activeBattles.push(battlePromise);
            console.log(`[TRACKING] Total concurrent battles: ${activeBattles.length}`);
        }
    }
});

/**
 * Execute a single battle from start to finish - MUST COMPLETE
 */
async function executeBattle(challengerUrl, defenderUrl) {
    console.log('[EXEC] Initializing Lobby Setup...');
    const battleStartTime = Date.now();

    try {
        // STEP 1: Ready up both players
        console.log('[EXEC] [STEP 1/3] Readying up players...');
        const [challengerReady, defenderReady] = await Promise.all([
            readyUpPlayer(challengerUrl, 'Challenger'),
            readyUpPlayer(defenderUrl, 'Defender')
        ]);

        if (!challengerReady || !defenderReady) {
            throw new Error('Failed to ready up both players');
        }

        console.log('[EXEC] ✓ Both players Ready!');
        await sleep(500);

        // STEP 2: Run both strike loops concurrently
        console.log('[EXEC] [STEP 2/3] Battle in progress...');
        await Promise.all([
            startStrikeLoop(challengerUrl, 'Challenger'),
            startStrikeLoop(defenderUrl, 'Defender')
        ]);

        const battleDuration = ((Date.now() - battleStartTime) / 1000).toFixed(1);
        console.log(`[EXEC] [STEP 3/3] ✓ Battle Concluded! (Duration: ${battleDuration}s)`);

    } catch (err) {
        const battleDuration = ((Date.now() - battleStartTime) / 1000).toFixed(1);
        console.error(`[EXEC] ❌ Error during battle sequence (${battleDuration}s):`, err.message);
        throw err;
    }

    // CRITICAL: Rest AFTER battle is fully done
    console.log('[EXEC] Resting 5s before next battle...');
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

    while (true) {
        try {
            const available = getAvailableCombos();

            if (available.length === 0) {
                // All combos are fighting - wait
                console.log(`[QUEUE] All ${OPPONENT_IDS.length * BEASTS.length} combos in battle. Waiting...`);
                await sleep(3000);
                continue;
            }

            // Pick random available combo
            const combo = available[Math.floor(Math.random() * available.length)];
            
            // Mark as active BEFORE sending challenge
            activeCombos.add(combo.comboKey);
            challengeCount++;

            // Send challenge with typing indicator
            await otakuGroup.sendStateTyping();
            await sleep(1500);
            
            const challengeCommand = `.beast challenge ${combo.opponentId} ${combo.beast}`;
            await otakuGroup.sendMessage(challengeCommand);
            
            const totalCombos = OPPONENT_IDS.length * BEASTS.length;
            console.log(`[SEND] Challenge #${challengeCount}: ${challengeCommand}`);
            console.log(`       [Queue: ${activeCombos.size}/${totalCombos} | Battles: ${activeBattles.length}]`);
            
            await otakuGroup.clearState();
            
            // Wait before next challenge
            await sleep(3000);

        } catch (error) {
            console.error('[LOOP] Challenge loop error:', error.message);
            await sleep(5000);
        }
    }
}

async function readyUpPlayer(webUrl, role) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
    };

    console.log(`[READY] [${role}] Starting setup...`);

    try {
        if (role === 'Defender') {
            console.log(`[READY] [${role}] Fetching available beasts...`);
            
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

                console.log(`[READY] [${role}] Selecting beast: ${randomBeast.name} (${selectedBeastId})`);

                const selectRes = await fetchWithTimeout(`${apiUrl}/select-beast`, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ beastQuery: selectedBeastId })
                });

                if (!selectRes.ok) {
                    throw new Error(`Failed to select beast - Status ${selectRes.status}`);
                }

                console.log(`[READY] [${role}] ✓ Beast locked in`);
            } else {
                throw new Error('No beasts found in defender deck');
            }
        }

        // Ready up
        console.log(`[READY] [${role}] Sending ready signal...`);
        const readyRes = await fetchWithTimeout(`${apiUrl}/ready`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({})
        });

        if (!readyRes.ok) {
            throw new Error(`Failed to ready up - Status ${readyRes.status}`);
        }

        console.log(`[READY] [${role}] ✓ Successfully readied up`);
        return true;

    } catch (error) {
        console.error(`[READY] [${role}] ❌ Setup failed:`, error.message);
        return false;
    }
}

async function startStrikeLoop(webUrl, role) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
    };

    let strikeCount = 0;
    const strikeStartTime = Date.now();

    console.log(`[STRIKE] [${role}] Strike loop started`);

    while (true) {
        try {
            // Safety: Don't let battle run forever
            if (Date.now() - strikeStartTime > MAX_BATTLE_DURATION) {
                console.log(`[STRIKE] [${role}] ⚠️  Max battle duration exceeded. Stopping.`);
                break;
            }

            const actionResponse = await fetchWithTimeout(`${apiUrl}/action`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ action: 'strike' })
            });

            if (!actionResponse.ok) {
                console.log(`[STRIKE] [${role}] Server rejected strike (Status ${actionResponse.status})`);
                break;
            }

            const data = await actionResponse.json();

            if (data.error || (data.status && data.status === 'error')) {
                console.log(`[STRIKE] [${role}] Battle ended: ${data.error || 'Game finished'}`);
                break;
            }

            strikeCount++;
            console.log(`[STRIKE] [${role}] Strike #${strikeCount} ✓`);

            await sleep(1500);

        } catch (error) {
            console.error(`[STRIKE] [${role}] ❌ Error:`, error.message);
            break;
        }
    }

    const strikeDuration = ((Date.now() - strikeStartTime) / 1000).toFixed(1);
    console.log(`[STRIKE] [${role}] Loop ended after ${strikeCount} strikes (${strikeDuration}s)`);
}

client.initialize();
