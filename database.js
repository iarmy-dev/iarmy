// database.js - Version mémoire (sans SQLite)
const users = new Map();
const tickets = new Map();

function getUserState(chatId) {
  const user = users.get(String(chatId));
  return user ? user.state : 'idle';
}

function updateUserState(chatId, state) {
  users.set(String(chatId), { state, updated_at: new Date() });
}

function getTicket(chatId) {
  const ticket = tickets.get(String(chatId));
  if (!ticket) {
    const today = new Date().toISOString().split('T')[0];
    const emptyTicket = {
      date: today,
      cb: 0,
      espece: 0,
      ticket_restaurant: 0,
      depense: 0,
      total_reel: 0,
      total_declare: 0,
      tr_declare: 0,
      dep_declare: 0,
      difference: 0
    };
    tickets.set(String(chatId), emptyTicket);
    return emptyTicket;
  }
  return ticket;
}

function updateTicket(chatId, ticketData) {
  tickets.set(String(chatId), { ...ticketData, updated_at: new Date() });
}

function resetTicket(chatId) {
  tickets.delete(String(chatId));
}

module.exports = {
  getUserState,
  updateUserState,
  getTicket,
  updateTicket,
  resetTicket
};
