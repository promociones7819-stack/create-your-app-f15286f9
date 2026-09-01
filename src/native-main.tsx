import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./smartmarket/App";
import "./smartmarket/smartmarket.css";

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró el contenedor principal");

async function updateNativeDesktopApp() {
  const nativeWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
  if (!nativeWindow.__TAURI_INTERNALS__) return;
  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // La aplicación sigue funcionando aunque GitHub no esté disponible.
  }
}

void updateNativeDesktopApp();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
