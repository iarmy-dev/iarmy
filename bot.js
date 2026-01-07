// Serveur HTTP pour Render
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log('🌐 Serveur HTTP démarré');
});

// bot.js - Bot Telegram principal pour IArmy Compta
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { getUserState, updateUserState, getTicket, updateTicket, resetTicket } = require('./database');
const { analyzeTicket } = require('./gemini');
const { writeToSheet } = require('./sheets');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Message d'accueil
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'toi';
  
  await updateUserState(chatId, 'idle');
  
  const welcomeMsg = `Salut ${firstName} ! 👋\n\nOn fait quoi aujourd'hui ?`;
  
  bot.sendMessage(chatId, welcomeMsg, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🍽️ Envoyer la recette d\'aujourd\'hui', callback_data: 'new_ticket' }
      ]]
    }
  });
});

// Gestion des boutons
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  bot.answerCallbackQuery(query.id);
  
  if (data === 'new_ticket') {
    await updateUserState(chatId, 'waiting_input');
    bot.sendMessage(chatId, 
      'Parfait 👍\n\n' +
      'Envoie-moi la recette :\n' +
      '📸 photo du ticket\n' +
      '🎤 audio\n' +
      '✍️ ou écris les montants\n\n' +
      '💡 Tu peux préciser :\n' +
      '• TR déclaré (si différent du TR réel)\n' +
      '• Dépense déclarée (si besoin)\n\n' +
      'Je m\'occupe du reste 🙂'
    );
  }
  
  if (data === 'DATE_TODAY') {
    const ticket = await getTicket(chatId);
    ticket.date = new Date().toISOString().split('T')[0];
    await updateTicket(chatId, ticket);
    await showRecap(chatId);
  }
  
  if (data.startsWith('DATE_')) {
    if (data === 'DATE_FUTURE_OK' || data === 'DATE_PAST_OK') {
      await showRecap(chatId);
    } else if (data === 'DATE_FUTURE_FIX' || data === 'DATE_PAST_FIX') {
      await updateUserState(chatId, 'awaiting_date');
      bot.sendMessage(chatId, '✏️ Envoie la bonne date (JJ/MM/AAAA ou AAAA-MM-JJ)');
    }
  }
  
  if (data === 'confirm_send') {
    await sendToSheet(chatId);
  }
  
  if (data === 'modify') {
    await updateUserState(chatId, 'modifying');
    bot.sendMessage(chatId, 
      '✏️ Dis-moi ce que tu veux modifier.\n\n' +
      'Ex:\n' +
      '• "CB 1200"\n' +
      '• "TR déclaré 50"\n' +
      '• "dépense déclarée 20"\n' +
      '• "date au 16/01"'
    );
  }
});

// Messages
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const state = await getUserState(chatId);
  
  bot.sendChatAction(chatId, 'typing');
  
  if (state === 'waiting_input') {
    await handleTicketInput(chatId, msg);
  } else if (state === 'awaiting_date') {
    await handleDateInput(chatId, msg.text);
  } else if (state === 'modifying') {
    await handleModification(chatId, msg.text);
  }
});

async function handleTicketInput(chatId, msg) {
  let inputText = msg.text || 'Photo/Audio reçu';
  
  try {
    const ticketData = await analyzeTicket(inputText);
    await updateTicket(chatId, ticketData);
    await validateDate(chatId, ticketData.date);
  } catch (error) {
    console.error('Erreur analyse:', error);
    bot.sendMessage(chatId, '❌ Erreur analyse. Réessaie.');
  }
}

async function validateDate(chatId, dateStr) {
  const today = new Date().toISOString().split('T')[0];
  const ticketDate = dateStr || today;
  
  const ticket = await getTicket(chatId);
  ticket.date = ticketDate;
  await updateTicket(chatId, ticket);
  
  if (ticketDate > today) {
    bot.sendMessage(chatId, 
      `⚠️ Date future: ${ticketDate}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger', callback_data: 'DATE_FUTURE_FIX' }],
            [{ text: '✅ OK', callback_data: 'DATE_FUTURE_OK' }]
          ]
        }
      }
    );
  } else if (ticketDate < today) {
    bot.sendMessage(chatId,
      `⚠️ Date passée: ${ticketDate}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger', callback_data: 'DATE_PAST_FIX' }],
            [{ text: '✅ OK', callback_data: 'DATE_PAST_OK' }]
          ]
        }
      }
    );
  } else {
    await showRecap(chatId);
  }
}

async function showRecap(chatId) {
  const t = await getTicket(chatId);
  await updateUserState(chatId, 'review');
  
  // Calculer ESP déclaré
  const cbDecl = t.cb;
  const trDecl = t.tr_declare !== undefined ? t.tr_declare : t.ticket_restaurant;
  const depDecl = t.dep_declare !== undefined ? t.dep_declare : 0;
  const espDecl = t.total_declare - cbDecl - trDecl - depDecl;
  
  const message = 
    `📊 *Récapitulatif*\n\n` +
    `📅 ${t.date}\n\n` +
    `*━━ RÉEL ━━*\n` +
    `💳 CB: ${t.cb}€\n` +
    `💵 ESP: ${t.espece}€\n` +
    `🎫 TR: ${t.ticket_restaurant}€\n` +
    `📉 Dép: ${t.depense}€\n` +
    `💰 *Total Réel: ${t.total_reel}€*\n\n` +
    `*━━ DÉCLARÉ ━━*\n` +
    `💳 CB: ${cbDecl}€\n` +
    `💵 ESP: ${espDecl}€\n` +
    `🎫 TR: ${trDecl}€\n` +
    `📉 Dép: ${depDecl}€\n` +
    `📥 *Total Déclaré: ${t.total_declare}€*\n\n` +
    `*━━ CONTRÔLE ━━*\n` +
    `⚖️ Non déclaré: ${t.difference}€`;
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Envoyer', callback_data: 'confirm_send' }],
        [{ text: '✏️ Modifier', callback_data: 'modify' }]
      ]
    }
  });
}

async function handleDateInput(chatId, dateText) {
  let date;
  if (dateText.includes('/')) {
    const parts = dateText.split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      date = `${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  } else {
    date = dateText;
  }
  
  const ticket = await getTicket(chatId);
  ticket.date = date;
  await updateTicket(chatId, ticket);
  await showRecap(chatId);
}

async function handleModification(chatId, text) {
  try {
    const ticket = await getTicket(chatId);
    const updated = await analyzeTicket(text, ticket);
    await updateTicket(chatId, updated);
    await showRecap(chatId);
  } catch (error) {
    console.error('Erreur modification:', error);
    bot.sendMessage(chatId, '❌ Pas compris. Réessaie.');
  }
}

async function sendToSheet(chatId) {
  try {
    const ticket = await getTicket(chatId);
    await writeToSheet(ticket);
    await updateUserState(chatId, 'idle');
    await resetTicket(chatId);
    
    bot.sendMessage(chatId, 
      '✅ Ticket envoyé dans Google Sheets !',
      { 
        reply_markup: {
          inline_keyboard: [[
            { text: '🍽️ Nouvelle recette', callback_data: 'new_ticket' }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Erreur envoi Sheet:', error);
    bot.sendMessage(chatId, '❌ Erreur envoi Sheet.');
  }
}

console.log('🤖 Bot démarré !');
