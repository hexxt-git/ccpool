# CCSHARE - Retro Website Design Specification

Based on the provided mockup, this document outlines the design specifications for the "CCSHARE" website.

## 1. Overall Theme & Aesthetics

- **Style:** Retro, 8-bit / pixel art, terminal/CLI arcade aesthetic.
- **Vibe:** Nostalgic, technical, developer-focused.

## 2. Color Palette

- **Background:** Dark gray/almost black (e.g., `#111111` or `#0a0a0a`)
- **Primary Text:** White / Off-white (e.g., `#f0f0f0` or `#e0e0e0`)
- **Secondary Text (Footer, Subdued text):** Gray (e.g., `#888888`)
- **Accents:**
  - **Orange:** (e.g., `#FF6B00`) - Used for primary buttons, highlighted headings ("FAIR SHARING", Feature 1 & 2 headings).
  - **Green:** (e.g., `#00FF00` or `#4ade80`) - Used for the logo text ("CCSHARE"), Feature 3 heading.
  - **Other Sprite/Line Colors:** Blue, Green, Pink, Orange, Yellow, Purple (used for the user avatar sprites and the footer decorative lines).

## 3. Typography

- **Font Family:** A pixel or bitmap-style font is used universally across the site for headings, body text, buttons, and links.
- **Suggested Fonts:** `VT323`, `Press Start 2P`, `Silkscreen`, or `Pixelify Sans` from Google Fonts.
- **Hierarchy:**
  - **H1 (Hero):** Large, all-caps, chunky pixel font.
  - **H2/H3 (Features):** Medium size, colored, all-caps.
  - **Body Text:** Smaller, but still monospaced/pixelated, ensuring readability while maintaining the theme.

## 4. Layout Structure

### 4.1. Header (Navbar)

- **Left:** Logo consists of a pixel-art computer/alien sprite next to the text "CCSHARE" in green.
- **Right:** Navigation links with accompanying small pixel-art icons:
  - `[Doc Icon] docs`
  - `[GitHub Icon] github`
  - `[LinkedIn Icon] linkedin`
- **Border:** A subtle dark gray bottom border separates the header from the main content.

### 4.2. Hero Section

- **Split Layout:**
  - **Left Column (Content):**
    - **Headline:** "CLAUDE SUBSCRIPTION" (White) / "FAIR SHARING" (Orange).
    - **Subheadline:** "ccshare is a CLI tool for claude code subscription sharing with fair usage limits for teams."
    - **Call to Action (CTA) Buttons:**
      - **Primary (`GET STARTED`):** Orange background, black text, styled with a solid dark border/shadow to look like a chunky 3D retro button.
      - **Secondary (`VIEW GITHUB`):** Transparent/dark background, white text, gray border/shadow, same 3D retro button style.
  - **Right Column (Hero Graphic):**
    - A central pixel-art graphic of a CRT monitor displaying an orange starburst/sparkle.
    - Surrounded by 6 "Space Invaders" style alien/robot sprites representing users (`user_1` to `user_6`), each in a different color.

### 4.3. Features Section

- **Layout:** A 3-column grid of feature cards.
- **Card Styling:** Dark gray/black background with a thin, lighter gray solid border. Inner padding for text.
- **Card 1:**
  - **Title:** "1. 5-HOUR USAGE SMOOTHING" (Orange)
  - **Body:** Monitors active prompt volumes in rolling 5-hour slots. If a user exceeds their fair share, ccshare automatically queues requests to guarantee equal access.
- **Card 2:**
  - **Title:** "2. WEEKLY QUOTA CAPPING" (Yellow/Orange)
  - **Body:** Tracks total tokens spent throughout the week, helping teams stay within boundaries and avoid subscription suspensions or service lockouts.
- **Card 3:**
  - **Title:** "3. TIERED CAPACITY PROXYING" (Green)
  - **Body:** Optimizes throughput allocations depending on whether you share a Pro ($20/mo), Team ($100/mo), or custom Enterprise ($200/mo) tier subscription.

### 4.4. Footer

- **Decorative Divider:** A distinct set of 4 horizontal, colored, 1-pixel or 2-pixel tall lines stretching across the full width of the container just above the footer links (Colors: Blue, Green, Orange, Yellow/Red).
- **Bottom Row layout:**
  - **Left:** Logo icon + `ccshare © 2026` in gray text.
  - **Right:** Footer links: `PRIVACY POLICY`, `TERMS OF USE`, `DMCA` in gray text.

## 5. UI Components & Elements

- **Buttons:** Boxy, no border-radius. They use a hard drop-shadow/border effect to simulate a physical, clicky arcade button.
- **Icons:** All icons (social links, feature graphics) are strictly pixel art.
- **Borders:** Hard, 1px or 2px solid lines. No rounded corners (`border-radius: 0` everywhere).
