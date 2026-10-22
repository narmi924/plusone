import { type ReactNode, useState } from "react";
import { HOST_LANGUAGES, type HostLanguage, type useHostSpeech } from "../lib/speech";
import { useLive } from "../lib/useLiveRoom";
import type { useWatch } from "./HostEyes";

// Two helpers the host can switch on while selling: PlusOne listening (prices,
// deals and new items said out loud become cards) and PlusOne watching (what
// the host holds up goes on screen). One line underneath says what they're doing.

function Toggle({
  label,
  on,
  disabled,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-1 items-center justify-between rounded-full border-2 border-black py-1.5 pr-1.5 pl-3 text-[13px] font-bold disabled:opacity-60 ${on ? "bg-pale" : "bg-label"}`}
    >
      {label}
      <span className={`relative h-5 w-8 rounded-full ${on ? "bg-black" : "bg-[#cfc6b8]"}`}>
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

export function Helpers({
  speech,
  watch,
  cameraOn,
}: {
  speech: ReturnType<typeof useHostSpeech>;
  watch: ReturnType<typeof useWatch>;
  cameraOn: boolean;
}) {
  const [language, setLanguage] = useState<HostLanguage>("en");
  const heard = useLive((s) => s.heard);
  const hearing = useLive((s) => s.hearing);
  const listening = speech.state === "on";

  let line: ReactNode;
  if (watch.on && !cameraOn) line = "Turn your camera on and PlusOne will watch it.";
  else if (watch.watching && watch.look?.product)
    line = watch.look.onScreen ? (
      <>
        On screen: <b className="text-black">{watch.look.product.name}</b>, from your camera.
      </>
    ) : (
      <>
        I see <b className="text-black">{watch.look.product.name}</b>. Hold it there…
      </>
    );
  else if (listening && (hearing || heard)) line = hearing ?? `“${heard}”`;
  else if (listening || watch.watching)
    line = [
      listening && "Say prices and deals the way you normally do.",
      watch.watching && "Hold up the next item.",
    ]
      .filter(Boolean)
      .join(" ");
  else
    line = (
      <>
        Deals you say become cards. What you hold up goes on screen. Speaking{" "}
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as HostLanguage)}
          aria-label="Language you're speaking"
          className="bg-transparent font-semibold text-black underline decoration-dotted underline-offset-2 [field-sizing:content]"
        >
          {HOST_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </>
    );

  return (
    <div className="shrink-0">
      <div className="flex gap-2">
        <Toggle
          label="Listen"
          on={listening}
          disabled={speech.state === "starting"}
          onClick={() => void (listening ? speech.stop() : speech.start(language))}
        />
        <Toggle label="Watch" on={watch.on} onClick={watch.toggle} />
      </div>
      <p className="mt-2 min-h-9 text-[12.5px] leading-snug text-quiet" aria-live="polite">
        {line}
      </p>
      {(speech.error || watch.error) && (
        <p className="mt-1 text-sm text-pen">{speech.error ?? watch.error}</p>
      )}
    </div>
  );
}
