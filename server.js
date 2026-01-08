// ===========================================
// iArmy Backend Server
// ===========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Import modules
const TelegramBot = require('./bot/telegram');
const sheetsService = require('./services/sheets');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Middleware
app.use(cors({
  origin: [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use(express.json());

// Make supabase available in routes
app.use((req, res, next) => {
  req.supabase = supabase;
  next();
});

// ===========================================
// ROUTES
// ===========================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'iArmy API', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ===========================================
// BOTS ROUTES
// ===========================================

// Get user's bots
app.get('/api/bots', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { data: bots, error } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ bots });
  } catch (error) {
    console.error('Error fetching bots:', error);
    res.status(500).json({ error: 'Failed to fetch bots' });
  }
});

// Create new bot
app.post('/api/bots', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { module, name, config, google_sheet_id } = req.body;

    const { data: bot, error } = await supabase
      .from('bots')
      .insert({
        user_id: user.id,
        module,
        name: name || `Bot ${module}`,
        config: config || {},
        google_sheet_id
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ bot });
  } catch (error) {
    console.error('Error creating bot:', error);
    res.status(500).json({ error: 'Failed to create bot' });
  }
});

// Update bot
app.patch('/api/bots/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { id } = req.params;
    const updates = req.body;

    const { data: bot, error } = await supabase
      .from('bots')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ bot });
  } catch (error) {
    console.error('Error updating bot:', error);
    res.status(500).json({ error: 'Failed to update bot' });
  }
});

// Delete bot
app.delete('/api/bots/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { id } = req.params;

    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting bot:', error);
    res.status(500).json({ error: 'Failed to delete bot' });
  }
});

// ===========================================
// TELEGRAM LINK ROUTES
// ===========================================

// Generate link code for Telegram
app.post('/api/telegram/generate-code', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Generate 6-digit code
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Store code temporarily (expires in 10 minutes)
    const { error } = await supabase
      .from('profiles')
      .update({ 
        telegram_link_code: code,
        telegram_link_expires: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      })
      .eq('id', user.id);

    if (error) throw error;

    res.json({ code });
  } catch (error) {
    console.error('Error generating code:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// ===========================================
// ENTRIES ROUTES
// ===========================================

// Get entries for a bot
app.get('/api/bots/:botId/entries', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { botId } = req.params;
    const { from, to } = req.query;

    let query = supabase
      .from('entries')
      .select('*')
      .eq('bot_id', botId)
      .eq('user_id', user.id)
      .order('date', { ascending: false });

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data: entries, error } = await query;

    if (error) throw error;

    res.json({ entries });
  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ error: 'Failed to fetch entries' });
  }
});

// ===========================================
// WAITLIST
// ===========================================

app.post('/api/waitlist', async (req, res) => {
  try {
    const { email, module } = req.body;

    const { error } = await supabase
      .from('waitlist')
      .upsert({ email, module }, { onConflict: 'email,module' });

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding to waitlist:', error);
    res.status(500).json({ error: 'Failed to add to waitlist' });
  }
});

// ===========================================
// START SERVER & BOT
// ===========================================

app.listen(PORT, () => {
  console.log(`🚀 iArmy API running on port ${PORT}`);
  
  // Initialize Telegram Bot
  if (process.env.TELEGRAM_BOT_TOKEN) {
    TelegramBot.init(supabase, sheetsService);
    console.log('🤖 Telegram bot started');
  } else {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set, bot not started');
  }
});

module.exports = app;
