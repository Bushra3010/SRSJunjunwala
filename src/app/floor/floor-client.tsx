"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

/** Live date and time (IST) for the operator header. */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <div className="h-10" />;
  const tz = { timeZone: "Asia/Kolkata" } as const;
  return (
    <div className="leading-tight">
      <div className="text-[11px] font-semibold text-[#475569] sm:text-[13px]">
        {now.toLocaleDateString("en-IN", { ...tz, weekday: "short", day: "numeric", month: "short" })}
      </div>
      <div className="text-[18px] font-extrabold tabular-nums text-[#0f1f3d] sm:text-[24px]">
        {now.toLocaleTimeString("en-IN", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false })}
      </div>
    </div>
  );
}

/** Online / offline pill from the browser's network state. */
export function OnlineStatus() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ${online ? "bg-[#dcf3e3] text-[#14632f]" : "bg-[#fde2e2] text-[#a11a1a]"}`}
      role="status"
    >
      <span className={`size-2 rounded-full ${online ? "bg-[#0a8f44]" : "bg-[#d10b0b]"}`} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

/** A big touch button that disables itself while its form is being sent, so one tap = one action. */
export function PressButton({
  children,
  tone,
  disabled,
  form,
  className = "",
}: {
  children: React.ReactNode;
  tone: "start" | "stop" | "navy";
  disabled?: boolean;
  form?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  const colors = {
    start: "bg-[#22813d] hover:bg-[#1c6e33]",
    stop: "bg-[#d32f37] hover:bg-[#b8262d]",
    navy: "bg-[#13284b] hover:bg-[#0c1c37]",
  }[tone];
  return (
    <button
      form={form}
      disabled={disabled || pending}
      className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-3 text-[15px] font-bold text-white shadow-sm transition ${colors} disabled:cursor-not-allowed disabled:bg-[#cbd2dc] disabled:text-[#6b7280] disabled:shadow-none ${className}`}
    >
      {pending ? "Saving…" : children}
    </button>
  );
}
