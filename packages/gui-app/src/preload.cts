import { contextBridge, ipcRenderer } from "electron";

const api = {
  listPythonEnvs: async (): Promise<
    Array<{ label: string; value: string; type: "venv" | "conda" | "system" }>
  > => ipcRenderer.invoke("scout:list-python-envs"),

  selectPythonEnv: async (env: {
    type: "venv" | "conda" | "system";
    value: string;
  }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("scout:select-python-env", env),

  getSelectedPythonEnv: async (): Promise<{
    condaEnv: string | null;
    pythonPath: string | null;
  }> => ipcRenderer.invoke("scout:get-selected-python-env"),
};

contextBridge.exposeInMainWorld("scoutDesktop", api);
