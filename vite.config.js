import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const REPO_NAME = "tournament-site"; // <- change if your repo name differs

export default defineConfig({
  plugins: [react()],
  base: `/${REPO_NAME}/`
});
