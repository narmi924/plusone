import type { RuleDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { HOST_LANGUAGES, type HostLanguage, type useHostSpeech } from "../lib/speech";
import { useLive } from "../lib/useLiveRoom";

// The host sells the way they always do, out loud. PlusOne listens and turns
// announcements ("this one 39, only 3 left", "dress and blouse together, five
// off") into cards on the table; one tap applies a card. Nothing changes
// without that tap.

export function VoiceControl({ speech }: { speech: ReturnType<typeof useHostSpeech> }) {
  const [language, setLanguage] = useState<HostLanguage>("en");
  const heard = useLive((s) => s.heard);
  const hearing = useLive((s) => s.hearing);
  const on = speech.state === "on";

  return (
    <div
      className={`shrink-0 rounded-[10px] border-2 border-black p-3 ${on ? "bg-pale" : "bg-label"}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={speech.state === "starting"}
          onClick={() => void (on ? speech.stop() : speech.start(language))}
          aria-pressed={on}
          className="min-w-0 flex-1 text-left text-sm leading-tight font-extrabold disabled:opacity-60"
        >
          {on
            ? "Listening to you"
            : speech.state === "starting"
              ? "Starting…"
              : "Let PlusOne listen"}
        </button>
        <select
          value={language}
          disabled={on}
          onChange={(e) => setLanguage(e.target.value as HostLanguage)}
          aria-label="Language you're speaking"
          className="w-[84px] shrink-0 rounded-full border-[1.5px] border-black bg-label px-1.5 py-0.5 text-xs font-semibold"
        >
          {HOST_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 min-h-9 text-[13px] leading-snug" aria-live="polite">
        {on ? (
          hearing ? (
            <span>{hearing}</span>
          ) : heard ? (
            <span>“{heard}”</span>
          ) : (
            <span className="opacity-70">
              Say prices, stock and deals the way you normally would.
            </span>
          )
        ) : (
          <span className="text-quiet">
            Prices, new items and deals you say out loud become cards you can apply.
          </span>
        )}
      </p>
      {speech.error && <p className="mt-1 text-sm text-pen">{speech.error}</p>}
    </div>
  );
}

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
