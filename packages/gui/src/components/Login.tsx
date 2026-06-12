import React, { useState } from "react";
import { LogIn, UserPlus } from "lucide-react";

interface LoginProps {
  onLogin: (u: string, p: string) => Promise<void>;
  onRegister: (u: string, p: string) => Promise<void>;
  error: string | null;
}

export function Login({ onLogin, onRegister, error }: LoginProps) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    try {
      if (isRegistering) {
        await onRegister(username, password);
      } else {
        await onLogin(username, password);
      }
    } catch {
      // Error is handled and surfaced by hook via the `error` prop
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-scout-bg p-4 flex-1">
      <div className="w-full max-w-sm p-8 space-y-8 bg-scout-surface border border-scout-border rounded-xl shadow-lg">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight text-scout-text-primary">
            {isRegistering ? "Create an account" : "Welcome back"}
          </h2>
          <p className="mt-2 text-sm text-scout-text-primary-secondary">
            {isRegistering
              ? "Sign up to start exploring data"
              : "Sign in to your account"}
          </p>
        </div>

        <form className="space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="p-3 text-sm text-scout-text-primary bg-scout-error-muted rounded-lg border border-scout-error/20">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-scout-text-primary mb-1">
                Username
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-scout-bg border border-scout-border rounded-lg text-scout-text-primary placeholder-scout-text-secondary focus:outline-none focus:ring-2 focus:ring-scout-accent focus:border-transparent transition-colors"
                placeholder="Enter your username"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-scout-text-primary mb-1">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-scout-bg border border-scout-border rounded-lg text-scout-text-primary placeholder-scout-text-secondary focus:outline-none focus:ring-2 focus:ring-scout-accent focus:border-transparent transition-colors"
                placeholder="••••••••"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center items-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-scout-accent hover:bg-scout-accent-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-scout-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : isRegistering ? (
              <>
                <UserPlus className="w-4 h-4 mr-2" />
                Sign up
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4 mr-2" />
                Sign in
              </>
            )}
          </button>
        </form>

        <p className="text-center text-sm text-scout-text-primary-secondary">
          {isRegistering ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => setIsRegistering(!isRegistering)}
            className="font-medium text-scout-accent hover:text-scout-accent-hover transition-colors"
          >
            {isRegistering ? "Sign in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}
