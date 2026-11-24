import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // pathname 对非 ASCII 目录名会百分号编码，需要解码回真实路径
    alias: { "@": decodeURIComponent(new URL("./src", import.meta.url).pathname) },
  },
});
