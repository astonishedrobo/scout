import { useState, useCallback, useEffect } from "react";

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
}

interface AuthState {
  token: string | null;
  user: User | null;
}

export function useAuth(baseUrl: string) {
  const [authState, setAuthState] = useState<AuthState>(() => {
    const token = localStorage.getItem("scout_token");
    const userStr = localStorage.getItem("scout_user");
    return {
      token,
      user: userStr ? JSON.parse(userStr) : null,
    };
  });

  const [authError, setAuthError] = useState<string | null>(null);

  const login = useCallback(
    async (username: string, password: string) => {
      setAuthError(null);
      try {
        const resp = await fetch(`${baseUrl}/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.detail || "Login failed");
        }
        const data = await resp.json();
        localStorage.setItem("scout_token", data.access_token);
        localStorage.setItem("scout_user", JSON.stringify(data.user));
        setAuthState({ token: data.access_token, user: data.user });
      } catch (err: any) {
        setAuthError(err.message);
        throw err;
      }
    },
    [baseUrl]
  );

  const register = useCallback(
    async (username: string, password: string) => {
      setAuthError(null);
      try {
        const resp = await fetch(`${baseUrl}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.detail || "Registration failed");
        }
        // auto login after register
        await login(username, password);
      } catch (err: any) {
        setAuthError(err.message);
        throw err;
      }
    },
    [baseUrl, login]
  );

  const logout = useCallback(() => {
    localStorage.removeItem("scout_token");
    localStorage.removeItem("scout_user");
    setAuthState({ token: null, user: null });
  }, []);

  return {
    ...authState,
    authError,
    login,
    register,
    logout,
  };
}
