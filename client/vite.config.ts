import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  resolve: {
    alias: {
      "../../shared": path.resolve(__dirname, "../shared"),
      "../server":    path.resolve(__dirname, "../server"),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
