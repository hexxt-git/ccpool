import { motion, useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import { useState, useRef, useCallback, useEffect } from "react";

// ─── Data ────────────────────────────────────────────────────────────────────

const bodyPath =
  "M4,5h8v1h-8z M4,6h1v1h-1z M6,6h4v1h-4z M11,6h1v1h-1z M2,7h12v2h-12z M4,9h8v2h-8z M4,11h1v2h-1z M6,11h1v2h-1z M9,11h1v2h-1z M11,11h1v2h-1z";
const eyesPath = "M5,6h1v1h-1z M10,6h1v1h-1z";

interface UserConfig {
  id: number;
  name: string;
  left: number;
  top: number;
  flip: boolean;
  floatDuration: number;
  floatAmplitude: number;
}

const users: UserConfig[] = [
  {
    id: 1,
    name: "user_1",
    left: 25,
    top: -5,
    flip: false,
    floatDuration: 1.74,
    floatAmplitude: 10,
  },
  {
    id: 3,
    name: "user_3",
    left: 0,
    top: 120,
    flip: false,
    floatDuration: 2.099,
    floatAmplitude: 7,
  },
  {
    id: 5,
    name: "user_5",
    left: 20,
    top: 240,
    flip: false,
    floatDuration: 2.355,
    floatAmplitude: 10,
  },
  { id: 2, name: "user_2", left: 510, top: 0, flip: true, floatDuration: 1.484, floatAmplitude: 7 },
  {
    id: 4,
    name: "user_4",
    left: 540,
    top: 120,
    flip: true,
    floatDuration: 1.894,
    floatAmplitude: 10,
  },
  {
    id: 6,
    name: "user_6",
    left: 510,
    top: 230,
    flip: true,
    floatDuration: 1.689,
    floatAmplitude: 7,
  },
];

// ─── ClawdAvatar (inline SVG) ────────────────────────────────────────────────

function ClawdAvatar({ color, flip, width }: { color: string; flip: boolean; width: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={`h-auto select-none ${flip ? "-scale-x-100" : ""}`}
      style={
        {
          width: `${width}px`,
          "--avatar-color": color,
        } as React.CSSProperties
      }
    >
      <path d={bodyPath} fill="var(--avatar-color)" />
      <path d={eyesPath} fill="#000" />
    </svg>
  );
}

// ─── Dynamic Connection dots for a single user ───────────────────────────────

function ConnectionDots({
  user,
  dragX,
  dragY,
  floatY,
  revealed,
  connected,
  revealDelay,
  scale,
}: {
  user: UserConfig;
  dragX: MotionValue<number>;
  dragY: MotionValue<number>;
  floatY: MotionValue<number>;
  revealed: boolean;
  connected: boolean;
  revealDelay: number;
  scale: number;
}) {
  const computerCenter = { x: 320 * scale, y: 170 * scale };

  // Recalculate dynamic line start, end and dots inside useTransform
  const dotsCoords = useTransform(
    [dragX, dragY, floatY],
    ([dragXVal, dragYVal, floatYVal]: number[]) => {
      // Dynamic center of ClawdUser
      const userCenter = {
        x: (user.left + 50) * scale + dragXVal,
        y: (user.top + 42) * scale + dragYVal + floatYVal,
      };

      const dx = userCenter.x - computerCenter.x;
      const dy = userCenter.y - computerCenter.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const R_computer = 130 * scale;
      const R_clawd = 40 * scale;
      const effDist = Math.max(distance, R_computer + R_clawd + 5);

      // Computer edge connection point
      const pComputer = {
        x: computerCenter.x + (dx / effDist) * R_computer,
        y: computerCenter.y + (dy / effDist) * R_computer,
      };

      // Clawd edge connection point
      const pClawd = {
        x: userCenter.x - (dx / effDist) * R_clawd,
        y: userCenter.y - (dy / effDist) * R_clawd,
      };

      const wireLength = Math.max(0, effDist - R_computer - R_clawd);
      const dotSpacing = 24 * scale;
      const numDots = Math.max(1, Math.round(wireLength / dotSpacing));

      // Build dot positions and check visibility
      const maxDots = 8;
      const dotList = [];
      const snapGrid = Math.max(2, Math.round(6 * scale)) / 4;

      for (let i = 0; i < maxDots; i++) {
        if (i < numDots) {
          const progress = (i + 1) / (numDots + 1);
          const rawX = pComputer.x + (pClawd.x - pComputer.x) * progress;
          const rawY = pComputer.y + (pClawd.y - pComputer.y) * progress;
          dotList.push({
            x: Math.round(rawX / snapGrid) * snapGrid,
            y: Math.round(rawY / snapGrid) * snapGrid,
            visible: true,
          });
        } else {
          dotList.push({ x: -100, y: -100, visible: false });
        }
      }
      return dotList;
    }
  );

  const dotSize = Math.max(2, Math.round(6 * scale));
  const dotHalf = Math.round(dotSize / 2);

  return (
    <g>
      {Array.from({ length: 8 }).map((_, i) => {
        // Individual dot coords derived reactively
        const dotX = useTransform(dotsCoords, (list) => list[i].x);
        const dotY = useTransform(dotsCoords, (list) => list[i].y);
        const isVisible = useTransform(dotsCoords, (list) => list[i].visible);

        return (
          <motion.rect
            key={i}
            x={-dotHalf}
            y={-dotHalf}
            width={dotSize}
            height={dotSize}
            fill="var(--color-retro-fg)"
            style={{
              x: dotX,
              y: dotY,
              visibility: useTransform(isVisible, (vis: boolean) => (vis ? "visible" : "hidden")),
            }}
            initial={{ opacity: 0 }}
            animate={revealed && connected ? { opacity: 1 } : { opacity: 0 }}
            transition={
              revealed && connected
                ? { delay: revealDelay + (7 - i) * 0.025, duration: 0.1 }
                : { duration: 0.05 }
            }
          />
        );
      })}
    </g>
  );
}

// ─── Single ClawdUser with drag, shake, disconnect, float ────────────────────

function ClawdUser({
  user,
  dragX,
  dragY,
  floatY,
  revealed,
  onDisconnect,
  connected,
  revealDelay,
  onDragStart,
  onDragEnd,
  scale,
}: {
  user: UserConfig;
  dragX: MotionValue<number>;
  dragY: MotionValue<number>;
  floatY: MotionValue<number>;
  revealed: boolean;
  onDisconnect: (id: number) => void;
  connected: boolean;
  revealDelay: number;
  onDragStart: (id: number) => void;
  onDragEnd: (id: number) => void;
  scale: number;
}) {
  const colorVar = `var(--color-retro-user-${user.id})`;
  const [shaking, setShaking] = useState(false);
  const [revealDone, setRevealDone] = useState(false);
  const cooldownRef = useRef(false);

  // floatY animated smoothly on the GPU thread by Framer Motion (relative to current scale)
  useEffect(() => {
    if (!connected) {
      floatY.set(0);
      return;
    }
    const controls = animate(floatY, [0, -user.floatAmplitude * scale, 0], {
      duration: user.floatDuration,
      ease: "easeInOut",
      repeat: Infinity,
    });
    return controls.stop;
  }, [floatY, user.floatAmplitude, user.floatDuration, connected, scale]);

  // Reset revealDone when disconnected so the sweep plays again on reconnect
  useEffect(() => {
    if (!connected) setRevealDone(false);
  }, [connected]);

  const hasDraggedRef = useRef(false);

  const handleHover = useCallback(() => {
    if (cooldownRef.current || shaking || !connected) return;
    setShaking(true);
    cooldownRef.current = true;
    setTimeout(() => setShaking(false), 500);
    setTimeout(() => {
      cooldownRef.current = false;
    }, 10000);
  }, [shaking, connected]);

  const handleTap = useCallback(() => {
    if (hasDraggedRef.current) return;
    if (!connected) return;
    onDisconnect(user.id);
  }, [connected, onDisconnect, user.id]);

  const handleDragStart = useCallback(() => {
    hasDraggedRef.current = false;
    onDragStart(user.id);
  }, [onDragStart, user.id]);

  const handleDrag = useCallback(() => {
    hasDraggedRef.current = true;
  }, []);

  const handleDragEnd = useCallback(() => {
    onDragEnd(user.id);
    // Reset hasDraggedRef after the tap event has finished propagation in this tick
    setTimeout(() => {
      hasDraggedRef.current = false;
    }, 50);
  }, [onDragEnd, user.id]);

  return (
    <motion.div
      drag
      dragMomentum={false}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      className="absolute flex flex-col items-center overflow-visible"
      style={{
        left: user.left * scale,
        top: user.top * scale,
        width: 100 * scale,
        x: dragX,
        y: dragY,
        cursor: "pointer",
      }}
      initial={{ opacity: 0 }}
      animate={revealed ? (connected ? { opacity: 1 } : { opacity: 0 }) : { opacity: 0 }}
      transition={{ opacity: { delay: revealDone ? 0 : revealDelay, duration: 0.2 } }}
      onHoverStart={handleHover}
      onTap={handleTap}
    >
      {/* Floating container */}
      <motion.div
        className="relative flex flex-col items-center overflow-visible"
        style={{ y: floatY }}
      >
        {/* Shake wrapper */}
        <motion.div
          animate={
            shaking
              ? {
                  x: [
                    0,
                    -2 * scale,
                    2 * scale,
                    -2 * scale,
                    2 * scale,
                    -1 * scale,
                    1 * scale,
                    -1 * scale,
                    1 * scale,
                    0,
                  ],
                  rotate: [0, -1, 1, 0, -1, 1, 0, -1, 1, 0],
                }
              : { x: 0, rotate: 0 }
          }
          transition={shaking ? { duration: 0.5, ease: "easeInOut" } : { duration: 0.1 }}
        >
          <ClawdAvatar color={colorVar} flip={user.flip} width={84 * scale} />
        </motion.div>
        <span
          className="font-vt -translate-y-4 tracking-[1px]"
          style={{
            color: colorVar,
            fontSize: `${24 * scale}px`,
          }}
        >
          {user.name}
        </span>
      </motion.div>

      {/* Retro reveal masking overlay: slides off to reveal avatar */}
      {!revealDone && connected && (
        <motion.div
          className="pointer-events-none absolute z-30"
          style={{
            backgroundColor: "var(--color-retro-bg)",
            transformOrigin: "right",
            inset: `${-15 * scale}px`,
          }}
          initial={{ scaleX: 1 }}
          animate={revealed ? { scaleX: 0 } : { scaleX: 1 }}
          transition={{ delay: revealDelay, duration: 0.2, ease: "linear" }}
          onAnimationComplete={() => {
            if (revealed && connected) setRevealDone(true);
          }}
        />
      )}
    </motion.div>
  );
}

// ─── Main Visualization ──────────────────────────────────────────────────────

export default function Visualization() {
  const [revealed, setRevealed] = useState(false);
  const [connectedMap, setConnectedMap] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(users.map((u) => [u.id, true]))
  );
  const [disconnectedQueue, setDisconnectedQueue] = useState<number[]>([]);
  const [reconnectedSet, setReconnectedSet] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitialRef = useRef(true);

  // Set isInitialRef.current to false after first load completes
  useEffect(() => {
    if (revealed) {
      const timer = setTimeout(() => {
        isInitialRef.current = false;
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [revealed]);

  // Dynamic scale state to communicate container sizes directly
  const [scale, setScale] = useState(0.9);

  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      if (w <= 380) setScale(0.4);
      else if (w <= 480) setScale(0.45);
      else if (w <= 640) setScale(0.55);
      else setScale(0.9);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Continuous logo rotation values and loop to change speed seamlessly without snapping
  const logoRotate = useMotionValue(0);
  const rotateRef = useRef(0);

  const activeCount = Object.values(connectedMap).filter(Boolean).length;

  useEffect(() => {
    let frameId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      // Normal speed: 360 degrees in 6.144 seconds
      // 1-2 users: 30% speed
      // 3 users: 60% speed
      // 4-5 users: 85% speed
      // 6 users: 100% speed
      let speedFactor = 1.0;
      if (activeCount <= 2) {
        speedFactor = 0.3;
      } else if (activeCount === 3) {
        speedFactor = 0.6;
      } else if (activeCount <= 5) {
        speedFactor = 0.85;
      }

      const speed = (360 / 6.144) * speedFactor;
      rotateRef.current = (rotateRef.current + speed * delta) % 360;
      logoRotate.set(rotateRef.current);

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [activeCount, logoRotate]);

  // Dragging states
  const [draggingMap, setDraggingMap] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(users.map((u) => [u.id, false]))
  );
  const [dragEndCountMap, setDragEndCountMap] = useState<Record<number, number>>(() =>
    Object.fromEntries(users.map((u) => [u.id, 0]))
  );

  // Drag and Float motion values for each user
  const d1x = useMotionValue(0),
    d1y = useMotionValue(0),
    f1y = useMotionValue(0);
  const d2x = useMotionValue(0),
    d2y = useMotionValue(0),
    f2y = useMotionValue(0);
  const d3x = useMotionValue(0),
    d3y = useMotionValue(0),
    f3y = useMotionValue(0);
  const d4x = useMotionValue(0),
    d4y = useMotionValue(0),
    f4y = useMotionValue(0);
  const d5x = useMotionValue(0),
    d5y = useMotionValue(0),
    f5y = useMotionValue(0);
  const d6x = useMotionValue(0),
    d6y = useMotionValue(0),
    f6y = useMotionValue(0);

  const dragValues: Record<
    number,
    { x: MotionValue<number>; y: MotionValue<number>; floatY: MotionValue<number> }
  > = {
    1: { x: d1x, y: d1y, floatY: f1y },
    2: { x: d2x, y: d2y, floatY: f2y },
    3: { x: d3x, y: d3y, floatY: f3y },
    4: { x: d4x, y: d4y, floatY: f4y },
    5: { x: d5x, y: d5y, floatY: f5y },
    6: { x: d6x, y: d6y, floatY: f6y },
  };

  // Trigger reveal when component enters viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleDisconnect = useCallback((id: number) => {
    setConnectedMap((prev) => ({ ...prev, [id]: false }));
    setDisconnectedQueue((prev) => [...prev, id]);
  }, []);

  const handleReconnect = useCallback(() => {
    if (disconnectedQueue.length === 0) return;
    const nextId = disconnectedQueue[0];
    // Reset drag/float positions before reconnecting
    dragValues[nextId].x.set(0);
    dragValues[nextId].y.set(0);
    dragValues[nextId].floatY.set(0);
    setConnectedMap((prev) => ({ ...prev, [nextId]: true }));
    setDisconnectedQueue((prev) => prev.slice(1));
    setReconnectedSet((prev) => new Set(prev).add(nextId));
    // Reset drag end count on reconnect so it triggers instant layout
    setDragEndCountMap((prev) => ({ ...prev, [nextId]: prev[nextId] + 1 }));
  }, [disconnectedQueue, dragValues]);

  const handleDragStart = useCallback((id: number) => {
    setDraggingMap((prev) => ({ ...prev, [id]: true }));
  }, []);

  const handleDragEnd = useCallback((id: number) => {
    setDraggingMap((prev) => ({ ...prev, [id]: false }));
    setDragEndCountMap((prev) => ({ ...prev, [id]: prev[id] + 1 }));
  }, []);

  const hasDisconnected = disconnectedQueue.length > 0;

  return (
    <div
      ref={containerRef}
      className="relative flex w-full items-center justify-center overflow-visible"
      style={{
        height: `${340 * scale}px`,
      }}
    >
      {/* Reconnect button */}
      {hasDisconnected && (
        <motion.button
          onClick={handleReconnect}
          className="font-press text-retro-btn text-retro-fg border-retro-outline bg-retro-bg absolute left-0 top-0 z-20 flex h-[32px] w-[32px] cursor-pointer select-none items-center justify-center border-2 text-3xl no-underline shadow-[4px_4px_0_theme(colors.retro.outline-shadow)] transition-all duration-75 hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_theme(colors.retro.outline-shadow)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2 }}
        >
          +
        </motion.button>
      )}

      <div
        className="relative shrink-0 overflow-visible"
        style={{
          width: `${640 * scale}px`,
          height: `${340 * scale}px`,
        }}
      >
        {/* DOTS */}
        <svg
          className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          style={{
            width: `${640 * scale}px`,
            height: `${340 * scale}px`,
          }}
          viewBox={`0 0 ${640 * scale} ${340 * scale}`}
        >
          {users.map((user, i) => {
            const isReconnect = reconnectedSet.has(user.id);
            const hasDragged = dragEndCountMap[user.id] > 0;
            const baseDelay = isReconnect ? 0 : (i + 2) * 0.15 + 0.2;
            return (
              <ConnectionDots
                key={`${user.id}-${dragEndCountMap[user.id]}`}
                user={user}
                dragX={dragValues[user.id].x}
                dragY={dragValues[user.id].y}
                floatY={dragValues[user.id].floatY}
                revealed={revealed}
                connected={connectedMap[user.id] && !draggingMap[user.id]}
                revealDelay={isReconnect || hasDragged ? 0 : baseDelay + 0.65}
                scale={scale}
              />
            );
          })}
        </svg>

        {/* MONITOR */}
        <div
          className="absolute"
          style={{
            left: `${180 * scale}px`,
            top: `${10 * scale}px`,
            width: `${280 * scale}px`,
          }}
        >
          <motion.div
            initial={{ clipPath: "inset(0 100% 0 0)", opacity: 0 }}
            animate={revealed ? { clipPath: "inset(0 0% 0 0)", opacity: 1 } : {}}
            transition={{ delay: 0.2, duration: 0.2, ease: "linear" }}
          >
            <img
              src="/desktop.png"
              alt="monitor"
              className="block w-full select-none opacity-90 [image-rendering:pixelated]"
            />
          </motion.div>
          {(() => {
            const targetOpacity = activeCount === 0 ? 0 : 1;

            return (
              <motion.div
                className="absolute flex items-center justify-center overflow-hidden"
                style={{
                  left: `${58 * scale}px`,
                  top: `${63 * scale}px`,
                  width: "38%",
                  height: "38%",
                }}
                initial={{ opacity: 0 }}
                animate={
                  revealed
                    ? {
                        opacity: targetOpacity,
                      }
                    : { opacity: 0 }
                }
                transition={{
                  opacity: {
                    delay: revealed && activeCount > 0 && isInitialRef.current ? 1 * 0.15 + 0.2 : 0,
                    duration: 0.4,
                  },
                }}
              >
                <motion.img
                  src="/claude.webp"
                  alt="Claude"
                  className="h-auto w-full select-none opacity-90 [image-rendering:pixelated]"
                  style={{ rotate: logoRotate }}
                />
              </motion.div>
            );
          })()}
        </div>

        {/* USERS */}
        {users.map((user, i) => {
          const revealDelay = reconnectedSet.has(user.id) ? 0 : (i + 2) * 0.15 + 0.2;
          return (
            <ClawdUser
              key={user.id}
              user={user}
              dragX={dragValues[user.id].x}
              dragY={dragValues[user.id].y}
              floatY={dragValues[user.id].floatY}
              revealed={revealed}
              connected={connectedMap[user.id]}
              onDisconnect={handleDisconnect}
              revealDelay={revealDelay}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              scale={scale}
            />
          );
        })}
      </div>
    </div>
  );
}
