const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7984886940:AAGZuGooTs2sQ_77x-85syrm-b-73UD_ro0';
const API_BASE = 'http://localhost:3000/api';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

console.log('🤖 AJ Cleaning Services Bot starting...');

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getCleaners() {
  const res = await axios.get(`${API_BASE}/cleaners`);
  return res.data;
}

async function getWeeklySchedule(date = new Date().toISOString().split('T')[0]) {
  const res = await axios.get(`${API_BASE}/schedule/week/${date}`);
  return res.data;
}

async function createBooking(data) {
  const res = await axios.post(`${API_BASE}/bookings`, data);
  return res.data;
}

async function updateBooking(id, data) {
  const res = await axios.put(`${API_BASE}/bookings/${id}`, data);
  return res.data;
}

async function getBookings(start, end) {
  const params = {};
  if (start) params.start_date = start;
  if (end) params.end_date = end;
  const res = await axios.get(`${API_BASE}/bookings`, { params });
  return res.data;
}

async function getWeeklyIncome(date = new Date().toISOString().split('T')[0]) {
  const res = await axios.get(`${API_BASE}/income/weekly/${date}`);
  return res.data;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function formatBooking(b) {
  const cleaners = b.assigned_cleaners || b.cleaners?.map(c => c.name).join(', ') || 'Unassigned';
  return `📍 *${b.customer_name}*\n` +
    `🏠 ${b.address}\n` +
    `📅 ${b.booking_date} at ${b.start_time || 'TBD'}\n` +
    `⏱ ${b.duration_hours}h | 👷 ${cleaners}\n` +
    `💰 €${b.price || 0} | Status: ${b.status || 'confirmed'}`;
}

// ─── Voice Transcription (via Gemini multimodal) ─────────────────────────────

async function transcribeVoice(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  // Download audio file to buffer
  const response = await axios({ url: fileUrl, method: 'GET', responseType: 'arraybuffer' });
  const audioBuffer = Buffer.from(response.data);
  const base64Audio = audioBuffer.toString('base64');

  // Use Gemini multimodal to transcribe
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: 'audio/ogg',
        data: base64Audio,
      },
    },
    'Transcribe exactly what is said in this audio. Return only the spoken words, nothing else.',
  ]);

  return result.response.text().trim();
}

// ─── AI Intent Parser ────────────────────────────────────────────────────────

async function parseIntent(text, cleaners) {
  const cleanerNames = cleaners.map(c => c.name).join(', ');
  const prompt = `You are the AI assistant for AJ Cleaning Services in Cork, Ireland.
Available cleaners: ${cleanerNames}
Today's date: ${today()}

The user said: "${text}"

Parse this into a JSON action. Respond ONLY with valid JSON, no markdown, no explanation.

Possible actions:
1. create_booking: { "action": "create_booking", "customer_name": "", "address": "", "booking_date": "YYYY-MM-DD", "start_time": "HH:MM", "duration_hours": 2, "num_cleaners": 1, "price": 0, "notes": "", "cleaner_names": [] }
2. list_bookings: { "action": "list_bookings", "date": "YYYY-MM-DD" } (use today if not specified)
3. weekly_schedule: { "action": "weekly_schedule" }
4. weekly_income: { "action": "weekly_income" }
5. help: { "action": "help" }
6. unknown: { "action": "unknown", "message": "what you couldn't understand" }

Rules:
- If a day name is mentioned (e.g. "Thursday"), convert to the correct upcoming YYYY-MM-DD date
- Cleaner names must match available cleaners exactly
- Default duration is 2 hours if not specified
- Default num_cleaners is 1 unless multiple are mentioned
- If price not mentioned, set to 0`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  try {
    // Strip any accidental markdown
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { action: 'unknown', message: raw };
  }
}

// ─── Action Executor ─────────────────────────────────────────────────────────

async function executeAction(intent, cleaners) {
  switch (intent.action) {
    case 'create_booking': {
      // Resolve cleaner names to IDs
      const cleanerIds = (intent.cleaner_names || [])
        .map(name => cleaners.find(c => c.name.toLowerCase() === name.toLowerCase()))
        .filter(Boolean)
        .map(c => c.id);

      const booking = await createBooking({
        customer_name: intent.customer_name,
        address: intent.address,
        phone: intent.phone || '',
        email: intent.email || '',
        booking_date: intent.booking_date,
        start_time: intent.start_time || '09:00',
        duration_hours: intent.duration_hours || 2,
        num_cleaners: intent.num_cleaners || 1,
        price: intent.price || 0,
        notes: intent.notes || '',
        cleaner_ids: cleanerIds,
      });

      const assigned = (intent.cleaner_names || []).join(', ') || 'Unassigned';
      return `✅ *Booking Created!*\n\n` +
        `👤 ${intent.customer_name}\n` +
        `🏠 ${intent.address}\n` +
        `📅 ${intent.booking_date} at ${intent.start_time || '09:00'}\n` +
        `⏱ ${intent.duration_hours || 2} hours\n` +
        `👷 ${assigned}\n` +
        `💰 €${intent.price || 0}\n` +
        `📝 ${intent.notes || 'No notes'}\n\n` +
        `Booking ID: #${booking.id}`;
    }

    case 'list_bookings': {
      const bookings = await getBookings(intent.date, intent.date);
      if (!bookings.length) return `📋 No bookings found for ${intent.date}.`;
      return `📋 *Bookings for ${intent.date}:*\n\n` +
        bookings.map(formatBooking).join('\n\n─────────────\n\n');
    }

    case 'weekly_schedule': {
      const schedule = await getWeeklySchedule();
      if (!schedule.bookings.length) return `📅 No bookings this week.`;
      return `📅 *Week of ${schedule.week_start}:*\n\n` +
        schedule.bookings.map(formatBooking).join('\n\n─────────────\n\n');
    }

    case 'weekly_income': {
      const income = await getWeeklyIncome();
      return `💰 *This Week's Summary:*\n\n` +
        `Bookings: ${income.total_bookings}\n` +
        `Total Hours: ${income.total_hours || 0}h\n` +
        `Total Income: €${(income.total_income || 0).toFixed(2)}`;
    }

    case 'help':
      return getHelpText();

    default:
      return `🤔 I didn't quite get that. Try something like:\n\n` +
        `• "Book Mary for Thursday 10am at 5 Oak Street, 3 hours"\n` +
        `• "What's on today?"\n` +
        `• "Show this week's schedule"\n` +
        `• "What's this week's income?"\n\n` +
        `You can also send a voice note!`;
  }
}

function getHelpText() {
  return `🧹 *AJ Cleaning Services Bot*\n\n` +
    `I can help you manage your cleaning schedule. Just talk to me naturally — or send a voice note!\n\n` +
    `*Examples:*\n` +
    `• "Book Aisling for tomorrow at 9am, 14 Main Street, 2 hours, €80"\n` +
    `• "What bookings do we have today?"\n` +
    `• "Show this week's schedule"\n` +
    `• "What's the income this week?"\n\n` +
    `*/schedule* — This week's rota\n` +
    `*/today* — Today's bookings\n` +
    `*/income* — This week's earnings`;
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

async function handleMessage(chatId, text) {
  try {
    const cleaners = await getCleaners();
    const intent = await parseIntent(text, cleaners);
    const reply = await executeAction(intent, cleaners);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling message:', err.message);
    await bot.sendMessage(chatId, `❌ Something went wrong: ${err.message}`);
  }
}

// Text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.voice || msg.audio) {
    await bot.sendMessage(chatId, '🎤 Got your voice note, transcribing...');
    try {
      const fileId = (msg.voice || msg.audio).file_id;
      const text = await transcribeVoice(fileId);
      await bot.sendMessage(chatId, `💬 I heard: "_${text}_"`, { parse_mode: 'Markdown' });
      await handleMessage(chatId, text);
    } catch (err) {
      console.error('Transcription error:', err.message);
      await bot.sendMessage(chatId, `❌ Couldn't transcribe that: ${err.message}`);
    }
    return;
  }

  if (!msg.text) return;

  const text = msg.text;

  // Commands
  if (text === '/start') {
    await bot.sendMessage(chatId, 
      `👋 Hello! I'm the *AJ Cleaning Services* scheduling assistant.\n\n` +
      `Just tell me what you need — or send a voice note!\n\n` +
      getHelpText(),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '/schedule') {
    await handleMessage(chatId, 'Show this week\'s schedule');
    return;
  }

  if (text === '/today') {
    await handleMessage(chatId, `What bookings do we have today ${today()}`);
    return;
  }

  if (text === '/income') {
    await handleMessage(chatId, 'What is the income this week');
    return;
  }

  if (text === '/help') {
    await bot.sendMessage(chatId, getHelpText(), { parse_mode: 'Markdown' });
    return;
  }

  // Natural language
  await handleMessage(chatId, text);
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('✅ Bot is running and listening for messages');
