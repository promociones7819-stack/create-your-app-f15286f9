import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => ({
  root: "native",
  base: "./",
  envDir: ".",
  publicDir: resolve(process.cwd(), "public"),
  plugins: [react(), tsconfigPaths()],
  define: {
    "process.env": JSON.stringify(loadEnv(mode, ".", "")),
  },
  build: {
    outDir: "../dist-native",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(process.cwd(), "native/index.html"),
    },
  },
}));
