const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
require('dotenv').config();

// Initialize Groq client
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Initialize WhatsApp client with local authentication (saves session)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Configuration
const TARGET_GROUP_NAME = 'Phantom Troupe';
const QUIZ_CATEGORIES = ['anime', 'manga', 'tvshows', 'comics', 'flags', 'sports', 'novels', 'football'];
let targetGroupId = null;
let quizScheduled = false;
let isQuizActive = false;

// Generate and display the QR code for WhatsApp login
client.on('qr', (qr) => {
    console.log('Scan this QR code in WhatsApp to log in:');
    qrcode.generate(qr, { small: true });
});

// Confirm when the client is successfully connected
client.on('ready', async () => {
    console.log('✅ WhatsApp Bot is ready!');
    
    // Get all chats and find the target group
    const chats = await client.getChats();
    const targetChat = chats.find(chat => chat.name === TARGET_GROUP_NAME && chat.isGroup);
    
    if (targetChat) {
        targetGroupId = targetChat.id._serialized;
        console.log(`✅ Found target group: ${TARGET_GROUP_NAME}`);
        console.log(`📍 Group ID: ${targetGroupId}`);
        
        // Start automatic quiz scheduler
        if (!quizScheduled) {
            startQuizScheduler();
            quizScheduled = true;
        }
    } else {
        console.log(`⚠️ Group "${TARGET_GROUP_NAME}" not found!`);
        console.log('Available groups:');
        chats.filter(c => c.isGroup).forEach(c => console.log(`  - ${c.name}`));
    }
});

// Function to start the quiz scheduler
function startQuizScheduler() {
    console.log(`⏰ Quiz scheduler started! Quizzes will run back-to-back.`);
    
    // Run quiz immediately on startup
    triggerQuiz();
}

// Function to trigger a quiz in the target group
async function triggerQuiz() {
    if (!targetGroupId) {
        console.log('❌ Target group not found. Cannot trigger quiz.');
        return;
    }
    
    const randomCategory = QUIZ_CATEGORIES[Math.floor(Math.random() * QUIZ_CATEGORIES.length)];
    const quizCommand = `.quiz ${randomCategory}`;
    
    try {
        console.log(`\n🎮 Triggering quiz with category: ${randomCategory}`);
        isQuizActive = true;
        await client.sendMessage(targetGroupId, quizCommand);
    } catch (error) {
        console.error('❌ Failed to trigger quiz:', error.message);
    }
}

// Listen for incoming messages
client.on('message', async (msg) => {
    // Only process messages from the target group
    if (msg.from !== targetGroupId) {
        return;
    }
    
    // Check if the message matches the format of the trivia bot 
    // (e.g., contains "❓" or "Question")
    if (msg.body.includes('❓') && msg.body.includes('Question')) {
        console.log(`\n📨 Detected Question from ${TARGET_GROUP_NAME}:\n${msg.body}`);

        try {
            // Send the question to Groq's Llama 3.3 70b versatile model
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are an automated trivia solver playing a fast-paced chat game.
                        You will receive a math or trivia question, sometimes with multiple-choice options.
                        Your task is to output ONLY the final answer.
                        If it's an open-ended math question, output just the number.
                        If it's multiple choice, output the exact text of the correct option, NOT the option letter (e.g., output 'Shadow Clone' instead of 'A').
                        Do NOT include punctuation, explanations, introductory text, or the option letter itself.`
                    },
                    {
                        role: "user",
                        content: msg.body
                    }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.1,
                max_tokens: 15, // Slightly increased in case the text answer is long
            });

            const answer = chatCompletion.choices[0]?.message?.content?.trim();

            if (answer) {
                console.log(`✅ Generated answer: ${answer}`);
                
                // Add a small delay to avoid rate limiting
                setTimeout(async () => {
                    await client.sendMessage(msg.from, answer);
                    console.log(`📤 Answer sent to ${TARGET_GROUP_NAME}`);
                }, 500);
            }

        } catch (error) {
            console.error("❌ Failed to fetch answer from Groq:", error.message);
        }
    }
    
    // Detect quiz completion (when quiz results are shown)
    if (msg.body.includes('Quiz Complete') || msg.body.includes('Winner:') || msg.body.includes('Final Standings')) {
        console.log(`\n🏆 Quiz completed! Starting next quiz immediately...`);
        isQuizActive = false;
        
        // Small delay before starting next quiz
        setTimeout(() => {
            triggerQuiz();
        }, 2000);
    }
});

// Handle disconnection
client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp bot disconnected:', reason);
});

// Start the client
client.initialize();
