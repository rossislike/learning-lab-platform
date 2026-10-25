import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // The in-cluster gateway proxies app.<hostSuffix> (http://app.lab.localhost:8080)
    // to this server with the original Host kept; Vite 7 refuses unknown hosts.
    allowedHosts: [".lab.localhost", "host.docker.internal"],
  },
});
