// gemini.js - Analyse des tickets avec Gemini AI (texte, image, audio)
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');
const http = require('http');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

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
- tr_declare : tickets resto déclarés (OPTIONNEL - si absent, utiliser ticket_restaurant)
- dep_declare : dépenses déclarées (OPTIONNEL - si absent, mettre 0)
- date : format YYYY-MM-DD (année en cours = 2026)

RÈGLES DE CALCUL:
1) total_reel = cb + espece + ticket_restaurant + depense
2) Si total_declare n'est pas fourni : total_declare = total_reel
3) Si tr_declare n'est pas fourni : tr_declare = ticket_restaurant
4) Si dep_declare n'est pas fourni : dep_declare = 0
5) difference = total_reel - total_declare

POUR LES IMAGES:
- Analyse le ticket de caisse ou la note manuscrite
- Extrait les montants CB, espèces, TR, dépenses
- Si tu vois "total déclaré" ou équivalent, extrait-le

POUR L'AUDIO:
- Transcris ce que dit la personne
- Extrait les montants mentionnés

CONTRAINTES:
- N'invente jamais de montant
- Si une valeur est absente, utilise 0
- Si la date est absente, retourne null (le bot utilisera aujourd'hui)
- Si l'année n'est pas précisée, utilise 2026
- Les montants doivent être des nombres positifs

${existingTicket ? `
MODIFICATION EN COURS - Valeurs actuelles:
Date: ${existingTicket.date}
CB: ${existingTicket.cb}
Espèces: ${existingTicket.espece}
TR: ${existingTicket.ticket_restaurant}
Dépense: ${existingTicket.depense}
Total déclaré: ${existingTicket.total_declare}
TR déclaré: ${existingTicket.tr_declare || existingTicket.ticket_restaurant}
Dép déclarée: ${existingTicket.dep_declare || 0}

L'utilisateur veut modifier quelque chose. Garde les autres valeurs inchangées.
` : ''}

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
  "tr_declare": number,
  "dep_declare": number,
  "difference": number
}`;
}

// Analyse de texte simple
async function analyzeTicket(userInput, existingTicket = null) {
  const systemPrompt = getSystemPrompt(existingTicket);

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

    return parseGeminiResponse(result, existingTicket);
    
  } catch (error) {
    console.error('Erreur Gemini (texte):', error);
    throw new Error('Impossible d\'analyser le ticket');
  }
}

// Analyse d'image
async function analyzeImage(imageUrl, existingTicket = null) {
  const systemPrompt = getSystemPrompt(existingTicket);

  try {
    // Télécharger l'image en base64
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

    return parseGeminiResponse(result, existingTicket);
    
  } catch (error) {
    console.error('Erreur Gemini (image):', error);
    throw new Error('Impossible d\'analyser l\'image');
  }
}

// Analyse d'audio
async function analyzeAudio(audioUrl, mimeType = 'audio/ogg', existingTicket = null) {
  const systemPrompt = getSystemPrompt(existingTicket);

  try {
    // Télécharger l'audio en base64
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

    return parseGeminiResponse(result, existingTicket);
    
  } catch (error) {
    console.error('Erreur Gemini (audio):', error);
    throw new Error('Impossible d\'analyser l\'audio');
  }
}

// Parser la réponse de Gemini
function parseGeminiResponse(result, existingTicket) {
  const responseText = result.response.text();
  
  // Nettoyer la réponse
  let cleanText = responseText.trim();
  cleanText = cleanText.replace(/```json\n?/g, '');
  cleanText = cleanText.replace(/```\n?/g, '');
  
  const parsed = JSON.parse(cleanText);
  
  // Appliquer les valeurs par défaut et s'assurer que les montants sont positifs
  const ticket = {
    date: parsed.date || null,
    cb: Math.max(0, parsed.cb || 0),
    espece: Math.max(0, parsed.espece || 0),
    ticket_restaurant: Math.max(0, parsed.ticket_restaurant || 0),
    depense: Math.max(0, parsed.depense || 0),
    total_reel: Math.max(0, parsed.total_reel || 0),
    total_declare: Math.max(0, parsed.total_declare || parsed.total_reel || 0),
    tr_declare: parsed.tr_declare !== undefined ? Math.max(0, parsed.tr_declare) : Math.max(0, parsed.ticket_restaurant || 0),
    dep_declare: parsed.dep_declare !== undefined ? Math.max(0, parsed.dep_declare) : 0,
    difference: parsed.difference || 0
  };
  
  // Recalculer pour être sûr
  ticket.total_reel = ticket.cb + ticket.espece + ticket.ticket_restaurant + ticket.depense;
  ticket.difference = ticket.total_reel - ticket.total_declare;
  
  // Si modification, fusionner avec les valeurs existantes
  if (existingTicket) {
    return {
      date: ticket.date || existingTicket.date,
      cb: parsed.cb !== undefined ? ticket.cb : existingTicket.cb,
      espece: parsed.espece !== undefined ? ticket.espece : existingTicket.espece,
      ticket_restaurant: parsed.ticket_restaurant !== undefined ? ticket.ticket_restaurant : existingTicket.ticket_restaurant,
      depense: parsed.depense !== undefined ? ticket.depense : existingTicket.depense,
      total_reel: ticket.total_reel,
      total_declare: parsed.total_declare !== undefined ? ticket.total_declare : existingTicket.total_declare,
      tr_declare: parsed.tr_declare !== undefined ? ticket.tr_declare : (existingTicket.tr_declare || existingTicket.ticket_restaurant),
      dep_declare: parsed.dep_declare !== undefined ? ticket.dep_declare : (existingTicket.dep_declare || 0),
      difference: ticket.difference
    };
  }
  
  return ticket;
}

module.exports = { analyzeTicket, analyzeImage, analyzeAudio };
