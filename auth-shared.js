// Shared Supabase auth utilities.
// Uses the CDN build of @supabase/supabase-js v2 (loaded via <script> tag in HTML pages).

const SUPABASE_URL = 'https://kmgjmlcijhgaqddtjdou.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImttZ2ptbGNpamhnYXFkZHRqZG91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MDI0MDEsImV4cCI6MjA5NTI3ODQwMX0.oX5bfJ-FRb6LWFmzR479IqPtx3sU_ZWaDtX_S41-EtU';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function signInWithEmail(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}/auth/callback.html` },
  });
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/login.html';
}
