import { useState } from "react";
import { LogIn, UserPlus } from "lucide-react";
import { Button } from "./ui/Button";
import { Input, Label, PasswordInput } from "./ui/Input";
import { HairlineDivider } from "./ui/HairlineDivider";
import loginScreenImage from "../assets/login_screen.png";

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
      // Error surfaced via hook
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 w-full bg-scout-void lg:flex-row">
      {/* Left column — image (hidden when viewport is too narrow for two columns) */}
      <div className="hidden lg:flex lg:flex-1 lg:min-h-0 items-center justify-center px-10 xl:px-14 py-10">
        <div className="h-[min(calc(100vh-5rem),920px)] w-full overflow-hidden rounded-hero">
          <img
            src={loginScreenImage}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      </div>

      {/* Right column — auth, vertically centered in the viewport */}
      <div className="flex flex-1 min-h-0 items-center justify-center px-8 lg:px-12 xl:px-16 py-12">
        <div className="w-full max-w-[420px] mx-auto">
          <p className="text-4xl font-bold text-white text-center mb-8">Scout</p>

          <div className="rounded-card border border-white/10 overflow-hidden">
            <form className="p-6 space-y-4" onSubmit={handleSubmit}>
              {error && (
                <div className="p-3 text-sm text-white bg-scout-error-muted rounded-btn">
                  {error}
                </div>
              )}

              <div>
                <Label className="text-sm text-white/70">Username</Label>
                <Input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  surface="void"
                />
              </div>

              <div>
                <Label className="text-sm text-white/70">Password</Label>
                <PasswordInput
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  surface="void"
                />
              </div>

              <Button
                type="submit"
                variant="filled"
                surface="void"
                accent="white"
                fullWidth
                size="hero"
                disabled={loading}
              >
                {loading ? (
                  <span className="w-5 h-5 border-2 border-scout-void/20 border-t-scout-void rounded-full animate-spin" />
                ) : isRegistering ? (
                  <>
                    <UserPlus size={16} />
                    Create account
                  </>
                ) : (
                  <>
                    <LogIn size={16} />
                    Sign in
                  </>
                )}
              </Button>
            </form>

            <div className="px-6 pb-6">
              <HairlineDivider label="or" surface="void" />
              <Button
                type="button"
                variant="outlined"
                surface="void"
                fullWidth
                size="default"
                className="mt-4"
                onClick={() => setIsRegistering(!isRegistering)}
              >
                {isRegistering ? "Already have an account? Sign in" : "Create a new account"}
              </Button>
            </div>
          </div>

          <p className="mt-6 text-caption text-white/50 leading-relaxed">
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}
