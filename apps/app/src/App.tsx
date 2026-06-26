const members = [
  { name: "alice", used5h: 62, used7d: 34 },
  { name: "bob", used5h: 18, used7d: 41 },
  { name: "carol", used5h: 20, used7d: 25 },
];

function UsageBar({ pct }: { pct: number }) {
  const filled = Math.round(pct / 5);
  return (
    <span className="font-mono text-xs tracking-tight">
      <span className="text-black">{"█".repeat(filled)}</span>
      <span className="text-neutral-200">{"█".repeat(20 - filled)}</span>
      <span className="ml-2 text-neutral-500">{pct}%</span>
    </span>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white p-8 font-mono text-black">
      <div className="w-full max-w-xl border border-black p-6">
        <div className="mb-4 text-xs uppercase tracking-widest text-neutral-400">
          ▸ ccshare / usage dashboard
        </div>

        <div className="mb-6 border-t border-black" />

        <div className="mb-6">
          <div className="mb-3 text-xs uppercase tracking-widest text-neutral-400">
            5-hour window
          </div>
          <div className="space-y-3">
            {members.map((m) => (
              <div key={m.name} className="flex items-center gap-4">
                <span className="w-12 text-xs">{m.name}</span>
                <UsageBar pct={m.used5h} />
              </div>
            ))}
          </div>
        </div>

        <div className="mb-6 border-t border-neutral-200" />

        <div>
          <div className="mb-3 text-xs uppercase tracking-widest text-neutral-400">
            weekly window
          </div>
          <div className="space-y-3">
            {members.map((m) => (
              <div key={m.name} className="flex items-center gap-4">
                <span className="w-12 text-xs">{m.name}</span>
                <UsageBar pct={m.used7d} />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 border-t border-black pt-4 text-xs text-neutral-400">
          next 5h reset in <span className="text-black">2h 14m</span> &nbsp;·&nbsp; weekly reset in{" "}
          <span className="text-black">4d 07h</span>
        </div>
      </div>
    </div>
  );
}
