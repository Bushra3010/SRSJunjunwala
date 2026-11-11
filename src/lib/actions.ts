import "server-only";
import { redirect } from "next/navigation";
import { errorMessage } from "@/lib/format";

/** Redirect back to a page with a flash message in the query string. */
export function back(path: string, flash: { error?: string | { message?: string } | null; notice?: string }): never {
  const url = new URL(path, "http://x");
  if (flash.error) url.searchParams.set("error", typeof flash.error === "string" ? flash.error : errorMessage(flash.error));
  if (flash.notice) url.searchParams.set("notice", flash.notice);
  redirect(url.pathname + url.search);
}

export function str(fd: FormData, key: string) {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function optStr(fd: FormData, key: string) {
  return str(fd, key) || null;
}

export function optNum(fd: FormData, key: string) {
  const v = str(fd, key);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
