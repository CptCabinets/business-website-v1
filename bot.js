const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7984886940:AAGZuGooTs2sQ_77x-85syrm-b-73UD_ro0';
const API_BASE = 'http://localhost:3000/api';
const OLLAMA_BASE = 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen2.5:7b-instruct';  // local, no API needed

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('🤖 AJ Cleaning Services Bot starting (fully local mode)...');

// ─── Booking API Helpers ─────────────────────────────────────────────────────

async function getCleaners() {
  const res = await axios.get(`${API_BASE}/cleaners`);
  return res.data;
}

async function getWeeklySchedule(date = today()) {
  const res = await axios.get(`${API_BASE}/schedule/week/${date}`);
  return res.data;
}

async function createBooking(data) {
  const res = await axios.post(`${API_BASE}/bookings`, data);
  return res.data;
}

async function getBookings(start, end) {
  const params = {};
  if (start) params.start_date = start;
  if (end) params.end_date = end;
  const res = await axios.get(`${API_BASE}/bookings`, { params });
  return res.data;
}

async function getWeeklyIncome(date = today()) {
  const res = await axios.get(`${API_BASE}/income/weekly/${date}`);
  return res.data;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function formatBooking(b) {
  const cleaners = b.assigned_cleaners || 'Unassigned';
  return `📍 *${b.customer_name}*\n` +
    `🏠 ${b.address}\n` +
    `📅 ${b.booking_date} at ${b.start_time || 'TBD'}\n` +
    `⏱ ${b.duration_hours}h | 👷 ${cleaners}\n` +
    `💰 €${b.price || 0} | ${b.status || 'confirmed'}`;
}

// ─── Local Voice Transcription (faster-whisper, no API) ──────────────────────

async function transcribeVoice(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  // Download audio
  const tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  const response = await axios({ url: fileUrl, method: 'GET', responseType: 'arraybuffer' });
  fs.writeFileSync(tmpPath, Buffer.from(response.data));

  // Transcribe using local faster-whisper
  const scriptPath = path.join(__dirname, 'transcribe.py');
  const { stdout } = await execFileAsync('python3', [scriptPath, tmpPath]);

  fs.unlink(tmpPath, () => {});
  return stdout.trim();
}

// ─── Local LLM Intent Parser (Ollama, no API) ────────────────────────────────

async function parseIntent(text, cleaners) {
  const cleanerNames = cleaners.map(c => c.name).join(', ');
  const prompt = `You are the scheduling assistant for AJ Cleaning Services in Cork, Ireland.
Available cleaners: ${cleanerNames}
Today's date: ${today()}

The user said: "${text}"

Parse this into a JSON action. Respond with ONLY valid JSON, no explanation, no markdown code blocks.

Possible actions:
1. {"action":"create_booking","customer_name":"","address":"","booking_date":"YYYY-MM-DD","start_time":"HH:MM","duration_hours":2,"num_cleaners":1,"price":0,"notes":"","cleaner_names":[]}
2. {"action":"list_bookings","date":"YYYY-MM-DD"}
3. {"action":"weekly_schedule"}
4. {"action":"weekly_income"}
5. {"action":"help"}
6. {"action":"unknown","message":"reason"}

Rules:
- Convert day names (Monday, Thursday etc.) to the correct upcoming YYYY-MM-DD date from today ${today()}
- Cleaner names must exactly match: ${cleanerNames}
- Default duration_hours: 2 if not mentioned
- Default price: 0 if not mentioned
- Return ONLY the JSON object, nothing else`;

  const res = await axios.post(`${OLLAMA_BASE}/api/generate`, {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.1 },
  });

  const raw = res.data.response.trim();

  try {
    // Strip accidental markdown fences
    const cleaned = raw.replace(/```json|```/g, '').trim();
    // Extract first JSON object found
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { action: 'unknown', message: raw };
  } catch {
    return { action: 'unknown', message: raw };
  }
}

// ─── Action Executor ─────────────────────────────────────────────────────────

async function executeAction(intent, cleaners) {
  switch (intent.action) {
    case 'create_booking': {
      const cleanerIds = (intent.cleaner_names || [])
        .map(name => cleaners.find(c => c.name.toLowerCase() === name.toLowerCase()))
        .filter(Boolean)
        .map(c => c.id);

      const booking = await createBooking({
        customer_name: intent.customer_name,
        address: intent.address,
        phone: '',
        email: '',
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
        `⏱ ${intent.duration_hours || 2}h | 👷 ${assigned}\n` +
        `💰 €${intent.price || 0}\n` +
        `📝 ${intent.notes || 'No notes'}\n` +
        `🔖 Booking ID: #${booking.id}`;
    }

    case 'list_bookings': {
      const bookings = await getBookings(intent.date, intent.date);
      if (!bookings.length) return `📋 No bookings for ${intent.date}.`;
      return `📋 *Bookings for ${intent.date}:*\n\n` +
        bookings.map(formatBooking).join('\n\n─────────\n\n');
    }

    case 'weekly_schedule': {
      const schedule = await getWeeklySchedule();
      if (!schedule.bookings.length) return `📅 No bookings this week.`;
      return `📅 *Week of ${schedule.week_start}:*\n\n` +
        schedule.bookings.map(formatBooking).join('\n\n─────────\n\n');
    }

    case 'weekly_income': {
      const income = await getWeeklyIncome();
      return `💰 *This Week:*\n` +
        `Bookings: ${income.total_bookings}\n` +
        `Hours: ${income.total_hours || 0}h\n` +
        `Income: €${(income.total_income || 0).toFixed(2)}`;
    }

    case 'help':
      return getHelpText();

    default:
      return `🤔 Didn't get that. Try:\n\n` +
        `• "Book Aisling for Thursday 10am at 5 Oak Street, 3 hours"\n` +
        `• "What's on today?"\n` +
        `• "Show this week's schedule"\n` +
        `• "What's the income this week?"\n\n` +
        `You can also send a voice note!`;
  }
}

function getHelpText() {
  return `🧹 *AJ Cleaning Services*\n\n` +
    `Just talk naturally or send a voice note!\n\n` +
    `*Examples:*\n` +
    `• "Book Aisling for tomorrow 9am, 14 Main St, 2hrs, €80"\n` +
    `• "What have we got today?"\n` +
    `• "Show this week's schedule"\n` +
    `• "What's the income this week?"\n\n` +
    `*/schedule* — Weekly rota\n` +
    `*/today* — Today's bookings\n` +
    `*/income* — This week's earnings`;
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

async function handleMessage(chatId, text) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    const cleaners = await getCleaners();
    const intent = await parseIntent(text, cleaners);
    const reply = await executeAction(intent, cleaners);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling message:', err.message);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Voice note
  if (msg.voice || msg.audio) {
    await bot.sendMessage(chatId, '🎤 Transcribing your voice note...');
    try {
      const fileId = (msg.voice || msg.audio).file_id;
      const text = await transcribeVoice(fileId);
      await bot.sendMessage(chatId, `💬 I heard: "_${text}_"`, { parse_mode: 'Markdown' });
      await handleMessage(chatId, text);
    } catch (err) {
      console.error('Voice error:', err.message);
      await bot.sendMessage(chatId, `❌ Voice error: ${err.message}`);
    }
    return;
  }

  if (!msg.text) return;

  const text = msg.text;

  if (text === '/start') {
    await bot.sendMessage(chatId,
      `👋 Hi! I'm the *AJ Cleaning Services* scheduling assistant.\n\n${getHelpText()}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  if (text === '/schedule') { await handleMessage(chatId, "show this week's schedule"); return; }
  if (text === '/today')    { await handleMessage(chatId, `what bookings are on today ${today()}`); return; }
  if (text === '/income')   { await handleMessage(chatId, "what is the income this week"); return; }
  if (text === '/help')     { await bot.sendMessage(chatId, getHelpText(), { parse_mode: 'Markdown' }); return; }

  await handleMessage(chatId, text);
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('✅ Bot running — fully local (Whisper + Ollama, zero API calls)');
