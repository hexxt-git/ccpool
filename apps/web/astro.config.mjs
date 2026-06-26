import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

export default defineConfig({
  markdown: {
    shikiConfig: {
      theme: "css-variables",
    },
  },
  integrations: [mdx(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
