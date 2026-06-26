import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [
    starlight({
      title: "ccshare",
      description: "claude code subscription sharing with fair usage limits for teams",
      social: { github: "https://github.com/hexxt-git/ccshare" },
      customCss: ["./src/styles/global.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Installation", slug: "installation" },
          ],
        },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
