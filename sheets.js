// sheets.js - Écriture dans Google Sheets
const { google } = require('googleapis');

// Configuration Google Sheets
const SPREADSHEET_ID = '17JEQ81pVa5MCtXD5ePjzYhcfv0Dk278NKzchos5fb6Y';

// Authentification avec Service Account
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// Fonction pour trouver le bon onglet selon le mois
function getSheetName(dateStr) {
  const date = new Date(dateStr);
  const months = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 
                  'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const month = months[date.getMonth()];
  const year = date.getFullYear().toString().slice(-2);
  
  return `${month}-${year}`;
}

// Fonction pour écrire dans le Google Sheet
async function writeToSheet(ticketData) {
  const sheetName = getSheetName(ticketData.date);
  const day = new Date(ticketData.date).getDate();
  
  // Ligne = jour + 3 (car ligne 1-3 = header)
  // Jour 1 = ligne 4, jour 15 = ligne 18, etc.
  const rowNumber = day + 3;
  
  try {
    // TABLEAU 1 - TOTAL RÉEL (colonnes D à H)
    // D: CB, E: ESP, F: TR, G: TOTAL RECETTE (calculé), H: Dépenses
    const totalRecette = ticketData.cb + ticketData.espece + ticketData.ticket_restaurant;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!D${rowNumber}:H${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          ticketData.cb,
          ticketData.espece,
          ticketData.ticket_restaurant,
          totalRecette,
          ticketData.depense
        ]]
      }
    });
    
    // TABLEAU 2 - TOTAL DÉCLARÉ (colonnes I à J)
    // I: Espèces déclarées, J: Cartes Bleues déclarées
    // On répartit le total_declare entre CB et ESP selon les proportions réelles
    const totalDeclare = ticketData.total_declare;
    const proportionCB = ticketData.cb / (ticketData.cb + ticketData.espece) || 0.5;
    
    const cbDeclare = Math.round(totalDeclare * proportionCB * 100) / 100;
    const espDeclare = Math.round((totalDeclare - cbDeclare) * 100) / 100;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!I${rowNumber}:J${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          espDeclare,
          cbDeclare
        ]]
      }
    });
    
    console.log(`✅ Ticket écrit dans ${sheetName}, ligne ${rowNumber}`);
    return true;
    
  } catch (error) {
    console.error('❌ Erreur Google Sheets:', error);
    throw error;
  }
}

module.exports = { writeToSheet };
