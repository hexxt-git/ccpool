import { motion } from "motion/react";
import { useRef, useState, useEffect } from "react";

interface FooterStripesProps {
  sliceDuration?: number;
  loopDelay?: number;
  className?: string;
}

export default function FooterStripes({
  sliceDuration = 0.41,
  className = "",
}: FooterStripesProps) {
  const slices = Array.from({ length: 8 }, (_, i) => i + 1);
  const hasAnimated = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Only animate on first client mount, never on re-hydration
    if (!hasAnimated.current) {
      hasAnimated.current = true;
      const timer = setTimeout(() => {
        setReady(true);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <div className={`flex w-full select-none flex-col gap-[4px] ${className}`}>
      {Array.from({ length: 4 }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid w-full grid-cols-8" style={{ height: "4px" }}>
          {slices.map((sliceIndex) => {
            const isEven = sliceIndex % 2 === 0;

            return (
              <div
                key={sliceIndex}
                className="relative h-full w-full overflow-hidden bg-[#1a1a24]/40"
              >
                <motion.div
                  className="absolute bottom-0 left-0 top-0 w-full"
                  style={{
                    backgroundColor: `var(--color-retro-stripe-${rowIndex + 1})`,
                    transformOrigin: isEven ? "left" : "right",
                  }}
                  initial={false}
                  animate={{ scaleX: ready ? 1 : 0 }}
                  transition={{
                    duration: sliceDuration,
                    delay: 0,
                    ease: "linear",
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
