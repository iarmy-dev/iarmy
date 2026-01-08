// ===========================================
// iArmy Supabase Config
// ===========================================

const SUPABASE_URL = 'https://byqfnpdcnifauhwgetcq.supabase.co'; // Replace with your Supabase URL
const SUPABASE_ANON_KEY = 'sb_publishable_8mpFx9ubrV29KfKtgAb3eg_dyazidfT'; // Replace with your Supabase anon key
const API_URL = 'YOUR_BACKEND_URL'; // Replace with your Railway backend URL

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===========================================
// AUTH FUNCTIONS
// ===========================================

const Auth = {
  // Sign up with email
  async signUp(email, password, name) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name }
      }
    });
    if (error) throw error;
    return data;
  },
  
  // Sign in with email
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) throw error;
    return data;
  },
  
  // Sign in with Google
  async signInWithGoogle() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/compte.html'
      }
    });
    if (error) throw error;
    return data;
  },
  
  // Sign in with Facebook
  async signInWithFacebook() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'facebook',
      options: {
        redirectTo: window.location.origin + '/compte.html'
      }
    });
    if (error) throw error;
    return data;
  },
  
  // Sign in with Apple
  async signInWithApple() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo: window.location.origin + '/compte.html'
      }
    });
    if (error) throw error;
    return data;
  },
  
  // Sign out
  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },
  
  // Get current user
  async getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  },
  
  // Get session
  async getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  },
  
  // Reset password
  async resetPassword(email) {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password.html'
    });
    if (error) throw error;
    return data;
  },
  
  // Update password
  async updatePassword(newPassword) {
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword
    });
    if (error) throw error;
    return data;
  }
};

// ===========================================
// PROFILE FUNCTIONS
// ===========================================

const Profile = {
  async get() {
    const user = await Auth.getUser();
    if (!user) return null;
    
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (error) throw error;
    return data;
  },
  
  async update(updates) {
    const user = await Auth.getUser();
    if (!user) throw new Error('Not authenticated');
    
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
};

// ===========================================
// BOTS FUNCTIONS
// ===========================================

const Bots = {
  async list() {
    const user = await Auth.getUser();
    if (!user) return [];
    
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
  },
  
  async create(bot) {
    const user = await Auth.getUser();
    if (!user) throw new Error('Not authenticated');
    
    const { data, error } = await supabase
      .from('bots')
      .insert({ ...bot, user_id: user.id })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },
  
  async update(id, updates) {
    const user = await Auth.getUser();
    if (!user) throw new Error('Not authenticated');
    
    const { data, error } = await supabase
      .from('bots')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },
  
  async delete(id) {
    const user = await Auth.getUser();
    if (!user) throw new Error('Not authenticated');
    
    const { error } = await supabase
      .from('bots')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    
    if (error) throw error;
  }
};

// ===========================================
// TELEGRAM FUNCTIONS
// ===========================================

const Telegram = {
  async generateLinkCode() {
    const session = await Auth.getSession();
    if (!session) throw new Error('Not authenticated');
    
    const response = await fetch(`${API_URL}/api/telegram/generate-code`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data.code;
  }
};

// ===========================================
// WAITLIST FUNCTIONS
// ===========================================

const Waitlist = {
  async join(email, module) {
    const { error } = await supabase
      .from('waitlist')
      .insert({ email, module });
    
    if (error && !error.message.includes('duplicate')) throw error;
  }
};

// ===========================================
// HELPER FUNCTIONS
// ===========================================

function redirectIfNotAuth(redirectTo = 'connexion.html') {
  Auth.getUser().then(user => {
    if (!user) {
      window.location.href = redirectTo;
    }
  });
}

function redirectIfAuth(redirectTo = 'compte.html') {
  Auth.getUser().then(user => {
    if (user) {
      window.location.href = redirectTo;
    }
  });
}

// Listen to auth changes
supabase.auth.onAuthStateChange((event, session) => {
  console.log('Auth event:', event);
  if (event === 'SIGNED_IN') {
    // User signed in
  } else if (event === 'SIGNED_OUT') {
    // User signed out
  }
});
