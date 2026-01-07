// gemini.js - Analyse des tickets avec Gemini AI
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

async function analyzeTicket(userInput, existingTicket = null) {
  const systemPrompt = `Tu es un assistant de gestion de caisse pour restaurant.

Ta mission: analyser un message utilisateur contenant une recette journalière.

CHAMPS À EXTRAIRE (s'ils sont présents):
- cb : carte bancaire (montant réel)
- espece : espèces (montant réel)
- ticket_restaurant ou tr : tickets resto (montant réel)
- depense : dépenses (montant réel)
- total_declare : total déclaré (OBLIGATOIRE si fourni par l'utilisateur)
- tr_declare : tickets resto déclarés (OPTIONNEL - si absent, utiliser ticket_restaurant)
- dep_declare : dépenses déclarées (OPTIONNEL - si absent, mettre 0)
- date : format YYYY-MM-DD

RÈGLES DE CALCUL:
1) total_reel = cb + espece + ticket_restaurant + depense
2) Si total_declare n'est pas fourni : total_declare = total_reel
3) Si tr_declare n'est pas fourni : tr_declare = ticket_restaurant
4) Si dep_declare n'est pas fourni : dep_declare = 0
5) difference = total_reel - total_declare

EXEMPLES D'INPUT:
- "CB 1000 ESP 500 TR 100 dépense 50 total déclaré 1200"
- "CB 1000 ESP 500 TR 100 dépense 50 total déclaré 1200 TR déclaré 50"
- "CB 1000 ESP 500 TR 100 dépense 50 total déclaré 1200 TR déclaré 50 dépense déclarée 20"

CONTRAINTES:
- N'invente jamais de montant
- Si une valeur est absente, utilise 0
- Si la date est absente, retourne null (le bot utilisera aujourd'hui)

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
    
    // Nettoyer la réponse
    let cleanText = responseText.trim();
    cleanText = cleanText.replace(/```json\n?/g, '');
    cleanText = cleanText.replace(/```\n?/g, '');
    
    const parsed = JSON.parse(cleanText);
    
    // Appliquer les valeurs par défaut
    const ticket = {
      date: parsed.date || null,
      cb: parsed.cb || 0,
      espece: parsed.espece || 0,
      ticket_restaurant: parsed.ticket_restaurant || 0,
      depense: parsed.depense || 0,
      total_reel: parsed.total_reel || 0,
      total_declare: parsed.total_declare || parsed.total_reel || 0,
      tr_declare: parsed.tr_declare !== undefined ? parsed.tr_declare : (parsed.ticket_restaurant || 0),
      dep_declare: parsed.dep_declare !== undefined ? parsed.dep_declare : 0,
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
    
  } catch (error) {
    console.error('Erreur Gemini:', error);
    throw new Error('Impossible d\'analyser le ticket');
  }
}

module.exports = { analyzeTicket };
