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
const { getUserState, updateUserState, getTicket, updateTicket, resetTicket, setOverwriteData } = require('./database');
const { analyzeTicket, analyzeImage, analyzeAudio } = require('./gemini');
const { writeToSheet, getExistingData } = require('./sheets');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Anti-spam : éviter les doubles clics
const processingUsers = new Set();

// ========== CONSTANTES ==========
const MIN_YEAR = 2024;
const MAX_YEAR = 2027;
const MAX_AMOUNT = 50000;

// ========== UTILITAIRES ==========

function formatDateFR(dateStr) {
  const date = new Date(dateStr);
  const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  return date.toLocaleDateString('fr-FR', options);
}

function formatMontant(montant) {
  return montant.toLocaleString('fr-FR') + '€';
}

// Parser les dates relatives (hier, demain, etc.)
function parseRelativeDate(text) {
  const today = new Date();
  const lowerText = text.toLowerCase().trim();
  
  if (lowerText === 'hier') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return { date: yesterday.toISOString().split('T')[0], isRelative: true, label: 'hier' };
  }
  
  if (lowerText === 'demain') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { date: tomorrow.toISOString().split('T')[0], isRelative: true, label: 'demain' };
  }
  
  if (lowerText === "aujourd'hui" || lowerText === 'aujourdhui' || lowerText === 'today') {
    return { date: today.toISOString().split('T')[0], isRelative: true, label: "aujourd'hui" };
  }
  
  // Avant-hier
  if (lowerText === 'avant-hier' || lowerText === 'avant hier') {
    const beforeYesterday = new Date(today);
    beforeYesterday.setDate(beforeYesterday.getDate() - 2);
    return { date: beforeYesterday.toISOString().split('T')[0], isRelative: true, label: 'avant-hier' };
  }
  
  return null;
}

// Valider une date
function validateDate(dateStr) {
  const date = new Date(dateStr);
  
  if (isNaN(date.getTime())) {
    return { valid: false, error: "❌ Cette date n'est pas valide." };
  }
  
  const year = date.getFullYear();
  
  if (year < MIN_YEAR) {
    return { valid: false, error: `❌ Année trop ancienne. Minimum : ${MIN_YEAR}` };
  }
  
  if (year > MAX_YEAR) {
    return { valid: false, error: `❌ Année trop loin dans le futur. Maximum : ${MAX_YEAR}` };
  }
  
  // Vérifier que le jour existe (ex: 30 février)
  const day = date.getDate();
  const month = date.getMonth();
  const testDate = new Date(year, month, day);
  if (testDate.getMonth() !== month) {
    return { valid: false, error: "❌ Cette date n'existe pas." };
  }
  
  return { valid: true };
}

// Valider les montants
function validateAmounts(ticket) {
  const warnings = [];
  const errors = [];
  
  // Vérifier les montants négatifs
  if (ticket.cb < 0) errors.push("CB ne peut pas être négatif");
  if (ticket.espece < 0) errors.push("Espèces ne peut pas être négatif");
  if (ticket.ticket_restaurant < 0) errors.push("TR ne peut pas être négatif");
  if (ticket.depense < 0) errors.push("Dépense ne peut pas être négatif");
  if (ticket.total_declare < 0) errors.push("Total déclaré ne peut pas être négatif");
  
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }
  
  // Vérifier les montants énormes
  if (ticket.cb > MAX_AMOUNT) warnings.push(`CB très élevé : ${formatMontant(ticket.cb)}`);
  if (ticket.espece > MAX_AMOUNT) warnings.push(`Espèces très élevé : ${formatMontant(ticket.espece)}`);
  if (ticket.total_reel > MAX_AMOUNT * 2) warnings.push(`Total réel très élevé : ${formatMontant(ticket.total_reel)}`);
  
  // Vérifier si total déclaré > total réel
  if (ticket.total_declare > ticket.total_reel) {
    warnings.push(`⚠️ Total déclaré (${formatMontant(ticket.total_declare)}) > Total réel (${formatMontant(ticket.total_reel)})`);
  }
  
  // Vérifier si tout est à zéro
  if (ticket.cb === 0 && ticket.espece === 0 && ticket.ticket_restaurant === 0 && ticket.depense === 0) {
    warnings.push("Tous les montants sont à 0");
  }
  
  return { valid: true, errors: [], warnings };
}

// ========== HANDLERS ==========

// Message d'accueil
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'toi';
  
  await updateUserState(chatId, 'idle');
  await resetTicket(chatId);
  
  const welcomeMsg = `Salut *${firstName}* ! 👋\n\nOn fait quoi aujourd'hui ?`;
  
  bot.sendMessage(chatId, welcomeMsg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🍽️ Envoyer la recette du jour', callback_data: 'new_ticket' }
      ]]
    }
  });
});

// Gestion des boutons
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const firstName = query.from.first_name || 'toi';
  
  // Anti-spam : éviter les doubles clics
  if (processingUsers.has(chatId)) {
    bot.answerCallbackQuery(query.id, { text: '⏳ Doucement, je traite ta demande...' });
    return;
  }
  
  processingUsers.add(chatId);
  bot.answerCallbackQuery(query.id);
  
  try {
    // Nouveau ticket
    if (data === 'new_ticket') {
      await updateUserState(chatId, 'waiting_input');
      await resetTicket(chatId);
      bot.sendMessage(chatId, 
        '📝 *Envoie-moi la recette :*\n\n' +
        '📸 Photo du ticket\n' +
        '🎤 Message vocal\n' +
        '✍️ Ou écris les montants\n\n' +
        '_💡 Astuce : Envoie l\'image en fichier pour une meilleure qualité !_',
        { parse_mode: 'Markdown' }
      );
    }
    
    // Confirmation date relative
    if (data === 'DATE_RELATIVE_OK') {
      await showRecap(chatId);
    }
    
    // Utiliser aujourd'hui
    if (data === 'DATE_TODAY') {
      const ticket = await getTicket(chatId);
      ticket.date = new Date().toISOString().split('T')[0];
      await updateTicket(chatId, ticket);
      await showRecap(chatId);
    }
    
    // Corriger la date
    if (data === 'DATE_FIX') {
      await updateUserState(chatId, 'awaiting_date');
      bot.sendMessage(chatId, '📅 Envoie la bonne date :\n\n• _JJ/MM_ (ex: 15/01)\n• _JJ/MM/AAAA_ (ex: 15/01/2026)', { parse_mode: 'Markdown' });
    }
    
    // Date future/passée OK
    if (data === 'DATE_FUTURE_OK' || data === 'DATE_PAST_OK') {
      await showRecap(chatId);
    }
    
    // Envoyer en compta (vérifier overwrite)
    if (data === 'confirm_send') {
      await checkOverwriteAndSend(chatId);
    }
    
    // Confirmer l'overwrite
    if (data === 'confirm_overwrite') {
      await sendToSheet(chatId);
    }
    
    // Annuler l'overwrite
    if (data === 'cancel_overwrite') {
      bot.sendMessage(chatId, '❌ Envoi annulé. La recette existante n\'a pas été modifiée.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Modifier la date', callback_data: 'modify_date' }],
            [{ text: '🍽️ Nouvelle recette', callback_data: 'new_ticket' }]
          ]
        }
      });
      await updateUserState(chatId, 'idle');
    }
    
    // Modifier les montants
    if (data === 'modify') {
      await updateUserState(chatId, 'modifying');
      bot.sendMessage(chatId, 
        '✏️ *Que veux-tu modifier ?*\n\n' +
        'Exemples :\n' +
        '• _"CB 1200"_\n' +
        '• _"ESP 500"_\n' +
        '• _"TR déclaré 50"_\n' +
        '• _"dépense déclarée 20"_\n' +
        '• _"total déclaré 1500"_',
        { parse_mode: 'Markdown' }
      );
    }
    
    // Modifier la date
    if (data === 'modify_date') {
      await updateUserState(chatId, 'awaiting_date');
      bot.sendMessage(chatId, '📅 Envoie la nouvelle date :\n\n• _JJ/MM_ (ex: 15/01)\n• _JJ/MM/AAAA_ (ex: 15/01/2026)\n• _hier_, _demain_', { parse_mode: 'Markdown' });
    }
    
    // Ignorer les avertissements et continuer
    if (data === 'ignore_warnings') {
      await showRecap(chatId);
    }

  } finally {
    processingUsers.delete(chatId);
  }
});

// Messages (texte, photo, audio, fichiers)
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const state = await getUserState(chatId);
  
  if (state === 'idle') return;
  
  bot.sendChatAction(chatId, 'typing');
  
  if (state === 'waiting_input') {
    await handleTicketInput(chatId, msg);
  } else if (state === 'awaiting_date') {
    await handleDateInput(chatId, msg.text);
  } else if (state === 'modifying') {
    await handleModification(chatId, msg.text);
  }
});

// ========== FONCTIONS PRINCIPALES ==========

async function handleTicketInput(chatId, msg) {
  try {
    let ticketData;
    
    // PHOTO (compressée par Telegram)
    if (msg.photo) {
      bot.sendMessage(chatId, '📸 Photo reçue, j\'analyse...');
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      try {
        ticketData = await analyzeImage(fileUrl);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Je n\'arrive pas à lire cette image.\n\n_Essaie d\'envoyer en meilleure qualité (fichier) ou écris les montants en texte._', { parse_mode: 'Markdown' });
        return;
      }
    }
    // DOCUMENT (fichier - peut être image ou audio en qualité originale)
    else if (msg.document) {
      const doc = msg.document;
      const mimeType = doc.mime_type || '';
      
      // Vérifier la taille (max 20MB pour Telegram)
      if (doc.file_size > 20 * 1024 * 1024) {
        bot.sendMessage(chatId, '❌ Fichier trop lourd (max 20MB). Réduis la taille ou envoie en texte.');
        return;
      }
      
      if (mimeType.startsWith('image/')) {
        bot.sendMessage(chatId, '📸 Image reçue (qualité originale), j\'analyse...');
        const file = await bot.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        
        try {
          ticketData = await analyzeImage(fileUrl);
        } catch (error) {
          bot.sendMessage(chatId, '❌ Je n\'arrive pas à lire cette image.\n\n_Essaie avec une photo plus nette ou écris les montants en texte._', { parse_mode: 'Markdown' });
          return;
        }
      }
      else if (mimeType.startsWith('audio/')) {
        bot.sendMessage(chatId, '🎤 Audio reçu, j\'analyse...');
        const file = await bot.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        
        try {
          ticketData = await analyzeAudio(fileUrl, mimeType);
        } catch (error) {
          bot.sendMessage(chatId, '❌ Je n\'arrive pas à comprendre cet audio.\n\n_Essaie de parler plus clairement ou écris les montants en texte._', { parse_mode: 'Markdown' });
          return;
        }
      }
      else {
        bot.sendMessage(chatId, '❌ Type de fichier non supporté.\n\nEnvoie une *image*, un *audio* ou du *texte*.', { parse_mode: 'Markdown' });
        return;
      }
    }
    // AUDIO / VOICE
    else if (msg.voice || msg.audio) {
      const audio = msg.voice || msg.audio;
      
      // Vérifier la durée (max 3 min = 180 sec)
      if (audio.duration && audio.duration > 180) {
        bot.sendMessage(chatId, '❌ Audio trop long (max 3 minutes). Fais un message plus court.');
        return;
      }
      
      bot.sendMessage(chatId, '🎤 Audio reçu, j\'analyse...');
      const file = await bot.getFile(audio.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      let mimeType = 'audio/ogg';
      if (msg.audio && msg.audio.mime_type) {
        mimeType = msg.audio.mime_type;
      }
      
      try {
        ticketData = await analyzeAudio(fileUrl, mimeType);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Je n\'arrive pas à comprendre cet audio.\n\n_Essaie de parler plus clairement ou écris les montants en texte._', { parse_mode: 'Markdown' });
        return;
      }
    }
    // TEXTE
    else if (msg.text) {
      ticketData = await analyzeTicket(msg.text);
    }
    else {
      bot.sendMessage(chatId, '❌ Format non supporté. Envoie du *texte*, une *photo* ou un *audio*.', { parse_mode: 'Markdown' });
      return;
    }
    
    // Valider les montants
    const amountValidation = validateAmounts(ticketData);
    
    if (!amountValidation.valid) {
      bot.sendMessage(chatId, '❌ *Erreur dans les montants :*\n\n' + amountValidation.errors.map(e => `• ${e}`).join('\n'), { parse_mode: 'Markdown' });
      return;
    }
    
    await updateTicket(chatId, ticketData);
    
    // Afficher les avertissements si présents
    if (amountValidation.warnings.length > 0) {
      bot.sendMessage(chatId, 
        '⚠️ *Attention :*\n\n' + amountValidation.warnings.map(w => `• ${w}`).join('\n') + '\n\n_Tu peux continuer ou modifier._',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Continuer quand même', callback_data: 'ignore_warnings' }],
              [{ text: '✏️ Modifier', callback_data: 'modify' }]
            ]
          }
        }
      );
      return;
    }
    
    await validateDateFlow(chatId, ticketData.date);
    
  } catch (error) {
    console.error('Erreur analyse:', error);
    bot.sendMessage(chatId, '❌ Erreur lors de l\'analyse.\n\n_Réessaie ou envoie en texte._', { parse_mode: 'Markdown' });
  }
}

async function validateDateFlow(chatId, dateStr) {
  const today = new Date().toISOString().split('T')[0];
  const ticketDate = dateStr || today;
  
  const ticket = await getTicket(chatId);
  ticket.date = ticketDate;
  await updateTicket(chatId, ticket);
  
  // Valider la date
  const dateValidation = validateDate(ticketDate);
  if (!dateValidation.valid) {
    bot.sendMessage(chatId, dateValidation.error + '\n\n_Envoie une date valide._', { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Utiliser aujourd\'hui', callback_data: 'DATE_TODAY' }],
          [{ text: '✏️ Entrer une autre date', callback_data: 'DATE_FIX' }]
        ]
      }
    });
    return;
  }
  
  if (ticketDate > today) {
    bot.sendMessage(chatId, 
      `📅 *Date dans le futur :*\n\n📆 *${formatDateFR(ticketDate)}*\n\n_Tu confirmes cette date ?_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui, c\'est correct', callback_data: 'DATE_FUTURE_OK' }],
            [{ text: '📅 Utiliser aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger la date', callback_data: 'DATE_FIX' }]
          ]
        }
      }
    );
  } else if (ticketDate < today) {
    bot.sendMessage(chatId,
      `📅 *Date passée :*\n\n📆 *${formatDateFR(ticketDate)}*\n\n_Tu veux modifier une ancienne recette ?_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui, c\'est correct', callback_data: 'DATE_PAST_OK' }],
            [{ text: '📅 Utiliser aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger la date', callback_data: 'DATE_FIX' }]
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
    `📊 *RÉCAPITULATIF*\n\n` +
    `📅 *${formatDateFR(t.date)}*\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `*💰 RÉEL*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💳 CB: *${formatMontant(t.cb)}*\n` +
    `💵 ESP: *${formatMontant(t.espece)}*\n` +
    `🎫 TR: *${formatMontant(t.ticket_restaurant)}*\n` +
    `📉 Dép: *${formatMontant(t.depense)}*\n` +
    `➡️ *Total: ${formatMontant(t.total_reel)}*\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `*📋 DÉCLARÉ*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💳 CB: *${formatMontant(cbDecl)}*\n` +
    `💵 ESP: *${formatMontant(espDecl)}*\n` +
    `🎫 TR: *${formatMontant(trDecl)}*\n` +
    `📉 Dép: *${formatMontant(depDecl)}*\n` +
    `➡️ *Total: ${formatMontant(t.total_declare)}*\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `⚖️ *Non déclaré: ${formatMontant(t.difference)}*`;
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Envoyer en compta !', callback_data: 'confirm_send' }],
        [{ text: '📅 Modifier la date', callback_data: 'modify_date' }, { text: '✏️ Modifier montants', callback_data: 'modify' }]
      ]
    }
  });
}

async function handleDateInput(chatId, dateText) {
  // Vérifier les dates relatives
  const relativeDate = parseRelativeDate(dateText);
  
  if (relativeDate) {
    const ticket = await getTicket(chatId);
    ticket.date = relativeDate.date;
    await updateTicket(chatId, ticket);
    
    // Demander confirmation pour date relative
    bot.sendMessage(chatId,
      `📅 Tu parles de *${relativeDate.label}* ?\n\n📆 *${formatDateFR(relativeDate.date)}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui, c\'est ça', callback_data: 'DATE_RELATIVE_OK' }],
            [{ text: '✏️ Non, autre date', callback_data: 'DATE_FIX' }]
          ]
        }
      }
    );
    return;
  }
  
  // Parser la date standard
  let date;
  
  if (dateText.includes('/')) {
    const parts = dateText.split('/');
    if (parts.length === 2) {
      const [d, m] = parts;
      const year = new Date().getFullYear();
      date = `${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    } else if (parts.length === 3) {
      const [d, m, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      date = `${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  } else {
    date = dateText;
  }
  
  // Valider la date
  const dateValidation = validateDate(date);
  if (!dateValidation.valid) {
    bot.sendMessage(chatId, dateValidation.error + '\n\n_Réessaie avec une date valide._', { parse_mode: 'Markdown' });
    return;
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
    
    // Valider les montants
    const amountValidation = validateAmounts(updated);
    
    if (!amountValidation.valid) {
      bot.sendMessage(chatId, '❌ *Erreur :*\n\n' + amountValidation.errors.map(e => `• ${e}`).join('\n'), { parse_mode: 'Markdown' });
      return;
    }
    
    await updateTicket(chatId, updated);
    await showRecap(chatId);
  } catch (error) {
    console.error('Erreur modification:', error);
    bot.sendMessage(chatId, '❌ Pas compris.\n\n_Exemple : "CB 1200" ou "TR déclaré 50"_', { parse_mode: 'Markdown' });
  }
}

async function checkOverwriteAndSend(chatId) {
  const ticket = await getTicket(chatId);
  
  try {
    // Vérifier si des données existent déjà pour cette date
    const existingData = await getExistingData(ticket.date);
    
    if (existingData && (existingData.cb > 0 || existingData.espece > 0)) {
      // Données existantes ! Demander confirmation
      await setOverwriteData(chatId, existingData);
      
      const message = 
        `⚠️ *ATTENTION !*\n\n` +
        `📅 *${formatDateFR(ticket.date)}* a déjà une recette :\n\n` +
        `*Ancienne recette :*\n` +
        `💳 CB: ${formatMontant(existingData.cb)} | 💵 ESP: ${formatMontant(existingData.espece)}\n` +
        `🎫 TR: ${formatMontant(existingData.ticket_restaurant)} | 📉 Dép: ${formatMontant(existingData.depense)}\n` +
        `➡️ Total déclaré: *${formatMontant(existingData.total_declare)}*\n\n` +
        `*Nouvelle recette :*\n` +
        `💳 CB: ${formatMontant(ticket.cb)} | 💵 ESP: ${formatMontant(ticket.espece)}\n` +
        `🎫 TR: ${formatMontant(ticket.ticket_restaurant)} | 📉 Dép: ${formatMontant(ticket.depense)}\n` +
        `➡️ Total déclaré: *${formatMontant(ticket.total_declare)}*\n\n` +
        `_Tu veux vraiment remplacer ?_`;
      
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Oui, remplacer', callback_data: 'confirm_overwrite' }],
            [{ text: '❌ Non, annuler', callback_data: 'cancel_overwrite' }]
          ]
        }
      });
    } else {
      // Pas de données existantes, envoyer directement
      await sendToSheet(chatId);
    }
  } catch (error) {
    console.error('Erreur vérification overwrite:', error);
    // En cas d'erreur, on envoie quand même
    await sendToSheet(chatId);
  }
}

async function sendToSheet(chatId) {
  try {
    const ticket = await getTicket(chatId);
    await writeToSheet(ticket);
    await updateUserState(chatId, 'idle');
    await resetTicket(chatId);
    
    bot.sendMessage(chatId, 
      `✅ *Ticket envoyé en compta !*\n\n📅 ${formatDateFR(ticket.date)}\n💰 Total déclaré : *${formatMontant(ticket.total_declare)}*`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🍽️ Nouvelle recette', callback_data: 'new_ticket' }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Erreur envoi Sheet:', error);
    bot.sendMessage(chatId, '❌ Erreur lors de l\'envoi.\n\n_Réessaie dans quelques instants._', { parse_mode: 'Markdown' });
  }
}

console.log('🤖 Bot démarré !');
