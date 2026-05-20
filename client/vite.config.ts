import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: ".",
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
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
