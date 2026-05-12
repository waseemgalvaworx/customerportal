import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export interface AuthPermissions {
  allowedScreens?: string[];
  [key: string]: any;
}

export interface AuthUser {
  id: string;
  username: string;
  full_name?: string;
  role: 'admin' | 'manager' | 'staff' | 'customer' | 'customer_portal' | string;
  customer_id?: string | null;
  customerId?: string | null;
  permissions?: AuthPermissions;
  email?: string;
  /**
   * `true` when this session was authenticated via real Supabase Auth
   * (`supabase.auth.signInWithPassword`). When `true`, `auth.uid()` is
   * populated on every PostgREST request and RLS policies that filter on
   * `customers."userId" = auth.uid()` will work.
   *
   * `false` when this session was authenticated via the legacy
   * `secure-login` edge function. RLS-protected tables are unreachable
   * directly — reads must go through the `customer-jobs` edge function
   * (which uses the service role key and bypasses RLS).
   */
  authenticated_via_supabase_auth?: boolean;
}

const STORAGE_KEY = 'portal_auth_user';

// Profile rows in the shared backend can be either snake_case or camelCase.
// Normalize so the rest of the app always sees `customer_id` / `full_name`.
function normalizeAuthUser(raw: any): AuthUser {
  if (!raw || typeof raw !== 'object') return raw;
  const customer_id = raw.customer_id ?? raw.customerId ?? null;
  const full_name = raw.full_name ?? raw.fullName ?? undefined;
  const role = (raw.role ?? 'customer') as AuthUser['role'];
  return {
    id: raw.id,
    username: raw.username ?? raw.email ?? '',
    email: raw.email ?? undefined,
    full_name,
    role,
    customer_id,
    customerId: customer_id,
    permissions: raw.permissions,
    authenticated_via_supabase_auth: !!raw.authenticated_via_supabase_auth,
  } as AuthUser;
}

interface PasswordAuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const PasswordAuthContext = createContext<PasswordAuthContextValue | undefined>(undefined);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Look up the customer profile row that matches a freshly-authenticated
// Supabase Auth user, then construct the AuthUser shape the rest of the
// portal expects. Tries (in order):
//   1) customers."userId" = auth.uid()      [post-RLS, real Auth path]
//   2) customers.user_id  = auth.uid()      [snake_case variant of (1)]
//   3) customers.email    ILIKE auth.email  [last resort, pre-backfill data]
// Returns null if no customer profile is linked yet — the caller should
// then fall back to `secure-login` so legacy users still get in.
async function buildAuthUserFromSupabaseSession(
  authUserId: string,
  email: string | null,
): Promise<AuthUser | null> {
  const tryLookup = async (
    column: string,
    value: string,
  ): Promise<{ id: string; name: string; email?: string | null } | null> => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email')
      .eq(column, value)
      .limit(1)
      .maybeSingle();
    if (error) {
      // Column-doesn't-exist on this schema variant is fine, just skip.
      return null;
    }
    return (data as any) ?? null;
  };

  let customer = await tryLookup('userId', authUserId);
  if (!customer) customer = await tryLookup('user_id', authUserId);

  if (!customer && email) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, email')
      .ilike('email', email.trim())
      .limit(1)
      .maybeSingle();
    if (data) customer = data as any;
  }

  if (!customer) return null;

  return {
    id: authUserId,
    username: email ?? customer.name,
    email: email ?? undefined,
    full_name: customer.name,
    role: 'customer_portal',
    customer_id: customer.id,
    customerId: customer.id,
    authenticated_via_supabase_auth: true,
  };
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export const PasswordAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from localStorage AND from any persisted Supabase Auth session.
  // The Supabase client is configured with `persistSession: true`, so a
  // page refresh will re-issue a JWT for the previously-authenticated user
  // automatically. We just need to rebuild our AuthUser shape on top of it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Rehydrate the legacy localStorage user first — this covers
        //    accounts that haven't yet been migrated to Supabase Auth.
        let hydrated: AuthUser | null = null;
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.id) hydrated = normalizeAuthUser(parsed);
          }
        } catch {
          /* ignore parse errors */
        }

        // 2. Check whether Supabase Auth has a live session. If so, prefer
        //    that — it gives us a valid `auth.uid()` for RLS reads. We
        //    rebuild the AuthUser shape from the linked customers row.
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user && !cancelled) {
          const built = await buildAuthUserFromSupabaseSession(
            session.user.id,
            session.user.email ?? null,
          );
          if (built) {
            hydrated = built;
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(built));
            } catch { /* ignore */ }
          }
        }

        if (!cancelled) setUser(hydrated);
      } catch (e) {
        console.warn('[PasswordAuth] failed to hydrate', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Login flow (Option A — Supabase Auth first, secure-login fallback):
  //
  //   1. Try `supabase.auth.signInWithPassword({ email, password })`.
  //      If the customer-auth-backfill edge function has been run for
  //      this account (and the password matches), this succeeds. We then
  //      look up the linked customers row to build the AuthUser shape,
  //      and `auth.uid()` will be populated for every subsequent
  //      PostgREST request — RLS policies pass.
  //
  //   2. On any failure (account not yet migrated, wrong password tried
  //      against an Auth account, network error against the auth
  //      endpoint), fall through to the legacy `secure-login` edge
  //      function. That path sets `authenticated_via_supabase_auth =
  //      false`, so the rest of the app knows it must read data via the
  //      service-role-backed `customer-jobs` edge function rather than
  //      direct table queries (which RLS will reject without auth.uid()).
  //
  //   3. Persist the resulting AuthUser to localStorage either way so a
  //      page refresh picks up where we left off.
  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const trimmed = username.trim();

      // -----------------------------------------------------------------
      // 1. Supabase Auth (preferred path)
      // -----------------------------------------------------------------
      // We treat the login field as an email if it contains an "@" — the
      // legacy portal uses arbitrary usernames, so we don't ALWAYS attempt
      // Auth. But we also try Auth opportunistically when the value looks
      // like a username that could match a customer email; that's cheap
      // (one round-trip) and lets us migrate users gradually.
      const looksLikeEmail = /@/.test(trimmed);
      if (looksLikeEmail) {
        try {
          const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
            email: trimmed,
            password,
          });
          if (!authErr && authData?.user) {
            const built = await buildAuthUserFromSupabaseSession(
              authData.user.id,
              authData.user.email ?? trimmed,
            );
            if (built) {
              setUser(built);
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(built));
              } catch { /* ignore */ }
              return { ok: true };
            }
            // Authenticated but no customer row linked — sign back out and
            // let the legacy path try, which may resolve via username.
            await supabase.auth.signOut().catch(() => {});
            console.warn('[PasswordAuth] Supabase Auth succeeded but no customers row links to userId — falling back to secure-login');
          }
          // else: fall through to legacy path below
        } catch (e) {
          console.warn('[PasswordAuth] Supabase Auth attempt threw, falling back', e);
        }
      }
      // -----------------------------------------------------------------
      // 2. Legacy `secure-login` fallback
      // -----------------------------------------------------------------
      // Helper: turn whatever the auth/edge-function layer threw at us
      // into a friendly, user-facing message. The supabase-js client
      // returns "Edge Function returned a non-2xx status code" verbatim
      // for any 4xx/5xx response from `functions.invoke()`, which is
      // useless to a customer. We map those — and the obvious "Invalid
      // login credentials" Supabase Auth response — to a single clear
      // sentence asking them to retry or contact their account manager.
      const friendlyAuthError = (raw: unknown): string => {
        const msg = typeof raw === 'string'
          ? raw
          : (raw && typeof (raw as any).message === 'string' ? (raw as any).message : '');
        const lower = msg.toLowerCase();
        // Specific Supabase / edge-function error shapes that mean
        // "the credentials were rejected".
        const looksLikeBadCreds =
          lower.includes('non-2xx') ||
          lower.includes('invalid login') ||
          lower.includes('invalid credentials') ||
          lower.includes('invalid username') ||
          lower.includes('invalid password') ||
          lower.includes('unauthorized') ||
          lower.includes('unauthenticated') ||
          lower.includes('forbidden') ||
          lower.includes('not found') ||
          lower.includes('user not found') ||
          lower.includes('wrong password') ||
          lower.includes('login failed');
        if (looksLikeBadCreds || !msg) {
          return 'Wrong username or password. Please check again or contact your account manager for assistance.';
        }
        // Network-level failures still get a clear, distinct message
        // so the customer knows it isn't necessarily their credentials.
        if (lower.includes('failed to fetch') || lower.includes('network')) {
          return 'Network error. Please check your connection and try again.';
        }
        return msg;
      };

      const { data, error: fnError } = await supabase.functions.invoke('secure-login', {
        body: { username: trimmed, password },
      });

      if (fnError) {
        const msg = friendlyAuthError(fnError);
        setError(msg);
        return { ok: false, error: msg };
      }
      if (!data || data.error || !data.user) {
        const msg = friendlyAuthError(data?.error || 'Invalid credentials');
        setError(msg);
        return { ok: false, error: msg };
      }

      const authUser = normalizeAuthUser({
        ...data.user,
        authenticated_via_supabase_auth: false,
      });
      setUser(authUser);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
      } catch {
        // ignore quota / privacy-mode failures
      }
      return { ok: true };
    } catch (e: any) {
      const msg = e?.message || 'Network error during login';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setLoading(false);
    }
  }, []);


  const logout = useCallback(async () => {
    try {
      // Clear BOTH session stores — whichever path was used at login.
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    // No-op: with the edge-function-only flow there is no profile row to
    // re-fetch from the client. The user object returned at login is the
    // source of truth until the next login.
    return;
  }, []);

  return (
    <PasswordAuthContext.Provider value={{ user, loading, error, login, logout, refresh }}>
      {children}
    </PasswordAuthContext.Provider>
  );
};

export const usePasswordAuth = () => {
  const ctx = useContext(PasswordAuthContext);
  if (!ctx) throw new Error('usePasswordAuth must be used within PasswordAuthProvider');
  return ctx;
};
