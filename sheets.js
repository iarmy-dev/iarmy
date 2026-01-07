// sheets.js - Google Sheets avec récap mois et suppression
const { google } = require('googleapis');

const SPREADSHEET_ID = '1n3FeYdAY7-ksAc8DWgQ--zKVmuNUlWiac2zUHQyvSac';

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

const MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 
                'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

const HEADERS = [
  'Date', 'CB', 'ESP', 'TR', 'Dépenses', 'TOTAL RÉEL',
  'CB Décl', 'ESP Décl', 'TR Décl', 'Dép Décl', 'TOTAL DÉCL',
  'Non Décl', 'Cumul'
];

function getSheetName(dateOrDateStr) {
  const date = typeof dateOrDateStr === 'string' ? new Date(dateOrDateStr) : dateOrDateStr;
  const month = MONTHS[date.getMonth()];
  const year = date.getFullYear().toString().slice(-2);
  return `${month}-${year}`;
}

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

async function createSheet(sheetName) {
  try {
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

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:M1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] }
    });

    const days = [];
    for (let i = 1; i <= 31; i++) {
      days.push([i]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A2:A32`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: days }
    });

    const formulas = [];
    for (let row = 2; row <= 32; row++) {
      formulas.push([
        `=SI(B${row}="";"";B${row}+C${row}+D${row}+E${row})`,
        `=SI(B${row}="";"";B${row})`,
        `=SI(K${row}="";"";K${row}-G${row}-I${row}-J${row})`,
        '', '', '',
        `=SI(OU(F${row}="";K${row}="");"";F${row}-K${row})`,
        row === 2 
          ? `=SI(L${row}="";"";L${row})` 
          : `=SI(L${row}="";"";SI(M${row-1}="";L${row};M${row-1}+L${row}))`
      ]);
    }
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!F2:M32`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: formulas }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A34:M34`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'TOTAL',
          '=SOMME(B2:B32)', '=SOMME(C2:C32)', '=SOMME(D2:D32)', '=SOMME(E2:E32)', '=SOMME(F2:F32)',
          '=SOMME(G2:G32)', '=SOMME(H2:H32)', '=SOMME(I2:I32)', '=SOMME(J2:J32)', '=SOMME(K2:K32)',
          '=SOMME(L2:L32)', '=M32'
        ]]
      }
    });

    console.log(`✅ Onglet "${sheetName}" créé`);
    return true;
  } catch (error) {
    console.error('Erreur création onglet:', error);
    throw error;
  }
}

async function getExistingData(dateStr) {
  const sheetName = getSheetName(dateStr);
  const day = new Date(dateStr).getDate();
  const rowNumber = day + 1;

  try {
    const exists = await sheetExists(sheetName);
    if (!exists) return null;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!B${rowNumber}:K${rowNumber}`
    });

    const values = response.data.values;
    if (!values || !values[0] || values[0].every(v => v === '' || v === undefined)) {
      return null;
    }

    const row = values[0];
    if (!row[0] && !row[1]) return null;

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
    console.error('Erreur lecture données:', error);
    return null;
  }
}

async function writeToSheet(ticketData) {
  const sheetName = getSheetName(ticketData.date);
  const day = new Date(ticketData.date).getDate();
  const rowNumber = day + 1;

  try {
    const exists = await sheetExists(sheetName);
    if (!exists) {
      console.log(`📁 Création de l'onglet "${sheetName}"...`);
      await createSheet(sheetName);
    }

    const trDecl = ticketData.tr_declare !== undefined ? ticketData.tr_declare : ticketData.ticket_restaurant;
    const depDecl = ticketData.dep_declare !== undefined ? ticketData.dep_declare : 0;
    const totalDecl = ticketData.total_declare;

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

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!I${rowNumber}:K${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ trDecl, depDecl, totalDecl ]]
      }
    });

    console.log(`✅ Écrit dans ${sheetName}, ligne ${rowNumber}`);
    return true;
  } catch (error) {
    console.error('❌ Erreur écriture:', error);
    throw error;
  }
}

// NOUVELLE FONCTION : Récap du mois
async function getMonthRecap(date) {
  const sheetName = getSheetName(date);
  
  try {
    const exists = await sheetExists(sheetName);
    if (!exists) return null;

    // Lire toutes les données du mois (lignes 2-32, colonnes B-L)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!B2:L32`
    });

    const values = response.data.values || [];
    
    let totalCB = 0, totalESP = 0, totalTR = 0, totalDep = 0;
    let totalReel = 0, totalDeclare = 0, totalNonDeclare = 0;
    let joursRemplis = 0;

    for (const row of values) {
      if (row && row[0] && row[0] !== '') {
        joursRemplis++;
        totalCB += parseFloat(row[0]) || 0;
        totalESP += parseFloat(row[1]) || 0;
        totalTR += parseFloat(row[2]) || 0;
        totalDep += parseFloat(row[3]) || 0;
        totalReel += parseFloat(row[4]) || 0;
        totalDeclare += parseFloat(row[9]) || 0;
        totalNonDeclare += parseFloat(row[10]) || 0;
      }
    }

    if (joursRemplis === 0) return null;

    return {
      totalCB,
      totalESP,
      totalTR,
      totalDep,
      totalReel,
      totalDeclare,
      totalNonDeclare,
      joursRemplis
    };
  } catch (error) {
    console.error('Erreur récap mois:', error);
    return null;
  }
}

// NOUVELLE FONCTION : Supprimer une recette
async function deleteRecette(dateStr) {
  const sheetName = getSheetName(dateStr);
  const day = new Date(dateStr).getDate();
  const rowNumber = day + 1;

  try {
    const exists = await sheetExists(sheetName);
    if (!exists) return false;

    // Effacer les données (colonnes B-E et I-K)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!B${rowNumber}:E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['', '', '', '']]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!I${rowNumber}:K${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['', '', '']]
      }
    });

    console.log(`🗑️ Recette supprimée: ${sheetName}, ligne ${rowNumber}`);
    return true;
  } catch (error) {
    console.error('Erreur suppression:', error);
    throw error;
  }
}

// NOUVELLE FONCTION : Obtenir toutes les données du mois pour le PDF
async function getMonthDataForPDF(date) {
  const sheetName = getSheetName(date);
  
  try {
    const exists = await sheetExists(sheetName);
    if (!exists) return null;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A2:K32`
    });

    const values = response.data.values || [];
    const data = [];

    for (const row of values) {
      if (row && row[1] && row[1] !== '') {
        data.push({
          jour: parseInt(row[0]) || 0,
          cb: parseFloat(row[1]) || 0,
          esp: parseFloat(row[2]) || 0,
          tr: parseFloat(row[3]) || 0,
          depense: parseFloat(row[4]) || 0,
          totalReel: parseFloat(row[5]) || 0,
          cbDecl: parseFloat(row[6]) || 0,
          espDecl: parseFloat(row[7]) || 0,
          trDecl: parseFloat(row[8]) || 0,
          depDecl: parseFloat(row[9]) || 0,
          totalDecl: parseFloat(row[10]) || 0
        });
      }
    }

    return data;
  } catch (error) {
    console.error('Erreur lecture PDF:', error);
    return null;
  }
}

module.exports = { 
  writeToSheet, 
  getSheetName, 
  getExistingData, 
  getMonthRecap, 
  deleteRecette,
  getMonthDataForPDF
};
