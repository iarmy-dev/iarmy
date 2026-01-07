// sheets.js - Écriture dans Google Sheets avec structure complète
const { google } = require('googleapis');

// ID du nouveau Google Sheet
const SPREADSHEET_ID = '1n3FeYdAY7-ksAc8DWgQ--zKVmuNUlWiac2zUHQyvSac';

// Authentification avec Service Account
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// Noms des mois en français
const MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 
                'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

// Structure des colonnes
const HEADERS = [
  // RÉEL (A-F)
  'Date', 'CB', 'ESP', 'TR', 'Dépenses', 'TOTAL RÉEL',
  // DÉCLARÉ (G-K)
  'CB Décl', 'ESP Décl', 'TR Décl', 'Dép Décl', 'TOTAL DÉCL',
  // CONTRÔLE (L-M) - discret
  'Non Décl', 'Cumul'
];

// Fonction pour obtenir le nom de l'onglet
function getSheetName(dateStr) {
  const date = new Date(dateStr);
  const month = MONTHS[date.getMonth()];
  const year = date.getFullYear().toString().slice(-2);
  return `${month}-${year}`;
}

// Fonction pour vérifier si un onglet existe
async function sheetExists(sheetName) {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });
    const sheetNames = response.data.sheets.map(s => s.properties.title);
    return sheetNames.includes(sheetName);
  } catch (error) {
    console.error('Erreur vérification onglet:', error);
    return false;
  }
}

// Fonction pour créer un nouvel onglet avec la structure
async function createSheet(sheetName) {
  try {
    // 1. Créer l'onglet
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: sheetName }
          }
        }]
      }
    });

    // 2. Ajouter les headers (ligne 1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:M1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [HEADERS]
      }
    });

    // 3. Ajouter les numéros de jours (1-31) dans la colonne A
    const days = [];
    for (let i = 1; i <= 31; i++) {
      days.push([i]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A2:A32`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: days
      }
    });

    // 4. Ajouter les formules pour chaque ligne (2-32) - EN FRANÇAIS
    const formulas = [];
    for (let row = 2; row <= 32; row++) {
      formulas.push([
        // F: TOTAL RÉEL = CB + ESP + TR + Dépenses
        `=SI(B${row}="";"";B${row}+C${row}+D${row}+E${row})`,
        // G: CB Décl = CB (toujours)
        `=SI(B${row}="";"";B${row})`,
        // H: ESP Décl = TOTAL DÉCL - CB Décl - TR Décl - Dép Décl
        `=SI(K${row}="";"";K${row}-G${row}-I${row}-J${row})`,
        // I: TR Décl (saisi par le bot)
        '',
        // J: Dép Décl (saisi par le bot)
        '',
        // K: TOTAL DÉCL (saisi par le bot)
        '',
        // L: Non Décl = TOTAL RÉEL - TOTAL DÉCL
        `=SI(OU(F${row}="";K${row}="");"";F${row}-K${row})`,
        // M: Cumul = Cumul précédent + Non Décl
        row === 2 
          ? `=SI(L${row}="";"";L${row})` 
          : `=SI(L${row}="";"";SI(M${row-1}="";L${row};M${row-1}+L${row}))`
      ]);
    }
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!F2:M32`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: formulas
      }
    });

    // 5. Ajouter ligne TOTAL en bas (ligne 34) - EN FRANÇAIS
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A34:M34`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'TOTAL',
          '=SOMME(B2:B32)',
          '=SOMME(C2:C32)',
          '=SOMME(D2:D32)',
          '=SOMME(E2:E32)',
          '=SOMME(F2:F32)',
          '=SOMME(G2:G32)',
          '=SOMME(H2:H32)',
          '=SOMME(I2:I32)',
          '=SOMME(J2:J32)',
          '=SOMME(K2:K32)',
          '=SOMME(L2:L32)',
          '=M32'
        ]]
      }
    });

    console.log(`✅ Onglet "${sheetName}" créé avec succès`);
    return true;

  } catch (error) {
    console.error('Erreur création onglet:', error);
    throw error;
  }
}

// NOUVELLE FONCTION : Lire les données existantes pour une date
async function getExistingData(dateStr) {
  const sheetName = getSheetName(dateStr);
  const day = new Date(dateStr).getDate();
  const rowNumber = day + 1;

  try {
    // Vérifier si l'onglet existe
    const exists = await sheetExists(sheetName);
    if (!exists) {
      return null; // Pas d'onglet = pas de données
    }

    // Lire la ligne (colonnes B à K : CB, ESP, TR, Dép, Total Réel, CB Décl, ESP Décl, TR Décl, Dép Décl, Total Décl)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!B${rowNumber}:K${rowNumber}`
    });

    const values = response.data.values;
    
    // Si pas de données ou ligne vide
    if (!values || !values[0] || values[0].every(v => v === '' || v === undefined)) {
      return null;
    }

    const row = values[0];
    
    // Vérifier si au moins CB ou ESP a une valeur
    if (!row[0] && !row[1]) {
      return null;
    }

    return {
      cb: parseFloat(row[0]) || 0,
      espece: parseFloat(row[1]) || 0,
      ticket_restaurant: parseFloat(row[2]) || 0,
      depense: parseFloat(row[3]) || 0,
      total_reel: parseFloat(row[4]) || 0,
      cb_decl: parseFloat(row[5]) || 0,
      esp_decl: parseFloat(row[6]) || 0,
      tr_decl: parseFloat(row[7]) || 0,
      dep_decl: parseFloat(row[8]) || 0,
      total_declare: parseFloat(row[9]) || 0
    };

  } catch (error) {
    console.error('Erreur lecture données existantes:', error);
    return null;
  }
}

// Fonction principale pour écrire dans le Google Sheet
async function writeToSheet(ticketData) {
  const sheetName = getSheetName(ticketData.date);
  const day = new Date(ticketData.date).getDate();
  const rowNumber = day + 1; // Jour 1 = ligne 2, Jour 7 = ligne 8, etc.

  try {
    // Vérifier si l'onglet existe, sinon le créer
    const exists = await sheetExists(sheetName);
    if (!exists) {
      console.log(`📁 Création de l'onglet "${sheetName}"...`);
      await createSheet(sheetName);
    }

    // Calculer les valeurs
    const trDecl = ticketData.tr_declare !== undefined ? ticketData.tr_declare : ticketData.ticket_restaurant;
    const depDecl = ticketData.dep_declare !== undefined ? ticketData.dep_declare : 0;
    const totalDecl = ticketData.total_declare;

    // Écrire les données RÉEL (colonnes B-E)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!B${rowNumber}:E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          ticketData.cb,
          ticketData.espece,
          ticketData.ticket_restaurant,
          ticketData.depense
        ]]
      }
    });

    // Écrire les données DÉCLARÉ (colonnes I-K : TR Décl, Dép Décl, Total Décl)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!I${rowNumber}:K${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          trDecl,
          depDecl,
          totalDecl
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

module.exports = { writeToSheet, getSheetName, getExistingData };
