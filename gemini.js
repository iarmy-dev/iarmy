// gemini.js - Analyse des tickets avec Gemini AI
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

async function analyzeTicket(userInput, existingTicket = null) {
  const systemPrompt = `Tu es un assistant de gestion de caisse pour restaurant.

Ta mission: analyser un message utilisateur contenant une recette journalière.

IMPORTANT: L'utilisateur note LUI-MÊME le "total déclaré" sur son papier.
Ne calcule PAS le total déclaré automatiquement.

Extrais ces montants s'ils sont présents:
- cb (carte bancaire)
- espece (espèces)
- ticket_restaurant (tickets resto, TR)
- depense
- total_declare (FOURNI PAR L'UTILISATEUR, ne le calcule pas)
- date (format YYYY-MM-DD)

Règles de calcul:
1) total_reel = cb + espece + ticket_restaurant + depense
2) SI total_declare est fourni par l'utilisateur: utilise cette valeur
   SI total_declare n'est PAS fourni: total_declare = total_reel
3) difference = total_reel - total_declare

Contraintes:
- N'invente jamais de montant
- Si une valeur est absente, utilise 0 (sauf total_declare qui suit la règle ci-dessus)
- Si la date est absente, retourne null
- Si modification, garde les valeurs existantes non mentionnées

${existingTicket ? `
MODIFICATION EN COURS - Valeurs actuelles:
Date: ${existingTicket.date}
CB: ${existingTicket.cb}
Espèces: ${existingTicket.espece}
TR: ${existingTicket.ticket_restaurant}
Dépense: ${existingTicket.depense}
Total déclaré: ${existingTicket.total_declare}

L'utilisateur veut modifier quelque chose. Garde les autres valeurs inchangées.
` : ''}

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, sans balises markdown.

Format de sortie EXACT:
{
  "date": "YYYY-MM-DD" ou null,
  "cb": number,
  "espece": number,
  "ticket_restaurant": number,
  "depense": number,
  "total_reel": number,
  "total_declare": number,
  "difference": number,
  "confidence": "high" | "medium" | "low"
}`;

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

    const responseText = result.response.text();
    
    // Nettoyer la réponse (enlever les backticks markdown si présents)
    let cleanText = responseText.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    
    const parsed = JSON.parse(cleanText);
    
    // Si modification, fusionner avec les valeurs existantes
    if (existingTicket) {
      return {
        date: parsed.date || existingTicket.date,
        cb: parsed.cb !== undefined ? parsed.cb : existingTicket.cb,
        espece: parsed.espece !== undefined ? parsed.espece : existingTicket.espece,
        ticket_restaurant: parsed.ticket_restaurant !== undefined ? parsed.ticket_restaurant : existingTicket.ticket_restaurant,
        depense: parsed.depense !== undefined ? parsed.depense : existingTicket.depense,
        total_reel: parsed.total_reel,
        total_declare: parsed.total_declare !== undefined ? parsed.total_declare : existingTicket.total_declare,
        difference: parsed.difference,
        confidence: parsed.confidence
      };
    }
    
    return parsed;
    
  } catch (error) {
    console.error('Erreur Gemini:', error);
    throw new Error('Impossible d\'analyser le ticket');
  }
}

module.exports = { analyzeTicket };