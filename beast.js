const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// --- CONFIGURATION LISTS ---
// Add as many IDs and beasts as you want inside these brackets, wrapped in quotes and separated by commas.
const OPPONENT_IDS = ['BM-KXU7QZ', 'BM-VB62DY'];
const BEASTS = ['Sybil', 'Rune'];

// Helper function to create a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});
let otakuGroup = null; // We will store the group here so we can access it anywhere
let isBattling = false; // Flag to prevent multiple battles from running over each other

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n--- Client is ready! ---');

    try {
        await sleep(3000); // 3-second delay for encryption sync
        const chats = await client.getChats();
        otakuGroup = chats.find(chat => chat.isGroup && chat.name === 'Phantom Troupe');

        if (otakuGroup) {
            console.log('Group "Phantom Troupe" found! Starting the automated loop...');
            await triggerChallenge(otakuGroup); // Fire the very first challenge
        } else {
            console.log('Error: Group "Phantom Troupe" not found.');
        }
    } catch (err) {
        console.error('Error fetching chats:', err);
    }
});

client.on('message', async (msg) => {
    if (msg.body.includes('Challenger:') && msg.body.includes('Defender:')) {

        // If we are already fighting, ignore duplicate links so we don't crash
        if (isBattling) return;

        const challengerMatch = msg.body.match(/Challenger:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);
        const defenderMatch = msg.body.match(/Defender:\s*(https:\/\/quizmd\.online\/battle\/[^\s]+)/);

        if (challengerMatch && defenderMatch) {
            isBattling = true; // Lock the battle state

            const challengerUrl = challengerMatch[1];
            const defenderUrl = defenderMatch[1];

            console.log(`\n[SYS] Caught Links!`);
            console.log(`Challenger: ${challengerUrl}`);
            console.log(`Defender: ${defenderUrl}`);
            console.log('\nInitializing Lobby Setup...');

            try {
                const [challengerReady, defenderReady] = await Promise.all([
                    readyUpPlayer(challengerUrl, 'Challenger'),
                                                                           readyUpPlayer(defenderUrl, 'Defender')
                ]);

                if (challengerReady && defenderReady) {
                    console.log('\nBoth players are Ready! Initiating simultaneous strikes...');
                    await sleep(500);

                    // AWAIT BOTH LOOPS: The script pauses here until the battle is completely finished
                    await Promise.all([
                        startStrikeLoop(challengerUrl, 'Challenger'),
                                      startStrikeLoop(defenderUrl, 'Defender')
                    ]);

                    console.log('\n--- Battle Concluded! ---');
                } else {
                    console.log('\nFailed to ready up both players. Aborting this match.');
                }
            } catch (err) {
                console.error('\nError during the battle sequence:', err.message);
            }

            // --- BATTLE IS OVER, PREPARE NEXT ROUND ---
            isBattling = false; // Unlock the state for the next battle

            console.log('\nResting for 5 seconds to prevent rate-limits...');
            await sleep(5000);

            if (otakuGroup) {
                console.log('Initiating the next challenge...');
                await triggerChallenge(otakuGroup); // Loop repeats!
            }
        }
    }
});

/**
 * Reusable function to send the challenge sequence with dynamic targets
 */
async function triggerChallenge(group) {
    try {
        console.log('Preparing to send challenge...');
        await group.sendStateTyping();
        await sleep(2000);

        // Pick a random ID and random Beast from our lists
        const randomId = OPPONENT_IDS[Math.floor(Math.random() * OPPONENT_IDS.length)];
        const randomBeast = BEASTS[Math.floor(Math.random() * BEASTS.length)];

        // Construct the final string
        const challengeCommand = `.beast challenge ${randomId} ${randomBeast}`;

        await group.sendMessage(challengeCommand);

        console.log(`Challenge sent: ${challengeCommand}`);
        await group.clearState();
    } catch (error) {
        console.error('Failed to trigger challenge:', error.message);
    }
}

async function readyUpPlayer(webUrl, role) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    try {
        if (role === 'Defender') {
            console.log(`[Defender] Fetching available beasts...`);
            const beastsRes = await fetch(`${apiUrl}/beasts`, { headers });

            if (!beastsRes.ok) throw new Error('Failed to fetch beasts API');

            const beastsData = await beastsRes.json();

            if (beastsData.beasts && beastsData.beasts.length > 0) {
                // 1. Generate a random number between 0 and the total number of beasts they own
                const randomIndex = Math.floor(Math.random() * beastsData.beasts.length);

                // 2. Select the random beast using that index
                const randomBeast = beastsData.beasts[randomIndex];
                const selectedBeastId = randomBeast.cardId;

                console.log(`[Defender] Locking in beast: ${randomBeast.name} (${selectedBeastId})`);

                const selectRes = await fetch(`${apiUrl}/select-beast`, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ beastQuery: selectedBeastId })
                });

                if (!selectRes.ok) {
                    console.log(`[Defender] Failed to select beast. Status: ${selectRes.status}`);
                    return false;
                }
            } else {
                console.log(`[Defender] No beasts found in defender's deck!`);
                return false;
            }
        }

        const readyRes = await fetch(`${apiUrl}/ready`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({})
        });

        if (readyRes.ok) {
            console.log(`[${role}] successfully readied up.`);
            return true;
        } else {
            console.log(`[${role}] Failed to ready up. Status: ${readyRes.status}`);
            return false;
        }
    } catch (error) {
        console.error(`[${role}] Connection error during setup:`, error.message);
        return false;
    }
}

async function startStrikeLoop(webUrl, role) {
    const apiUrl = webUrl.replace('https://quizmd.online/battle/', 'https://quizmd.online/api/battle/');
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://quizmd.online',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    let attempt = 1;
    while (true) {
        try {
            const actionResponse = await fetch(`${apiUrl}/action`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ action: 'strike' })
            });

            if (!actionResponse.ok) {
                console.log(`[${role}] Server rejected strike with status ${actionResponse.status}. Battle over.`);
                break;
            }

            const data = await actionResponse.json();

            if (data.error || (data.status && data.status === 'error')) {
                console.log(`[${role}] Strike rejected: ${data.error || 'Game Ended'}. Stopping loop.`);
                break;
            }

            console.log(`[${role}] Strike #${attempt} executed successfully!`);
            attempt++;

            await sleep(1500);

        } catch (error) {
            console.error(`[${role}] Connection error during strike loop:`, error.message);
            break;
        }
    }
}

client.initialize();
