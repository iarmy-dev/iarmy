// ===========================================
// iArmy Telegram Bot
// ===========================================

const TelegramBot = require('node-telegram-bot-api');
const geminiService = require('../services/gemini');

let bot = null;
let supabase = null;
let sheetsService = null;

// ===========================================
// INIT
// ===========================================

function init(supabaseClient, sheets) {
  supabase = supabaseClient;
  sheetsService = sheets;
  
  // Initialize Gemini
  geminiService.init();
  
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  
  // Commands
  bot.onText(/\/start(.*)/, handleStart);
  bot.onText(/\/link (.+)/, handleLink);
  bot.onText(/\/aide/, handleHelp);
  bot.onText(/\/help/, handleHelp);
  bot.onText(/\/status/, handleStatus);
  
  // Photo messages (tickets de caisse)
  bot.on('photo', handlePhoto);
  
  // Voice messages
  bot.on('voice', handleVoice);
  
  // Text messages (for compta)
  bot.on('message', handleMessage);
  
  console.log('🤖 Telegram bot initialized');
}

// ===========================================
// HANDLERS
// ===========================================

// /start - Welcome message
async function handleStart(msg, match) {
  const chatId = msg.chat.id;
  const param = match[1]?.trim();
  
  // If there's a link code parameter
  if (param && param.startsWith('link_')) {
    const code = param.replace('link_', '');
    await linkWithCode(chatId, msg.from, code);
    return;
  }
  
  const welcomeMessage = `
🤖 *Bienvenue sur iArmy !*

Je suis ton assistant pour automatiser ta compta.

*Pour commencer :*
1. Crée un compte sur iarmy.fr
2. Configure ton bot Compta Express
3. Lie ton compte avec /link CODE

*Commandes :*
/link CODE - Lier ton compte
/status - Voir ton statut
/aide - Aide

Une fois lié, envoie simplement tes recettes :
\`cb 1200 esp 500 tr 150\`

Et c'est noté ! 📊
`;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// /link CODE - Link Telegram to account
async function handleLink(msg, match) {
  const chatId = msg.chat.id;
  const code = match[1]?.trim().toUpperCase();
  
  if (!code) {
    await bot.sendMessage(chatId, '❌ Utilise : /link TONCODE');
    return;
  }
  
  await linkWithCode(chatId, msg.from, code);
}

// Link with code
async function linkWithCode(chatId, telegramUser, code) {
  try {
    // Find user with this code
    const { data: profile, error: findError } = await supabase
      .from('profiles')
      .select('*')
      .eq('telegram_link_code', code)
      .gt('telegram_link_expires', new Date().toISOString())
      .single();
    
    if (findError || !profile) {
      await bot.sendMessage(chatId, '❌ Code invalide ou expiré. Génère un nouveau code sur iarmy.fr');
      return;
    }
    
    // Create telegram link
    const { error: linkError } = await supabase
      .from('telegram_links')
      .upsert({
        user_id: profile.id,
        telegram_user_id: telegramUser.id.toString(),
        telegram_username: telegramUser.username,
        telegram_chat_id: chatId.toString()
      }, { onConflict: 'telegram_user_id' });
    
    if (linkError) throw linkError;
    
    // Clear the code
    await supabase
      .from('profiles')
      .update({ telegram_link_code: null, telegram_link_expires: null })
      .eq('id', profile.id);
    
    // Update bot with chat_id
    await supabase
      .from('bots')
      .update({ telegram_chat_id: chatId.toString() })
      .eq('user_id', profile.id);
    
    await bot.sendMessage(chatId, `
✅ *Compte lié avec succès !*

Salut ${profile.name || 'boss'} ! 👋

Tu peux maintenant m'envoyer tes recettes :
\`cb 1200 esp 500 tr 150\`

Je m'occupe du reste 📊
`, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Error linking account:', error);
    await bot.sendMessage(chatId, '❌ Erreur lors de la liaison. Réessaie.');
  }
}

// /aide or /help
async function handleHelp(msg) {
  const chatId = msg.chat.id;
  
  const helpMessage = `
📖 *Aide iArmy*

*Commandes :*
/start - Démarrer
/link CODE - Lier ton compte
/status - Voir ton statut
/aide - Cette aide

*Envoyer une recette :*
Format : \`mot-clé montant\`

Exemples :
• \`cb 1200\` → Carte bleue
• \`esp 500\` → Espèces
• \`tr 150\` → Tickets resto
• \`cb 1200 esp 500 tr 150\` → Tout en une fois

*Mots-clés par défaut :*
cb, carte, bleue → Carte bleue
esp, espece, cash → Espèces
tr, ticket → Tickets resto

Tu peux personnaliser tes mots-clés sur iarmy.fr
`;
  
  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
}

// /status
async function handleStatus(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  
  try {
    // Check if linked
    const { data: link } = await supabase
      .from('telegram_links')
      .select('*, profiles(*)')
      .eq('telegram_user_id', telegramUserId)
      .single();
    
    if (!link) {
      await bot.sendMessage(chatId, '❌ Compte non lié. Utilise /link CODE pour lier ton compte.');
      return;
    }
    
    // Get bots
    const { data: bots } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', link.user_id)
      .eq('active', true);
    
    // Get today's entries
    const today = new Date().toISOString().split('T')[0];
    const { data: entries } = await supabase
      .from('entries')
      .select('*')
      .eq('user_id', link.user_id)
      .eq('date', today);
    
    const statusMessage = `
📊 *Statut de ton compte*

👤 *Compte :* ${link.profiles?.name || link.profiles?.email}
📱 *Telegram :* @${link.telegram_username || 'non défini'}
🤖 *Bots actifs :* ${bots?.length || 0}
📝 *Entrées aujourd'hui :* ${entries?.length || 0}

${bots?.length > 0 ? '✅ Prêt à recevoir tes recettes !' : '⚠️ Configure un bot sur iarmy.fr'}
`;
    
    await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Error getting status:', error);
    await bot.sendMessage(chatId, '❌ Erreur. Réessaie.');
  }
}

// Handle photo messages (ticket OCR)
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  
  try {
    // Check if user is linked
    const { data: link } = await supabase
      .from('telegram_links')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .single();
    
    if (!link) {
      await bot.sendMessage(chatId, '❌ Lie ton compte d\'abord avec /link CODE');
      return;
    }
    
    // Get active compta bot
    const { data: bots } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', link.user_id)
      .eq('module', 'compta')
      .eq('active', true);
    
    if (!bots || bots.length === 0) {
      await bot.sendMessage(chatId, '❌ Pas de bot Compta actif. Configure-le sur iarmy.fr');
      return;
    }
    
    await bot.sendMessage(chatId, '📸 Analyse du ticket en cours...');
    
    // Get photo file
    const photo = msg.photo[msg.photo.length - 1]; // Highest resolution
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // Analyze with Gemini
    const parsed = await geminiService.analyzeImage(fileUrl);
    
    if (!parsed || Object.keys(parsed).length === 0) {
      await bot.sendMessage(chatId, '❌ Je n\'ai pas pu lire le ticket. Réessaie avec une photo plus nette.');
      return;
    }
    
    // Save and respond
    await saveEntryAndRespond(chatId, link, bots[0], parsed, 'photo');
    
  } catch (error) {
    console.error('Error processing photo:', error);
    await bot.sendMessage(chatId, '❌ Erreur lors de l\'analyse. Réessaie.');
  }
}

// Handle voice messages
async function handleVoice(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  
  try {
    // Check if user is linked
    const { data: link } = await supabase
      .from('telegram_links')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .single();
    
    if (!link) {
      await bot.sendMessage(chatId, '❌ Lie ton compte d\'abord avec /link CODE');
      return;
    }
    
    // Get active compta bot
    const { data: bots } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', link.user_id)
      .eq('module', 'compta')
      .eq('active', true);
    
    if (!bots || bots.length === 0) {
      await bot.sendMessage(chatId, '❌ Pas de bot Compta actif. Configure-le sur iarmy.fr');
      return;
    }
    
    await bot.sendMessage(chatId, '🎤 Écoute en cours...');
    
    // Get voice file
    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // Analyze with Gemini
    const parsed = await geminiService.analyzeAudio(fileUrl, msg.voice.mime_type || 'audio/ogg');
    
    if (!parsed || Object.keys(parsed).length === 0) {
      await bot.sendMessage(chatId, '❌ Je n\'ai pas compris. Réessaie en parlant clairement.');
      return;
    }
    
    // Save and respond
    await saveEntryAndRespond(chatId, link, bots[0], parsed, 'voice');
    
  } catch (error) {
    console.error('Error processing voice:', error);
    await bot.sendMessage(chatId, '❌ Erreur lors de l\'analyse. Réessaie.');
  }
}

// Save entry and respond (shared function)
async function saveEntryAndRespond(chatId, link, comptaBot, parsed, source = 'text') {
  const today = new Date().toISOString().split('T')[0];
  
  // Save entry to database
  const { data: entry, error: entryError } = await supabase
    .from('entries')
    .insert({
      bot_id: comptaBot.id,
      user_id: link.user_id,
      date: today,
      data: parsed,
      raw_message: source
    })
    .select()
    .single();
  
  if (entryError) throw entryError;
  
  // Sync to Google Sheets if configured
  let sheetSynced = false;
  if (comptaBot.google_sheet_id && sheetsService) {
    try {
      await sheetsService.appendRow(comptaBot.google_sheet_id, today, parsed);
      sheetSynced = true;
      
      await supabase
        .from('entries')
        .update({ synced_to_sheet: true })
        .eq('id', entry.id);
    } catch (sheetError) {
      console.error('Error syncing to sheet:', sheetError);
    }
  }
  
  // Format response
  const summary = Object.entries(parsed)
    .map(([key, val]) => `${formatKeyword(key)}: ${val}€`)
    .join(' • ');
  
  const total = Object.values(parsed).reduce((a, b) => a + b, 0);
  
  const sourceEmoji = source === 'photo' ? '📸' : source === 'voice' ? '🎤' : '✉️';
  
  const response = `
✅ *C'est noté !* ${sourceEmoji}

${summary}
💰 *Total :* ${total}€

${sheetSynced ? '📊 Synchronisé avec Google Sheets' : ''}
`;
  
  await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
}

// Handle regular messages (compta entries)
async function handleMessage(msg) {
  // Ignore commands, photos, and voice (handled separately)
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;
  if (msg.photo || msg.voice) return;
  
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  const text = msg.text.toLowerCase().trim();
  
  try {
    // Check if user is linked
    const { data: link } = await supabase
      .from('telegram_links')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .single();
    
    if (!link) {
      // Don't spam non-linked users, only respond if it looks like a compta entry
      if (looksLikeComptaEntry(text)) {
        await bot.sendMessage(chatId, '❌ Lie ton compte d\'abord avec /link CODE');
      }
      return;
    }
    
    // Get active compta bot
    const { data: bots } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', link.user_id)
      .eq('module', 'compta')
      .eq('active', true);
    
    if (!bots || bots.length === 0) {
      if (looksLikeComptaEntry(text)) {
        await bot.sendMessage(chatId, '❌ Pas de bot Compta actif. Configure-le sur iarmy.fr');
      }
      return;
    }
    
    const comptaBot = bots[0];
    const config = comptaBot.config || {};
    
    // Parse the message
    const parsed = parseComptaMessage(text, config.keywords);
    
    if (!parsed || Object.keys(parsed).length === 0) {
      // Not a valid entry, ignore silently
      return;
    }
    
    // Save entry to database
    const today = new Date().toISOString().split('T')[0];
    
    const { data: entry, error: entryError } = await supabase
      .from('entries')
      .insert({
        bot_id: comptaBot.id,
        user_id: link.user_id,
        date: today,
        data: parsed,
        raw_message: msg.text
      })
      .select()
      .single();
    
    if (entryError) throw entryError;
    
    // Sync to Google Sheets if configured
    let sheetSynced = false;
    if (comptaBot.google_sheet_id && sheetsService) {
      try {
        await sheetsService.appendRow(comptaBot.google_sheet_id, today, parsed);
        sheetSynced = true;
        
        // Mark as synced
        await supabase
          .from('entries')
          .update({ synced_to_sheet: true })
          .eq('id', entry.id);
      } catch (sheetError) {
        console.error('Error syncing to sheet:', sheetError);
      }
    }
    
    // Format response
    const summary = Object.entries(parsed)
      .map(([key, val]) => `${formatKeyword(key)}: ${val}€`)
      .join(' • ');
    
    const total = Object.values(parsed).reduce((a, b) => a + b, 0);
    
    const response = `
✅ *C'est noté !*

${summary}
💰 *Total :* ${total}€

${sheetSynced ? '📊 Synchronisé avec Google Sheets' : ''}
`;
    
    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Error processing message:', error);
    await bot.sendMessage(chatId, '❌ Erreur. Réessaie.');
  }
}

// ===========================================
// HELPERS
// ===========================================

// Check if message looks like a compta entry
function looksLikeComptaEntry(text) {
  const keywords = ['cb', 'carte', 'esp', 'espece', 'cash', 'tr', 'ticket', 'cheque', 'virement'];
  const hasKeyword = keywords.some(kw => text.includes(kw));
  const hasNumber = /\d+/.test(text);
  return hasKeyword && hasNumber;
}

// Parse compta message
function parseComptaMessage(text, customKeywords = {}) {
  const result = {};
  
  // Default keyword mappings
  const keywordMap = {
    'cb': 'cb',
    'carte': 'cb',
    'bleue': 'cb',
    'esp': 'esp',
    'espece': 'esp',
    'espèce': 'esp',
    'especes': 'esp',
    'espèces': 'esp',
    'cash': 'esp',
    'liquide': 'esp',
    'tr': 'tr',
    'ticket': 'tr',
    'tickets': 'tr',
    'resto': 'tr',
    'cheque': 'cheque',
    'chèque': 'cheque',
    'virement': 'virement',
    'vir': 'virement',
    'dep': 'depenses',
    'depense': 'depenses',
    'dépense': 'depenses',
    ...customKeywords
  };
  
  // Pattern: keyword followed by number (with optional € or spaces)
  // Matches: "cb 1200", "cb1200", "cb: 1200", "1200 cb", "1200€ cb"
  
  // First try: keyword then number
  const pattern1 = /([a-zéèêë]+)\s*:?\s*(\d+(?:[.,]\d+)?)\s*€?/gi;
  let match;
  
  while ((match = pattern1.exec(text)) !== null) {
    const keyword = match[1].toLowerCase();
    const amount = parseFloat(match[2].replace(',', '.'));
    
    if (keywordMap[keyword] && amount > 0) {
      const normalizedKey = keywordMap[keyword];
      result[normalizedKey] = (result[normalizedKey] || 0) + amount;
    }
  }
  
  // Second try: number then keyword
  const pattern2 = /(\d+(?:[.,]\d+)?)\s*€?\s*([a-zéèêë]+)/gi;
  
  while ((match = pattern2.exec(text)) !== null) {
    const amount = parseFloat(match[1].replace(',', '.'));
    const keyword = match[2].toLowerCase();
    
    if (keywordMap[keyword] && amount > 0) {
      const normalizedKey = keywordMap[keyword];
      // Don't override if already set by pattern1
      if (!result[normalizedKey]) {
        result[normalizedKey] = amount;
      }
    }
  }
  
  return result;
}

// Format keyword for display
function formatKeyword(key) {
  const labels = {
    'cb': '💳 CB',
    'esp': '💵 Espèces',
    'tr': '🎫 TR',
    'cheque': '📝 Chèque',
    'virement': '🏦 Virement',
    'depenses': '📉 Dépenses'
  };
  return labels[key] || key.toUpperCase();
}

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  init,
  parseComptaMessage
};
