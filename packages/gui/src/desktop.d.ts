type DesktopEnvType = "venv" | "conda" | "system";

interface DesktopEnvOption {
  label: string;
  value: string;
  type: DesktopEnvType;
}

interface ScoutDesktopApi {
  listPythonEnvs: () => Promise<DesktopEnvOption[]>;
  selectPythonEnv: (env: {
    type: DesktopEnvType;
    value: string;
  }) => Promise<{ ok: boolean; message: string }>;
  getSelectedPythonEnv: () => Promise<{
    condaEnv: string | null;
    pythonPath: string | null;
  }>;
}

declare global {
  interface Window {
    scoutDesktop?: ScoutDesktopApi;
  }
}

declare module "*.png" {
  const src: string;
  export default src;
}

export {};
