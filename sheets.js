// ===========================================
// Google Sheets Service
// ===========================================

const { google } = require('googleapis');

// Initialize Google Sheets API
let sheets = null;

function init() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.warn('⚠️ Google Sheets not configured');
    return false;
  }
  
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    sheets = google.sheets({ version: 'v4', auth });
    console.log('📊 Google Sheets API initialized');
    return true;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    return false;
  }
}

// ===========================================
// METHODS
// ===========================================

/**
 * Append a row to a Google Sheet
 * @param {string} spreadsheetId - The Google Sheet ID
 * @param {string} date - The date (YYYY-MM-DD)
 * @param {object} data - The data to append {cb: 1200, esp: 500, ...}
 */
async function appendRow(spreadsheetId, date, data) {
  if (!sheets) {
    if (!init()) {
      throw new Error('Google Sheets not configured');
    }
  }
  
  try {
    // First, get the sheet structure to find columns
    const metaResponse = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false
    });
    
    const sheetName = metaResponse.data.sheets[0]?.properties?.title || 'Sheet1';
    
    // Get headers
    const headersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:1`
    });
    
    const headers = headersResponse.data.values?.[0] || [];
    
    // Build row based on headers
    const row = headers.map(header => {
      const h = header.toLowerCase().trim();
      
      // Date column
      if (h === 'date' || h.includes('date')) {
        return formatDate(date);
      }
      
      // Match data keys to headers
      for (const [key, value] of Object.entries(data)) {
        if (matchHeader(h, key)) {
          return value;
        }
      }
      
      return '';
    });
    
    // If no headers found, create a simple row
    if (headers.length === 0) {
      const simpleRow = [
        formatDate(date),
        data.cb || '',
        data.esp || '',
        data.tr || '',
        data.cheque || '',
        data.virement || ''
      ];
      
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:F`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [simpleRow]
        }
      });
    } else {
      // Append row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:${String.fromCharCode(65 + headers.length - 1)}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [row]
        }
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error appending to sheet:', error);
    throw error;
  }
}

/**
 * Update a specific cell or row
 */
async function updateCell(spreadsheetId, range, value) {
  if (!sheets) {
    if (!init()) {
      throw new Error('Google Sheets not configured');
    }
  }
  
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[value]]
      }
    });
    return true;
  } catch (error) {
    console.error('Error updating cell:', error);
    throw error;
  }
}

/**
 * Get sheet data
 */
async function getSheetData(spreadsheetId, range) {
  if (!sheets) {
    if (!init()) {
      throw new Error('Google Sheets not configured');
    }
  }
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error getting sheet data:', error);
    throw error;
  }
}

/**
 * Find row by date and update it (upsert)
 */
async function upsertByDate(spreadsheetId, date, data) {
  if (!sheets) {
    if (!init()) {
      throw new Error('Google Sheets not configured');
    }
  }
  
  try {
    const metaResponse = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false
    });
    
    const sheetName = metaResponse.data.sheets[0]?.properties?.title || 'Sheet1';
    
    // Get all data
    const allData = await getSheetData(spreadsheetId, `${sheetName}!A:Z`);
    
    if (allData.length === 0) {
      // Empty sheet, just append
      return appendRow(spreadsheetId, date, data);
    }
    
    const headers = allData[0];
    const formattedDate = formatDate(date);
    
    // Find date column index
    const dateColIndex = headers.findIndex(h => 
      h.toLowerCase().includes('date')
    );
    
    if (dateColIndex === -1) {
      // No date column, just append
      return appendRow(spreadsheetId, date, data);
    }
    
    // Find existing row with this date
    let rowIndex = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][dateColIndex] === formattedDate) {
        rowIndex = i + 1; // +1 for 1-indexed sheets
        break;
      }
    }
    
    if (rowIndex === -1) {
      // No existing row, append
      return appendRow(spreadsheetId, date, data);
    }
    
    // Update existing row
    const row = headers.map((header, idx) => {
      const h = header.toLowerCase().trim();
      
      // Keep existing date
      if (h.includes('date')) {
        return allData[rowIndex - 1][idx] || formattedDate;
      }
      
      // Update with new data or keep existing
      for (const [key, value] of Object.entries(data)) {
        if (matchHeader(h, key)) {
          // Add to existing value
          const existing = parseFloat(allData[rowIndex - 1][idx]) || 0;
          return existing + value;
        }
      }
      
      return allData[rowIndex - 1][idx] || '';
    });
    
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowIndex}:${String.fromCharCode(65 + headers.length - 1)}${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row]
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error upserting by date:', error);
    throw error;
  }
}

// ===========================================
// HELPERS
// ===========================================

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

function matchHeader(header, key) {
  const headerLower = header.toLowerCase();
  const keyLower = key.toLowerCase();
  
  const mappings = {
    'cb': ['cb', 'carte', 'carte bleue', 'carte bancaire', 'bleu'],
    'esp': ['esp', 'espèce', 'espece', 'espèces', 'especes', 'cash', 'liquide'],
    'tr': ['tr', 'ticket', 'tickets', 'ticket resto', 'tickets resto'],
    'cheque': ['cheque', 'chèque', 'cheques', 'chèques'],
    'virement': ['virement', 'vir', 'virements'],
    'depenses': ['dep', 'dépense', 'depense', 'dépenses', 'depenses']
  };
  
  const variations = mappings[keyLower] || [keyLower];
  return variations.some(v => headerLower.includes(v));
}

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  init,
  appendRow,
  updateCell,
  getSheetData,
  upsertByDate
};
