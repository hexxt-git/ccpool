# CCSHARE - Retro Website Design & Animation Specification

Based on the provided mockup and subsequent developments, this document outlines the comprehensive design specifications and the custom animation language for the "CCSHARE" website.

## 1. Overall Theme & Aesthetics

- **Style:** Retro, 8-bit / pixel art, terminal/CLI aesthetic.
- **Vibe:** Nostalgic, technical, developer-focused, dynamic and alive.

## 2. Color Palette

- **Background:** Dark gray/almost black (`#0c0c0c` / `var(--color-retro-bg)`)
- **Primary Text:** White / Off-white (`#e2e8f0` / `var(--color-retro-fg)`)
- **Secondary Text (Footer, Subdued text):** Gray (`#888888`)
- **Accents:**
  - **Orange:** (`#FF6B00`) - Used for primary buttons, highlighted headings ("FAIR SHARING", Feature 1).
  - **Green:** (`#4ade80`) - Used for the logo text ("CCSHARE"), Feature 3.
  - **Yellow:** Feature 2.
  - **Animation Palette:** A vibrant 4-color palette (`#FF6B00`, `#4ade80`, `#3b82f6`, `#a855f7`) used dynamically in reveal animations.

## 3. Typography

- **Font Family:** Strictly pixel/bitmap-style fonts across the site.
- **Heading Font:** `Press Start 2P` (`font-press`) for H1, buttons, and card titles.
- **Body Font:** `VT323` (`font-vt`) for paragraphs, nav links, and secondary text.
- **Hierarchy:**
  - **H1 (Hero):** Large, all-caps, chunky pixel font with tight negative tracking (`-1px`).
  - **H2 (Features):** Medium size, colored, all-caps.
  - **Body Text:** Smaller, monospaced/pixelated, ensuring readability while maintaining the theme.

## 4. Animation Language & Choreography

The website utilizes a bespoke animation system powered by Motion (formerly Framer Motion), designed to evoke CRT screens loading data, interlaced video, and retro gaming and terminal boot sequences.

### 4.1. "Retro Reveal" Striping Effect

A custom text and element reveal animation applied universally via the `.retro-reveal` class.

- **Mechanism:** Solid colored blocks (stripes) overlay the target element and sequentially shrink to `scaleX(0)` using a `circOut` easing curve, revealing the content beneath.
- **Customization:** Highly configurable via `data-` attributes:
  - `data-stripes`: Number of horizontal slices (default: 4).
  - `data-delay`: Initial delay before the sequence starts.
  - `data-direction`: Direction of the wipe (`left`, `right`, or `alternate`).
  - `data-color`: Can use the background color (`bg`) for a masking effect or the vibrant multi-color sequence (`stripes`).

### 4.2. Hero Graphic Sequence

A heavily choreographed, multi-stage loading sequence in the hero visualization:

1. **Monitor Boot:** The central CRT computer casing wipes into view.
2. **Claude Initialization:** The Claude logo blinks into existence inside the monitor with a stuttering opacity sequence (`0 -> 1 -> 0 -> 1`).
3. **Avatar Connections:** Six floating alien/robot avatars (`user_1` through `user_6`) sweep in sequentially in a specific staggered order (1, 3, 5, 2, 4, 6).
4. **Data Transfer:** Exactly 1.3 seconds after an avatar reveals, a dotted path of 6x6 pixel blocks fires rapidly (50ms stagger per dot) from the avatar back to the central monitor, simulating an established network connection.
5. **Continuous Idle:** Once loaded, avatars continuously float using offset CSS keyframe animations (`animate-float-a`, `animate-float-b`, etc.) to create organic, unsynchronized hovering movement.

### 4.3. Sequential Footer Lines

- The footer features 8 horizontal, colored, 2-pixel tall lines stretching across the full width of the container.
- **Animation:** Triggered when scrolled `inView`, the lines grow from `width: 0%` to `100%`.
- **Interlaced Stagger:** Odd-numbered lines animate first, followed by even-numbered lines, creating an interlaced loading effect over 1.5 seconds per set.

## 5. Layout Structure

### 5.1. Header (Navbar)

- **Left:** Pixel-art sprite logo with "CCSHARE" text.
- **Right (Desktop):** Navigation links (Docs, GitHub, LinkedIn) with crisp SVG pixel-art icons.
- **Right (Mobile):** A chunky SVG hamburger menu button that toggles a sliding, absolute-positioned dropdown (`max-h-0` to `max-h-[300px]`) containing the navigation links.
- **Behavior:** `sticky top-0 z-50` to persist seamlessly during scrolling.

### 5.2. Hero Section

- **Split Layout:** Content on the left (H1, description, staggered CTA buttons), Graphic Sequence on the right.
- **Call to Action Buttons:** Feature heavy 3D pixel shadows that compress on click.

### 5.3. Features Section

- A responsive 3-column grid (`grid-cols-3` to `grid-cols-1` on mobile).
- Cards utilize the `retro-reveal` effect with background masking and alternating directions to create a cascading, technical entry.
- Hard, solid borders and dark backgrounds.

### 5.4. Footer

- **Bottom Row:** Centered copyright and legal links (`PRIVACY POLICY`, `TERMS OF USE`, `DMCA`), sitting cleanly below the animated interlaced lines.

## 6. UI Components & Elements

- **Buttons:** Boxy, zero border-radius. They use hard drop-shadows (e.g., `4px 4px 0`) that reduce to `0px 0px 0` combined with translate transforms on `:active` to simulate a physical, clicky mechanical keyboard / arcade machine button.
- **Icons:** Strictly crisp, shape-rendered pixel art (`shape-rendering="crispEdges"` in SVG).
- **Borders:** Hard, solid lines. `border-radius: 0` is strictly enforced everywhere.
