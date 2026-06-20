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

// Generate and display the QR code for WhatsApp login
client.on('qr', (qr) => {
    console.log('Scan this QR code in WhatsApp to log in:');
    qrcode.generate(qr, { small: true });
});

// Confirm when the client is successfully connected
client.on('ready', () => {
    console.log('WhatsApp Bot is ready and listening for trivia questions!');
});

// Listen for incoming messages
client.on('message', async (msg) => {
    // Check if the message matches the format of the trivia bot 
    // (e.g., contains "❓" or "⏱ You have")
    if (msg.body.includes('❓') && msg.body.includes('Question')) {
        console.log(`\nDetected Question:\n${msg.body}`);

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
                console.log(`Sending answer: ${answer}`);
                
                setTimeout(async () => {
                    await client.sendMessage(msg.from, answer);
                }, 500);
            }

        } catch (error) {
            console.error("Failed to fetch answer from Groq:", error.message);
        }
    }
});

// Start the client
client.initialize();
