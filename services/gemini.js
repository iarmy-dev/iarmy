// ===========================================
// Gemini AI - Analyse des tickets (texte, image, audio)
// ===========================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http = require('http');

let genAI = null;
let model = null;

function init() {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️ GEMINI_API_KEY not set, OCR disabled');
    return false;
  }
  
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  console.log('🧠 Gemini AI initialized');
  return true;
}

// Télécharger un fichier depuis une URL et le convertir en base64
async function downloadFileAsBase64(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        resolve(base64);
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Prompt système pour l'analyse
function getSystemPrompt(existingTicket = null) {
  return `Tu es un assistant de gestion de caisse pour restaurant.

Ta mission: analyser un message/image/audio contenant une recette journalière.

CHAMPS À EXTRAIRE (s'ils sont présents):
- cb : carte bancaire (montant réel)
- espece : espèces (montant réel)
- ticket_restaurant ou tr : tickets resto (montant réel)
- depense : dépenses (montant réel)
- total_declare : total déclaré (si fourni par l'utilisateur)
- date : format YYYY-MM-DD (année en cours = 2026)

RÈGLES DE CALCUL:
1) total_reel = cb + espece + ticket_restaurant + depense
2) Si total_declare n'est pas fourni : total_declare = total_reel
3) difference = total_reel - total_declare

POUR LES IMAGES:
- Analyse le ticket de caisse ou la note manuscrite
- Extrait les montants CB, espèces, TR, dépenses

POUR L'AUDIO:
- Transcris ce que dit la personne
- Extrait les montants mentionnés

CONTRAINTES:
- N'invente jamais de montant
- Si une valeur est absente, utilise 0
- Si la date est absente, retourne null
- Si l'année n'est pas précisée, utilise 2026
- Les montants doivent être des nombres positifs

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, sans balises markdown.

FORMAT DE SORTIE:
{
  "date": "YYYY-MM-DD" ou null,
  "cb": number,
  "espece": number,
  "ticket_restaurant": number,
  "depense": number,
  "total_reel": number,
  "total_declare": number,
  "difference": number
}`;
}

// Analyse de texte simple
async function analyzeTicket(userInput) {
  if (!model) {
    throw new Error('Gemini not initialized');
  }
  
  const systemPrompt = getSystemPrompt();

  try {
    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\nMessage utilisateur:\n' + userInput }] }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    });

    return parseGeminiResponse(result);
    
  } catch (error) {
    console.error('Erreur Gemini (texte):', error);
    throw new Error('Impossible d\'analyser le ticket');
  }
}

// Analyse d'image
async function analyzeImage(imageUrl) {
  if (!model) {
    throw new Error('Gemini not initialized');
  }
  
  const systemPrompt = getSystemPrompt();

  try {
    const imageBase64 = await downloadFileAsBase64(imageUrl);
    
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt + '\n\nAnalyse cette image de ticket/note:' },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    });

    return parseGeminiResponse(result);
    
  } catch (error) {
    console.error('Erreur Gemini (image):', error);
    throw new Error('Impossible d\'analyser l\'image');
  }
}

// Analyse d'audio
async function analyzeAudio(audioUrl, mimeType = 'audio/ogg') {
  if (!model) {
    throw new Error('Gemini not initialized');
  }
  
  const systemPrompt = getSystemPrompt();

  try {
    const audioBase64 = await downloadFileAsBase64(audioUrl);
    
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt + '\n\nTranscris et analyse cet audio:' },
            {
              inlineData: {
                mimeType: mimeType,
                data: audioBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    });

    return parseGeminiResponse(result);
    
  } catch (error) {
    console.error('Erreur Gemini (audio):', error);
    throw new Error('Impossible d\'analyser l\'audio');
  }
}

// Parser la réponse de Gemini
function parseGeminiResponse(result) {
  const responseText = result.response.text();
  
  let cleanText = responseText.trim();
  cleanText = cleanText.replace(/```json\n?/g, '');
  cleanText = cleanText.replace(/```\n?/g, '');
  
  const parsed = JSON.parse(cleanText);
  
  const ticket = {
    date: parsed.date || null,
    cb: Math.max(0, parsed.cb || 0),
    espece: Math.max(0, parsed.espece || 0),
    ticket_restaurant: Math.max(0, parsed.ticket_restaurant || 0),
    depense: Math.max(0, parsed.depense || 0),
    total_reel: Math.max(0, parsed.total_reel || 0),
    total_declare: Math.max(0, parsed.total_declare || parsed.total_reel || 0),
    difference: parsed.difference || 0
  };
  
  // Recalculer
  ticket.total_reel = ticket.cb + ticket.espece + ticket.ticket_restaurant + ticket.depense;
  ticket.difference = ticket.total_reel - ticket.total_declare;
  
  return ticket;
}

// Convertir le format Gemini vers le format simple {cb, esp, tr, ...}
function convertToSimpleFormat(geminiResult) {
  return {
    cb: geminiResult.cb || 0,
    esp: geminiResult.espece || 0,
    tr: geminiResult.ticket_restaurant || 0,
    depenses: geminiResult.depense || 0
  };
}

module.exports = { 
  init,
  analyzeTicket, 
  analyzeImage, 
  analyzeAudio,
  convertToSimpleFormat
};
