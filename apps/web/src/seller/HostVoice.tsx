import type { RuleDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { HOST_LANGUAGES, type HostLanguage, type useHostSpeech } from "../lib/speech";
import { useLive } from "../lib/useLiveRoom";

// The host sells the way they always do, out loud. PlusOne listens and turns
// announcements ("this one 39, only 3 left", "dress and blouse together, five
// off") into sticky notes on the book; one tap applies a note. Nothing changes
// without that tap.

export function VoiceControl({ speech }: { speech: ReturnType<typeof useHostSpeech> }) {
  const [language, setLanguage] = useState<HostLanguage>("en");
  const heard = useLive((s) => s.heard);
  const hearing = useLive((s) => s.hearing);
  const on = speech.state === "on";

  return (
    <div
      className={`shrink-0 rounded-[10px] p-3 ${on ? "bg-sticker" : "border-[1.5px] border-black"}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={speech.state === "starting"}
          onClick={() => void (on ? speech.stop() : speech.start(language))}
          aria-pressed={on}
          className="flex-1 text-left text-sm font-extrabold disabled:opacity-60"
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
          className="rounded-full bg-white/70 px-2 py-1 text-xs font-semibold"
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
            Prices, new items and deals you say out loud become notes you can apply.
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
      {proposed.map((rule, i) => (
        <article
          key={rule.id}
          className="relative float-right clear-right mb-4 ml-6 w-75 bg-sticker px-4 py-3.5 text-black shadow-[0_14px_28px_-12px_rgb(0_0_0/0.45)]"
          style={{ rotate: `${i % 2 ? -1.5 : 2}deg` }}
        >
          <div className="text-xs font-bold">{KIND_LABEL[rule.kind]}, from what you said</div>
          <h3 className="mt-1 text-xl leading-tight font-extrabold">{rule.summary}</h3>
          <p className="mt-1 font-hand text-base leading-snug">“{rule.quote}”</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act(rule.id, () => api.applyRule(rule.id, token))}
              className="rounded-full bg-black px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy === rule.id ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act(rule.id, () => api.dismissRule(rule.id, token))}
              className="rounded-full px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </article>
      ))}
      {active.map((r) => (
        <p key={r.id} className="font-hand text-xl leading-(--rule-h) text-pen">
          {r.summary}
        </p>
      ))}
    </>
  );
}
