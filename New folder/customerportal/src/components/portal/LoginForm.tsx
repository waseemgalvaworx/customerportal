import React, { useState } from 'react';
import { usePasswordAuth } from '@/contexts/PasswordAuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Lock, User } from 'lucide-react';

const LOGO_URL = 'https://d64gsuwffb70l.cloudfront.net/6826def9056908ac6c0eb35d_1777283619714_a14cfc88.jpg';

const LoginForm: React.FC = () => {
  const { login, loading, error } = usePasswordAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!username.trim() || !password) {
      setLocalError('Please enter both username and password.');
      return;
    }
    setSubmitting(true);
    const res = await login(username, password);
    setSubmitting(false);
    if (!res.ok) setLocalError(res.error || 'Login failed');
  };

  const displayError = localError || error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0f0f3a] via-[#1a1a4e] to-[#0f0f3a] p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-2xl bg-[#1a1a4e] ring-4 ring-white/10 shadow-2xl mb-5 overflow-hidden">
            <img src={LOGO_URL} alt="Galvabond" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-4xl font-extrabold text-white tracking-wide">GALVABOND</h1>
          <p className="text-slate-300 mt-2 text-sm">Customer Portal</p>
        </div>

        <Card className="border-0 shadow-2xl">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use the credentials provided by your account manager.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    id="username"
                    autoComplete="username"
                    className="pl-9"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="your.username"
                    disabled={submitting || loading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    className="pl-9"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    disabled={submitting || loading}
                  />
                </div>
              </div>

              {displayError && (
                <div className="text-sm bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2">
                  {displayError}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-[#1a1a4e] hover:bg-[#252570] h-11"
                disabled={submitting || loading}
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-400 mt-6">
          Galvabond · Customer Portal
        </p>
      </div>
    </div>
  );
};

export default LoginForm;
