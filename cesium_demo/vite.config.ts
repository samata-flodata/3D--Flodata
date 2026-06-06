import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium({ rebuildCesium: true })],
  server: {
    port: 5500,
    strictPort: true
  }
});
