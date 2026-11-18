import "server-only";
import { rs, slipDate, type Slip } from "@/lib/slips";

/**
 * Automatic sending through the WhatsApp Business Cloud API (Meta).
 * Messages that the business starts must use a template approved in Meta Business Manager.
 * Set these on the server (Vercel env):
 *   WHATSAPP_TOKEN            permanent access token of the system user
 *   WHATSAPP_PHONE_NUMBER_ID  the sending number's ID
 *   WHATSAPP_SLIP_TEMPLATE    template name (default "purchase_slip")
 *   WHATSAPP_TEMPLATE_LANG    template language code (default "en")
 * The template body takes 5 values, in order:
 *   {{1}} slip no, {{2}} party, {{3}} RST · vehicle · date, {{4}} total payable, {{5}} link to the slip
 */
export function whatsappConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export type SendResult = { status: "sent" | "failed" | "not_configured"; detail: string };

export async function sendSlipTemplate(to: string, s: Slip, link: string): Promise<SendResult> {
  if (!whatsappConfigured()) {
    return { status: "not_configured", detail: "WhatsApp Business API is not set up (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." };
  }
  const params = [
    s.slip_no,
    s.parties?.name ?? "—",
    `RST ${s.rst} · ${s.vehicle_no} · ${slipDate(s.slip_date)}`,
    `₹${rs(s.net_payable)}`,
    link,
  ].map((text) => ({ type: "text", text }));
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: process.env.WHATSAPP_SLIP_TEMPLATE || "purchase_slip",
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en" },
          components: [{ type: "body", parameters: params }],
        },
      }),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) return { status: "failed", detail: json.error?.message ?? `HTTP ${res.status}` };
    return { status: "sent", detail: json.messages?.[0]?.id ? `Message ${json.messages[0].id}` : "Sent" };
  } catch (e) {
    return { status: "failed", detail: e instanceof Error ? e.message : "Network error" };
  }
}
