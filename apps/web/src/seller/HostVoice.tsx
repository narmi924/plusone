import type { RuleDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/useLiveRoom";

// The host sells the way they always do, out loud. PlusOne listens and turns
// announcements ("this one 39, only 3 left", "dress and blouse together, five
// off") into cards on the table; one tap applies a card. Nothing changes
// without that tap.

const KIND_LABEL: Record<RuleDTO["kind"], string> = {
  show_product: "Put on screen",
  new_product: "New item",
  price: "New price",
  bundle: "Bundle deal",
  limit: "Limit per person",
};

export function VoiceCards({ sessionId, token }: { sessionId: string; token: string }) {
  const version = useLive((s) => s.rulesVersion);
  const [rules, setRules] = useState<RuleDTO[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the refetch signal
  useEffect(() => {
    api.rules(sessionId, token).then(setRules, () => undefined);
  }, [sessionId, token, version]);

  const proposed = rules.filter((r) => r.status === "proposed");
  const active = rules.filter(
    (r) => r.status === "active" && (r.kind === "bundle" || r.kind === "limit"),
  );

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    try {
      await run();
      setRules(await api.rules(sessionId, token));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {proposed.map((rule) => (
        <article
          key={rule.id}
          className="mb-3 flex flex-wrap items-center gap-3 rounded-[10px] border-2 border-black bg-pale px-3.5 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold">{KIND_LABEL[rule.kind]}, from what you said</div>
            <h3 className="text-[17px] leading-tight font-extrabold">{rule.summary}</h3>
            <p className="text-[13px] leading-snug text-black/70">You said: "{rule.quote}"</p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act(rule.id, () => api.applyRule(rule.id, token))}
            className="rounded-full border-2 border-black bg-black px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy === rule.id ? "Applying…" : "Apply"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act(rule.id, () => api.dismissRule(rule.id, token))}
            className="rounded-full border-2 border-black bg-label px-3.5 py-1.5 text-sm font-bold disabled:opacity-50"
          >
            Not now
          </button>
        </article>
      ))}
      {active.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {active.map((r) => (
            <span
              key={r.id}
              className="rounded-full border-2 border-dashed border-black bg-label px-3 py-1 text-[13px] font-bold"
            >
              On now: {r.summary}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
