// The agent's presence — a simple flat dot with a slow breathing ring while working.
// One accent (clay), forest when done.
export function AgentOrb({ size = 36, state = "idle" }: { size?: number; state?: "idle" | "working" | "done" }) {
  const color = state === "done" ? "bg-forest-600" : "bg-accent-600";
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {state === "working" && <span className={`absolute inset-0 rounded-full ${color} breathe`} />}
      <span className={`relative rounded-full ${color}`} style={{ width: size, height: size }} />
    </span>
  );
}
