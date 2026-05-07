import { createClient } from '@supabase/supabase-js';

// Galvanizing Job Tracker - Shared Backend
// Same Supabase project as the React Native app
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://obtmrrbajlrdnmnfhcas.supabase.co';
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_a2aLOLR9mbRMU48y0w_UKw_LALC-gJs';


// We now use real Supabase Auth so that auth.uid() is populated on the
// client and the RLS policies in supabase/migrations/20260427_customer_rls.sql
// can be enforced at the database layer.
//
// • persistSession: store the JWT in localStorage so refreshes stay logged in.
// • autoRefreshToken: keep the access token alive in the background.
// • detectSessionInUrl: false — we don't use magic-link/OAuth redirects here.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'galvabond.customer-portal.auth',
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

export const SUPABASE_CONFIG = {
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
};
