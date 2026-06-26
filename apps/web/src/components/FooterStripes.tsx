import { motion } from "motion/react";

interface FooterStripesProps {
  sliceDuration?: number;
  loopDelay?: number;
  className?: string;
}

export default function FooterStripes({ sliceDuration = 0.8, className = "" }: FooterStripesProps) {
  const slices = Array.from({ length: 12 }, (_, i) => i + 1);

  return (
    <div className={`flex w-full select-none flex-col gap-[3px] ${className}`}>
      {Array.from({ length: 4 }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid w-full grid-cols-12" style={{ height: "3px" }}>
          {slices.map((sliceIndex) => {
            const isEven = sliceIndex % 2 === 0;

            const animateValues = 1;

            const transitionConfig = {
              duration: sliceDuration,
              delay: 0,
              ease: "linear",
            } as const;

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
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: animateValues }}
                  transition={transitionConfig}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
