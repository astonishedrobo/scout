import { useState } from "react";
import { LogIn, UserPlus } from "lucide-react";
import { Button } from "./ui/Button";
import { Input, Label, PasswordInput } from "./ui/Input";
import { HairlineDivider } from "./ui/HairlineDivider";
import loginScreenImage from "../assets/login_screen.webp";
import { PixelPet } from "./PixelPet";
import { PixelDuskScene } from "./WelcomeScene";

interface LoginProps {
  onLogin: (u: string, p: string) => Promise<void>;
  onRegister: (u: string, p: string) => Promise<void>;
  error: string | null;
}

// Login layouts, switchable per deployment via VITE_LOGIN_VARIANT:
//   "split" — two-column: artwork left, form right.
//   "sky"   — fullscreen slow-drifting artwork, form centered on top.
//   default — "pixel": custom animated dusk scene in the app's own pixel style.
const LOGIN_VARIANT = ((): "split" | "sky" | "pixel" => {
  const v = import.meta.env.VITE_LOGIN_VARIANT;
  return v === "split" || v === "sky" ? v : "pixel";
})();

export function Login({ onLogin, onRegister, error }: LoginProps) {
  const [isRegistering, setIsRegistering] = useState(false);
  // Day/night for the pixel-city variant — the form recolors with the scene.
  const [day, setDay] = useState(false);
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

  // Warm (sunset-image) styling for the artwork variants; the pixel variant
  // uses the app's own neutral surfaces so login matches the product.
  const warm = LOGIN_VARIANT !== "pixel";

  const authPanel = (
    <div className="w-full max-w-[420px] mx-auto">
      <div className="mb-8 text-center">
        <div className="mb-4 flex justify-center">
          <PixelPet working={false} inline size={44} hopEveryMs={10_000} />
        </div>
        <h1
          className={`text-2xl font-semibold tracking-[-0.035em] transition-colors duration-700 ${
            !warm && day ? "text-[#202636]" : "text-white"
          }`}
        >
          {isRegistering ? "Create your workspace" : "Welcome back"}
        </h1>
        {warm && (
          <p className="mt-2 text-sm text-white/55">
            {isRegistering ? "Set up your Scout account to get started." : "Sign in to continue to Scout."}
          </p>
        )}
      </div>

      {/* Duolingo-style on pixel: fields float on the scene, no card box. */}
      <div className={warm ? "glass-warm rounded-card overflow-hidden" : ""}>
        <form className={warm ? "p-6 space-y-4" : "space-y-3"} onSubmit={handleSubmit}>
          {error && (
            <div className="p-3 text-sm text-white bg-scout-error-muted rounded-btn">
              {error}
            </div>
          )}

          <div>
            {warm && <Label className="text-sm text-[#f5e3c2]/80">Username</Label>}
            <Input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={warm ? "Enter your username" : "Username"}
              aria-label="Username"
              surface={warm ? "warm" : day ? "pixel-day" : "pixel-night"}
            />
          </div>

          <div>
            {warm && <Label className="text-sm text-[#f5e3c2]/80">Password</Label>}
            <PasswordInput
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={warm ? "••••••••" : "Password"}
              aria-label="Password"
              surface={warm ? "warm" : day ? "pixel-day" : "pixel-night"}
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
            className={!warm && day ? "!bg-[#202636] !text-white" : ""}
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

        {warm ? (
          <div className="px-6 pb-6">
            <HairlineDivider label="or" surface="void" />
            <Button
              type="button"
              variant="outlined"
              surface="void"
              fullWidth
              size="default"
              className="mt-4 !border-[#ffd6a0]/30 !text-[#f5e3c2] hover:!bg-white/5"
              onClick={() => setIsRegistering(!isRegistering)}
            >
              {isRegistering ? "Already have an account? Sign in" : "Create a new account"}
            </Button>
          </div>
        ) : (
          <p
            className={`mt-5 text-center text-sm transition-colors duration-700 ${
              day ? "text-[#3a4358]/80" : "text-white/55"
            }`}
          >
            {isRegistering ? "Already have an account?" : "New to Scout?"}{" "}
            <button
              type="button"
              onClick={() => setIsRegistering(!isRegistering)}
              className={`font-semibold underline underline-offset-4 transition-colors duration-700 ${
                day ? "text-[#202636] hover:text-[#3a4358]" : "text-white hover:text-white/80"
              }`}
            >
              {isRegistering ? "Sign in" : "Create an account"}
            </button>
          </p>
        )}
      </div>

      {warm && (
        <p className="mt-6 text-center text-caption text-white/40 leading-relaxed">
          Your workspace files stay within your configured Scout environment.
        </p>
      )}
    </div>
  );

  if (LOGIN_VARIANT === "pixel") {
    // Custom animated dusk scene in the app's own pixel language — no image.
    return (
      <div
        className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden"
        style={{
          background:
            "linear-gradient(180deg, #131218 0%, #1b1826 48%, #262038 78%, #201b2e 100%)",
        }}
      >
        <PixelDuskScene
          roadText="By signing up, you agree to our terms and conditions"
          day={day}
          onToggleDay={() => setDay((d) => !d)}
        />
        <div className="relative z-10 w-full px-6 py-12">{authPanel}</div>
      </div>
    );
  }

  if (LOGIN_VARIANT === "split") {
    return (
      <div
        className="flex flex-1 min-h-0 w-full bg-scout-void lg:flex-row"
        style={{
          backgroundImage:
            "radial-gradient(1000px 700px at 15% -10%, rgba(168,142,250,0.14), transparent 62%), radial-gradient(900px 650px at 90% 5%, rgba(228,148,82,0.11), transparent 60%)",
        }}
      >
        {/* Left column — image (hidden when viewport is too narrow for two columns) */}
        <div className="hidden lg:flex lg:flex-1 lg:min-h-0 items-center justify-center px-10 xl:px-14 py-10">
          <div className="relative h-[min(calc(100vh-5rem),920px)] w-full overflow-hidden rounded-hero border border-white/10 shadow-2xl">
            <img src={loginScreenImage} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-8 pb-8 pt-24">
              <p className="text-[22px] font-semibold tracking-[-0.03em] leading-snug text-white">
                Understand your data.
                <br />
                Scout finds the answers.
              </p>
              <p className="mt-2 max-w-sm text-sm text-white/70">
                An agent that reads your files, runs code, and brings back answers.
              </p>
            </div>
          </div>
        </div>

        {/* Right column — auth, vertically centered in the viewport */}
        <div className="flex flex-1 min-h-0 items-center justify-center px-8 lg:px-12 xl:px-16 py-12">
          {authPanel}
        </div>
      </div>
    );
  }

  // "sky" variant — fullscreen artwork drifting slowly, form centered on top.
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-scout-void">
      <img
        src={loginScreenImage}
        alt=""
        aria-hidden="true"
        className="login-sky-drift absolute inset-0 h-full w-full object-cover"
      />
      {/* readability veil */}
      <div className="absolute inset-0 bg-black/35" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/40" />
      <div className="relative z-10 w-full px-6 py-12">{authPanel}</div>
    </div>
  );
}
