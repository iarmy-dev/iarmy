// Serveur HTTP pour Render
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log('🌐 Serveur HTTP démarré');
});

// bot.js - Bot Telegram IArmy Compta - Version App
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { getUserState, updateUserState, getTicket, updateTicket, resetTicket, setOverwriteData } = require('./database');
const { analyzeTicket, analyzeImage, analyzeAudio } = require('./gemini');
const { writeToSheet, getExistingData, getMonthRecap, deleteRecette, getSheetName } = require('./sheets');
const { generatePDF } = require('./pdf');

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

function formatDateShort(dateStr) {
  const date = new Date(dateStr);
  const options = { day: 'numeric', month: 'short' };
  return date.toLocaleDateString('fr-FR', options);
}

function formatMontant(montant) {
  if (montant === undefined || montant === null || isNaN(montant)) return '0€';
  return montant.toLocaleString('fr-FR') + '€';
}

function getMonthNameFR(month) {
  const months = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 
                  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  return months[month];
}

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
  if (lowerText === 'avant-hier' || lowerText === 'avant hier') {
    const beforeYesterday = new Date(today);
    beforeYesterday.setDate(beforeYesterday.getDate() - 2);
    return { date: beforeYesterday.toISOString().split('T')[0], isRelative: true, label: 'avant-hier' };
  }
  return null;
}

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
  const day = date.getDate();
  const month = date.getMonth();
  const testDate = new Date(year, month, day);
  if (testDate.getMonth() !== month) {
    return { valid: false, error: "❌ Cette date n'existe pas." };
  }
  return { valid: true };
}

function validateAmounts(ticket) {
  const warnings = [];
  const errors = [];
  
  if (ticket.cb < 0) errors.push("CB ne peut pas être négatif");
  if (ticket.espece < 0) errors.push("Espèces ne peut pas être négatif");
  if (ticket.ticket_restaurant < 0) errors.push("TR ne peut pas être négatif");
  if (ticket.depense < 0) errors.push("Dépense ne peut pas être négatif");
  if (ticket.total_declare < 0) errors.push("Total déclaré ne peut pas être négatif");
  
  if (errors.length > 0) return { valid: false, errors, warnings };
  
  if (ticket.cb > MAX_AMOUNT) warnings.push(`CB très élevé : ${formatMontant(ticket.cb)}`);
  if (ticket.espece > MAX_AMOUNT) warnings.push(`Espèces très élevé : ${formatMontant(ticket.espece)}`);
  if (ticket.total_reel > MAX_AMOUNT * 2) warnings.push(`Total réel très élevé : ${formatMontant(ticket.total_reel)}`);
  if (ticket.total_declare > ticket.total_reel) {
    warnings.push(`⚠️ Total déclaré > Total réel`);
  }
  if (ticket.cb === 0 && ticket.espece === 0 && ticket.ticket_restaurant === 0 && ticket.depense === 0) {
    warnings.push("Tous les montants sont à 0");
  }
  
  return { valid: true, errors: [], warnings };
}

// ========== MENU PRINCIPAL ==========

function showMainMenu(chatId, firstName = '') {
  const welcomeText = firstName ? `👋 *${firstName}*\n\n` : '';
  
  bot.sendMessage(chatId, 
    welcomeText + `🍽️ *IArmy Compta*\n\n_Que veux-tu faire ?_`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🍽️ Envoyer la recette du jour', callback_data: 'new_ticket' }],
          [{ text: '📊 Récap du mois', callback_data: 'month_recap' }],
          [{ text: '✏️ Modifier une recette', callback_data: 'modify_past' }, { text: '🗑️ Supprimer', callback_data: 'delete_past' }],
          [{ text: '📄 Générer PDF comptable', callback_data: 'generate_pdf' }],
          [{ text: '💰 Cumul non déclaré', callback_data: 'show_cumul' }],
          [{ text: '❓ Aide', callback_data: 'show_help' }]
        ]
      }
    }
  );
}

// ========== HANDLERS ==========

// Message d'accueil - /start uniquement pour la 1ère fois
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || '';
  
  await updateUserState(chatId, 'idle');
  await resetTicket(chatId);
  
  showMainMenu(chatId, firstName);
});

// Gestion des boutons
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const firstName = query.from.first_name || '';
  
  // Anti-spam
  if (processingUsers.has(chatId)) {
    bot.answerCallbackQuery(query.id, { text: '⏳ Doucement...' });
    return;
  }
  
  processingUsers.add(chatId);
  bot.answerCallbackQuery(query.id);
  
  try {
    // ===== MENU PRINCIPAL =====
    if (data === 'main_menu') {
      await updateUserState(chatId, 'idle');
      showMainMenu(chatId, firstName);
    }
    
    // ===== NOUVELLE RECETTE =====
    if (data === 'new_ticket') {
      await updateUserState(chatId, 'waiting_input');
      await resetTicket(chatId);
      bot.sendMessage(chatId, 
        '📝 *Envoie-moi la recette :*\n\n' +
        '📸 Photo du ticket\n' +
        '🎤 Message vocal\n' +
        '✍️ Ou écris les montants\n\n' +
        '_💡 Envoie l\'image en fichier pour une meilleure qualité !_',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
            ]
          }
        }
      );
    }
    
    // ===== RÉCAP DU MOIS =====
    if (data === 'month_recap') {
      await showMonthRecap(chatId);
    }
    
    if (data === 'recap_previous_month') {
      await showMonthRecap(chatId, -1);
    }
    
    if (data === 'recap_current_month') {
      await showMonthRecap(chatId, 0);
    }
    
    // ===== CUMUL NON DÉCLARÉ =====
    if (data === 'show_cumul') {
      await showCumul(chatId);
    }
    
    // ===== GÉNÉRER PDF =====
    if (data === 'generate_pdf') {
      await showPDFMenu(chatId);
    }
    
    if (data === 'pdf_current_month') {
      await generateAndSendPDF(chatId, 0);
    }
    
    if (data === 'pdf_previous_month') {
      await generateAndSendPDF(chatId, -1);
    }
    
    // ===== MODIFIER UNE RECETTE PASSÉE =====
    if (data === 'modify_past') {
      await showModifyMenu(chatId);
    }
    
    if (data.startsWith('modify_day_')) {
      const day = parseInt(data.replace('modify_day_', ''));
      await startModifyDay(chatId, day);
    }
    
    // ===== SUPPRIMER UNE RECETTE =====
    if (data === 'delete_past') {
      await showDeleteMenu(chatId);
    }
    
    if (data.startsWith('delete_day_')) {
      const day = parseInt(data.replace('delete_day_', ''));
      await confirmDelete(chatId, day);
    }
    
    if (data.startsWith('confirm_delete_')) {
      const day = parseInt(data.replace('confirm_delete_', ''));
      await executeDelete(chatId, day);
    }
    
    // ===== AIDE =====
    if (data === 'show_help') {
      showHelp(chatId);
    }
    
    // ===== GESTION DES DATES =====
    if (data === 'DATE_RELATIVE_OK') {
      await showRecap(chatId);
    }
    
    if (data === 'DATE_TODAY') {
      const ticket = await getTicket(chatId);
      ticket.date = new Date().toISOString().split('T')[0];
      await updateTicket(chatId, ticket);
      await showRecap(chatId);
    }
    
    if (data === 'DATE_FIX') {
      await updateUserState(chatId, 'awaiting_date');
      bot.sendMessage(chatId, '📅 Envoie la date :\n\n• _JJ/MM_ (ex: 15/01)\n• _JJ/MM/AAAA_\n• _hier_, _demain_', { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
        }
      });
    }
    
    if (data === 'DATE_FUTURE_OK' || data === 'DATE_PAST_OK') {
      await showRecap(chatId);
    }
    
    // ===== ENVOI & OVERWRITE =====
    if (data === 'confirm_send') {
      await checkOverwriteAndSend(chatId);
    }
    
    if (data === 'confirm_overwrite') {
      await sendToSheet(chatId);
    }
    
    if (data === 'cancel_overwrite') {
      bot.sendMessage(chatId, '❌ Envoi annulé.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Modifier la date', callback_data: 'modify_date' }],
            [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
          ]
        }
      });
      await updateUserState(chatId, 'idle');
    }
    
    // ===== MODIFICATION =====
    if (data === 'modify') {
      await updateUserState(chatId, 'modifying');
      bot.sendMessage(chatId, 
        '✏️ *Que veux-tu modifier ?*\n\n' +
        'Exemples :\n' +
        '• _"CB 1200"_\n' +
        '• _"TR déclaré 50"_\n' +
        '• _"total déclaré 1500"_',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Retour', callback_data: 'back_to_recap' }]]
          }
        }
      );
    }
    
    if (data === 'back_to_recap') {
      await showRecap(chatId);
    }
    
    if (data === 'modify_date') {
      await updateUserState(chatId, 'awaiting_date');
      bot.sendMessage(chatId, '📅 Nouvelle date :\n\n• _JJ/MM_ ou _JJ/MM/AAAA_\n• _hier_, _demain_', { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Retour', callback_data: 'back_to_recap' }]]
        }
      });
    }
    
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
  
  if (state === 'idle') {
    // Si l'utilisateur envoie un message random, montrer le menu
    showMainMenu(chatId, msg.from.first_name || '');
    return;
  }
  
  bot.sendChatAction(chatId, 'typing');
  
  if (state === 'waiting_input') {
    await handleTicketInput(chatId, msg);
  } else if (state === 'awaiting_date') {
    await handleDateInput(chatId, msg.text);
  } else if (state === 'modifying') {
    await handleModification(chatId, msg.text);
  } else if (state === 'modifying_past') {
    await handleModifyPast(chatId, msg.text);
  }
});

// ========== FONCTIONS RÉCAP MOIS ==========

async function showMonthRecap(chatId, monthOffset = 0) {
  try {
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthName = getMonthNameFR(targetDate.getMonth());
    const year = targetDate.getFullYear();
    
    bot.sendMessage(chatId, `⏳ _Chargement du récap ${monthName} ${year}..._`, { parse_mode: 'Markdown' });
    
    const recap = await getMonthRecap(targetDate);
    
    if (!recap) {
      bot.sendMessage(chatId, 
        `📊 *${monthName} ${year}*\n\n_Aucune donnée pour ce mois._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Mois précédent', callback_data: 'recap_previous_month' }],
              [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
            ]
          }
        }
      );
      return;
    }
    
    const message = 
      `📊 *RÉCAP ${monthName.toUpperCase()} ${year}*\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `*💰 RÉEL*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💳 CB: *${formatMontant(recap.totalCB)}*\n` +
      `💵 ESP: *${formatMontant(recap.totalESP)}*\n` +
      `🎫 TR: *${formatMontant(recap.totalTR)}*\n` +
      `📉 Dép: *${formatMontant(recap.totalDep)}*\n` +
      `➡️ *Total: ${formatMontant(recap.totalReel)}*\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `*📋 DÉCLARÉ*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `➡️ *Total: ${formatMontant(recap.totalDeclare)}*\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `⚖️ *Non déclaré: ${formatMontant(recap.totalNonDeclare)}*\n\n` +
      `📅 Jours remplis: *${recap.joursRemplis}*`;
    
    const buttons = [];
    if (monthOffset === 0) {
      buttons.push([{ text: '⬅️ Mois précédent', callback_data: 'recap_previous_month' }]);
    } else {
      buttons.push([{ text: '➡️ Mois en cours', callback_data: 'recap_current_month' }]);
    }
    buttons.push([{ text: '🏠 Menu principal', callback_data: 'main_menu' }]);
    
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
    
  } catch (error) {
    console.error('Erreur récap mois:', error);
    bot.sendMessage(chatId, '❌ Erreur lors du chargement.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
  }
}

async function showCumul(chatId) {
  try {
    const now = new Date();
    const recap = await getMonthRecap(now);
    
    const message = recap 
      ? `💰 *CUMUL NON DÉCLARÉ*\n\n` +
        `📅 ${getMonthNameFR(now.getMonth())} ${now.getFullYear()}\n\n` +
        `⚖️ *${formatMontant(recap.totalNonDeclare)}*`
      : `💰 *CUMUL NON DÉCLARÉ*\n\n_Aucune donnée ce mois._`;
    
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
  } catch (error) {
    console.error('Erreur cumul:', error);
    bot.sendMessage(chatId, '❌ Erreur.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
  }
}

// ========== FONCTIONS PDF ==========

async function showPDFMenu(chatId) {
  const now = new Date();
  const currentMonth = getMonthNameFR(now.getMonth());
  const prevMonth = getMonthNameFR(now.getMonth() === 0 ? 11 : now.getMonth() - 1);
  
  bot.sendMessage(chatId, 
    `📄 *GÉNÉRER PDF COMPTABLE*\n\n_Choisis la période :_`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `📄 ${currentMonth} ${now.getFullYear()}`, callback_data: 'pdf_current_month' }],
          [{ text: `📄 ${prevMonth} ${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}`, callback_data: 'pdf_previous_month' }],
          [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

async function generateAndSendPDF(chatId, monthOffset) {
  try {
    bot.sendMessage(chatId, '⏳ _Génération du PDF en cours..._', { parse_mode: 'Markdown' });
    
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    
    const pdfBuffer = await generatePDF(targetDate);
    
    const monthName = getMonthNameFR(targetDate.getMonth());
    const fileName = `Compta_${monthName}_${targetDate.getFullYear()}.pdf`;
    
    await bot.sendDocument(chatId, pdfBuffer, {
      caption: `📄 *${monthName} ${targetDate.getFullYear()}*\n\n_PDF prêt pour ta comptable !_`,
      parse_mode: 'Markdown'
    }, {
      filename: fileName,
      contentType: 'application/pdf'
    });
    
    bot.sendMessage(chatId, '✅ PDF envoyé !', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
    
  } catch (error) {
    console.error('Erreur génération PDF:', error);
    bot.sendMessage(chatId, '❌ Erreur lors de la génération du PDF.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
  }
}

// ========== FONCTIONS MODIFIER/SUPPRIMER ==========

async function showModifyMenu(chatId) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();
  
  // Afficher les 7 derniers jours
  const buttons = [];
  let row = [];
  
  for (let i = 0; i < 7; i++) {
    const day = currentDay - i;
    if (day > 0) {
      const date = new Date(now.getFullYear(), now.getMonth(), day);
      const label = i === 0 ? "Auj." : i === 1 ? "Hier" : `${day}/${now.getMonth() + 1}`;
      row.push({ text: label, callback_data: `modify_day_${day}` });
      if (row.length === 4) {
        buttons.push(row);
        row = [];
      }
    }
  }
  if (row.length > 0) buttons.push(row);
  
  buttons.push([{ text: '🏠 Menu principal', callback_data: 'main_menu' }]);
  
  bot.sendMessage(chatId, 
    `✏️ *MODIFIER UNE RECETTE*\n\n_Choisis le jour :_`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }
  );
}

async function startModifyDay(chatId, day) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  const existingData = await getExistingData(dateStr);
  
  if (!existingData) {
    bot.sendMessage(chatId, 
      `📅 *${formatDateFR(dateStr)}*\n\n_Aucune recette ce jour._`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🍽️ Ajouter une recette', callback_data: 'new_ticket' }],
            [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
          ]
        }
      }
    );
    return;
  }
  
  // Charger les données dans le ticket en cours
  const ticket = {
    date: dateStr,
    cb: existingData.cb,
    espece: existingData.espece,
    ticket_restaurant: existingData.ticket_restaurant,
    depense: existingData.depense,
    total_reel: existingData.total_reel,
    total_declare: existingData.total_declare,
    tr_declare: existingData.tr_decl,
    dep_declare: existingData.dep_decl,
    difference: existingData.total_reel - existingData.total_declare
  };
  
  await updateTicket(chatId, ticket);
  await updateUserState(chatId, 'modifying_past');
  
  bot.sendMessage(chatId,
    `📅 *${formatDateFR(dateStr)}*\n\n` +
    `💳 CB: *${formatMontant(existingData.cb)}*\n` +
    `💵 ESP: *${formatMontant(existingData.espece)}*\n` +
    `🎫 TR: *${formatMontant(existingData.ticket_restaurant)}*\n` +
    `📉 Dép: *${formatMontant(existingData.depense)}*\n` +
    `➡️ Total déclaré: *${formatMontant(existingData.total_declare)}*\n\n` +
    `_Dis-moi ce que tu veux modifier :_\n` +
    `Ex: "CB 1500" ou "total déclaré 2000"`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    }
  );
}

async function handleModifyPast(chatId, text) {
  try {
    const ticket = await getTicket(chatId);
    const updated = await analyzeTicket(text, ticket);
    await updateTicket(chatId, updated);
    await showRecap(chatId);
  } catch (error) {
    console.error('Erreur modification:', error);
    bot.sendMessage(chatId, '❌ Pas compris. Ex: _"CB 1200"_', { parse_mode: 'Markdown' });
  }
}

async function showDeleteMenu(chatId) {
  const now = new Date();
  const currentDay = now.getDate();
  
  const buttons = [];
  let row = [];
  
  for (let i = 0; i < 7; i++) {
    const day = currentDay - i;
    if (day > 0) {
      const label = i === 0 ? "Auj." : i === 1 ? "Hier" : `${day}/${now.getMonth() + 1}`;
      row.push({ text: label, callback_data: `delete_day_${day}` });
      if (row.length === 4) {
        buttons.push(row);
        row = [];
      }
    }
  }
  if (row.length > 0) buttons.push(row);
  
  buttons.push([{ text: '🏠 Menu principal', callback_data: 'main_menu' }]);
  
  bot.sendMessage(chatId, 
    `🗑️ *SUPPRIMER UNE RECETTE*\n\n_Choisis le jour :_`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }
  );
}

async function confirmDelete(chatId, day) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  const existingData = await getExistingData(dateStr);
  
  if (!existingData) {
    bot.sendMessage(chatId, 
      `📅 *${formatDateFR(dateStr)}*\n\n_Aucune recette ce jour._`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
        }
      }
    );
    return;
  }
  
  bot.sendMessage(chatId,
    `⚠️ *SUPPRIMER ?*\n\n` +
    `📅 *${formatDateFR(dateStr)}*\n\n` +
    `💳 CB: ${formatMontant(existingData.cb)}\n` +
    `💵 ESP: ${formatMontant(existingData.espece)}\n` +
    `➡️ Total déclaré: *${formatMontant(existingData.total_declare)}*\n\n` +
    `_Cette action est irréversible !_`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Oui, supprimer', callback_data: `confirm_delete_${day}` }],
          [{ text: '❌ Non, annuler', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

async function executeDelete(chatId, day) {
  try {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    await deleteRecette(dateStr);
    
    bot.sendMessage(chatId, 
      `✅ Recette du *${formatDateFR(dateStr)}* supprimée.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
        }
      }
    );
  } catch (error) {
    console.error('Erreur suppression:', error);
    bot.sendMessage(chatId, '❌ Erreur lors de la suppression.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    });
  }
}

// ========== AIDE ==========

function showHelp(chatId) {
  bot.sendMessage(chatId,
    `❓ *AIDE*\n\n` +
    `*🍽️ Envoyer une recette*\n` +
    `Envoie une photo, un audio ou écris :\n` +
    `_"CB 1000 ESP 500 TR 100 dépense 50 total déclaré 1200"_\n\n` +
    `*📊 Récap du mois*\n` +
    `Voir le total du mois en cours\n\n` +
    `*📄 PDF Comptable*\n` +
    `Génère un PDF propre pour ta comptable (sans le non déclaré !)\n\n` +
    `*✏️ Modifier*\n` +
    `Corriger une recette passée\n\n` +
    `*🗑️ Supprimer*\n` +
    `Effacer une recette\n\n` +
    `*💰 Cumul*\n` +
    `Voir ton non déclaré du mois`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Menu principal', callback_data: 'main_menu' }]]
      }
    }
  );
}

// ========== FONCTIONS TICKET ==========

async function handleTicketInput(chatId, msg) {
  try {
    let ticketData;
    
    if (msg.photo) {
      bot.sendMessage(chatId, '📸 _Analyse en cours..._', { parse_mode: 'Markdown' });
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      try {
        ticketData = await analyzeImage(fileUrl);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Image illisible.\n\n_Essaie en texte ou meilleure qualité._', { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
        });
        return;
      }
    }
    else if (msg.document) {
      const doc = msg.document;
      const mimeType = doc.mime_type || '';
      
      if (doc.file_size > 20 * 1024 * 1024) {
        bot.sendMessage(chatId, '❌ Fichier trop lourd (max 20MB).', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
        });
        return;
      }
      
      if (mimeType.startsWith('image/')) {
        bot.sendMessage(chatId, '📸 _Analyse en cours..._', { parse_mode: 'Markdown' });
        const file = await bot.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        
        try {
          ticketData = await analyzeImage(fileUrl);
        } catch (error) {
          bot.sendMessage(chatId, '❌ Image illisible.', {
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
          });
          return;
        }
      }
      else if (mimeType.startsWith('audio/')) {
        bot.sendMessage(chatId, '🎤 _Analyse en cours..._', { parse_mode: 'Markdown' });
        const file = await bot.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        
        try {
          ticketData = await analyzeAudio(fileUrl, mimeType);
        } catch (error) {
          bot.sendMessage(chatId, '❌ Audio incompréhensible.', {
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
          });
          return;
        }
      }
      else {
        bot.sendMessage(chatId, '❌ Type non supporté.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
        });
        return;
      }
    }
    else if (msg.voice || msg.audio) {
      const audio = msg.voice || msg.audio;
      
      if (audio.duration && audio.duration > 180) {
        bot.sendMessage(chatId, '❌ Audio trop long (max 3 min).', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
        });
        return;
      }
      
      bot.sendMessage(chatId, '🎤 _Analyse en cours..._', { parse_mode: 'Markdown' });
      const file = await bot.getFile(audio.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      let mimeType = msg.audio?.mime_type || 'audio/ogg';
      
      try {
        ticketData = await analyzeAudio(fileUrl, mimeType);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Audio incompréhensible.', {
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
        });
        return;
      }
    }
    else if (msg.text) {
      ticketData = await analyzeTicket(msg.text);
    }
    else {
      bot.sendMessage(chatId, '❌ Format non supporté.', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
      });
      return;
    }
    
    const amountValidation = validateAmounts(ticketData);
    
    if (!amountValidation.valid) {
      bot.sendMessage(chatId, '❌ *Erreur :*\n\n' + amountValidation.errors.map(e => `• ${e}`).join('\n'), { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
      });
      return;
    }
    
    await updateTicket(chatId, ticketData);
    
    if (amountValidation.warnings.length > 0) {
      bot.sendMessage(chatId, 
        '⚠️ *Attention :*\n\n' + amountValidation.warnings.map(w => `• ${w}`).join('\n'),
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Continuer', callback_data: 'ignore_warnings' }],
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
    bot.sendMessage(chatId, '❌ Erreur. Réessaie en texte.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
    });
  }
}

async function validateDateFlow(chatId, dateStr) {
  const today = new Date().toISOString().split('T')[0];
  const ticketDate = dateStr || today;
  
  const ticket = await getTicket(chatId);
  ticket.date = ticketDate;
  await updateTicket(chatId, ticket);
  
  const dateValidation = validateDate(ticketDate);
  if (!dateValidation.valid) {
    bot.sendMessage(chatId, dateValidation.error, { 
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Aujourd\'hui', callback_data: 'DATE_TODAY' }],
          [{ text: '✏️ Autre date', callback_data: 'DATE_FIX' }]
        ]
      }
    });
    return;
  }
  
  if (ticketDate > today) {
    bot.sendMessage(chatId, 
      `📅 *Date future :*\n\n*${formatDateFR(ticketDate)}*\n\n_Correct ?_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui', callback_data: 'DATE_FUTURE_OK' }],
            [{ text: '📅 Aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger', callback_data: 'DATE_FIX' }]
          ]
        }
      }
    );
  } else if (ticketDate < today) {
    bot.sendMessage(chatId,
      `📅 *Date passée :*\n\n*${formatDateFR(ticketDate)}*\n\n_Correct ?_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui', callback_data: 'DATE_PAST_OK' }],
            [{ text: '📅 Aujourd\'hui', callback_data: 'DATE_TODAY' }],
            [{ text: '✏️ Corriger', callback_data: 'DATE_FIX' }]
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
        [{ text: '📅 Date', callback_data: 'modify_date' }, { text: '✏️ Montants', callback_data: 'modify' }],
        [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
      ]
    }
  });
}

async function handleDateInput(chatId, dateText) {
  const relativeDate = parseRelativeDate(dateText);
  
  if (relativeDate) {
    const ticket = await getTicket(chatId);
    ticket.date = relativeDate.date;
    await updateTicket(chatId, ticket);
    
    bot.sendMessage(chatId,
      `📅 *${relativeDate.label}* = *${formatDateFR(relativeDate.date)}*\n\n_C'est bien ça ?_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Oui', callback_data: 'DATE_RELATIVE_OK' }],
            [{ text: '✏️ Non, autre date', callback_data: 'DATE_FIX' }]
          ]
        }
      }
    );
    return;
  }
  
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
  
  const dateValidation = validateDate(date);
  if (!dateValidation.valid) {
    bot.sendMessage(chatId, dateValidation.error, { 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
    });
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
    
    const amountValidation = validateAmounts(updated);
    
    if (!amountValidation.valid) {
      bot.sendMessage(chatId, '❌ *Erreur :*\n\n' + amountValidation.errors.map(e => `• ${e}`).join('\n'), { parse_mode: 'Markdown' });
      return;
    }
    
    await updateTicket(chatId, updated);
    await showRecap(chatId);
  } catch (error) {
    console.error('Erreur modification:', error);
    bot.sendMessage(chatId, '❌ Pas compris. Ex: _"CB 1200"_', { parse_mode: 'Markdown' });
  }
}

async function checkOverwriteAndSend(chatId) {
  const ticket = await getTicket(chatId);
  
  try {
    const existingData = await getExistingData(ticket.date);
    
    if (existingData && (existingData.cb > 0 || existingData.espece > 0)) {
      await setOverwriteData(chatId, existingData);
      
      const message = 
        `⚠️ *ATTENTION !*\n\n` +
        `📅 *${formatDateFR(ticket.date)}*\n` +
        `_a déjà une recette :_\n\n` +
        `*Ancienne :* ${formatMontant(existingData.total_declare)}\n` +
        `*Nouvelle :* ${formatMontant(ticket.total_declare)}\n\n` +
        `_Remplacer ?_`;
      
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
      await sendToSheet(chatId);
    }
  } catch (error) {
    console.error('Erreur vérification overwrite:', error);
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
      `✅ *Envoyé en compta !*\n\n📅 ${formatDateFR(ticket.date)}\n💰 Déclaré : *${formatMontant(ticket.total_declare)}*`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🍽️ Nouvelle recette', callback_data: 'new_ticket' }],
            [{ text: '🏠 Menu principal', callback_data: 'main_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Erreur envoi Sheet:', error);
    bot.sendMessage(chatId, '❌ Erreur envoi. Réessaie.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'main_menu' }]] }
    });
  }
}

console.log('🤖 Bot IArmy démarré !');
