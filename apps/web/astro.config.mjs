import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  integrations: [
    tailwind({ applyBaseStyles: false }),
    starlight({
      title: "ccshare",
      description: "Fair Claude subscription sharing across 5-hour and weekly usage windows.",
      social: { github: "https://github.com/HEXXT/ccshare" },
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
});
