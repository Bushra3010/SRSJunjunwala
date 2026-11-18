import { lineRateText, qtl, rs, slipDate, type Slip, type SlipLine } from "@/lib/slips";

/** The printed purchase slip, laid out like the factory's paper "Paddy/Rice/Wheat slip". */
export function SlipDocument({ slip, lines }: { slip: Slip; lines: SlipLine[] }) {
  const cell = "border border-[#1b1b1b] px-2.5 py-1.5";
  return (
    <article className="slip-doc mx-auto w-full max-w-[720px] bg-white p-4 text-[13px] text-black sm:p-6" aria-label={`Purchase slip ${slip.slip_no}`}>
      <header className="mb-2 flex items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold tracking-[0.2em] text-[#444]">SHREE RANI SATI OVERSEAS PVT. LTD.</p>
          <h2 className="font-serif text-[20px] font-bold tracking-wide sm:text-[24px]">PADDY / RICE / WHEAT SLIP</h2>
        </div>
        <div className="text-right text-[11px] text-[#444]">
          <p className="font-bold">{slip.status === "draft" ? "DRAFT" : "(ORIGINAL)"}</p>
          <p>
            {slip.slip_no}
            {slip.revision > 0 ? ` · rev ${slip.revision}` : ""}
          </p>
        </div>
      </header>
      {slip.status === "cancelled" && (
        <p className="mb-2 border-2 border-[#a11a1a] p-2 text-center font-bold text-[#a11a1a]">CANCELLED — {slip.cancel_reason}</p>
      )}

      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <th className={`${cell} w-[22%] text-left font-semibold`}>GODOWN</th>
            <td className={`${cell} w-[28%] text-center font-bold`}>{slip.locations?.name ?? ""}</td>
            <th className={`${cell} w-[18%] text-left font-semibold`}>S.NO</th>
            <td className={`${cell} text-center font-bold`}>{slip.rst}</td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`}>VEHICLE NO.</th>
            <td className={`${cell} text-center font-bold`}>{slip.vehicle_no}</td>
            <th className={`${cell} text-left font-semibold`}>DATE</th>
            <td className={`${cell} text-center font-bold`}>{slipDate(slip.slip_date)}</td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`}>BROKER</th>
            <td className={`${cell} text-center font-bold uppercase`}>{slip.brokers?.name ?? ""}</td>
            <th className={`${cell} text-left font-semibold`}>VARIETY</th>
            <td className={`${cell} text-center font-bold`}>{slip.variety ?? ""}</td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`}>PARTY</th>
            <td className={`${cell} text-center font-bold uppercase`}>{slip.parties?.name ?? ""}</td>
            <th className={`${cell} text-left font-semibold`}>BAG</th>
            <td className={`${cell} text-center font-bold`}>
              {slip.bags_total}
              {slip.bags_rejected > 0 && <span className="block text-[11px] font-normal">({slip.bags_rejected} rejected)</span>}
            </td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`} colSpan={2}>
              NET WEIGHT (q)
            </th>
            <td className={`${cell} text-right font-bold tabular-nums`} colSpan={2}>
              {qtl(slip.net_kg)}
            </td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`} colSpan={2}>
              RATE (₹ / q)
            </th>
            <td className={`${cell} text-right font-bold tabular-nums`} colSpan={2}>
              {slip.rate_per_qtl ?? "—"}
            </td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`} colSpan={2}>
              AMOUNT
            </th>
            <td className={`${cell} text-right text-[15px] font-extrabold tabular-nums underline`} colSpan={2}>
              {rs(slip.amount)}
            </td>
          </tr>
          <tr>
            <th className={`${cell} text-center font-bold tracking-wide`} colSpan={4}>
              DEDUCTION
            </th>
          </tr>
          {lines.map((l) => (
            <tr key={l.id}>
              <th className={`${cell} text-left font-semibold uppercase`}>{l.label}</th>
              <td className={`${cell} text-center font-semibold ${l.pending ? "text-[#a11a1a]" : ""}`}>
                {lineRateText(l)}
                {l.basis !== "manual" && l.note && <span className="block text-[11px] font-normal">{l.note}</span>}
              </td>
              <td className={`${cell} text-right font-semibold tabular-nums`} colSpan={2}>
                {l.pending ? "—" : rs(l.amount)}
              </td>
            </tr>
          ))}
          <tr>
            <th className={`${cell} text-left text-[15px] font-extrabold`} colSpan={2}>
              TOTAL
            </th>
            <td className={`${cell} text-right text-[17px] font-extrabold tabular-nums underline decoration-double`} colSpan={2}>
              {rs(slip.net_payable)}
            </td>
          </tr>
        </tbody>
      </table>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 text-[11px] text-[#444] sm:grid-cols-4">
        <div>
          <dt className="inline">Vehicle type: </dt>
          <dd className="inline">{slip.vehicle_type || "—"}</dd>
        </div>
        <div>
          <dt className="inline">Moisture: </dt>
          <dd className="inline">{slip.moisture_pct != null ? `${slip.moisture_pct}%` : "—"}</dd>
        </div>
        <div>
          <dt className="inline">Bags: </dt>
          <dd className="inline capitalize">{slip.bag_status ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline">Weighbridge net: </dt>
          <dd className="inline">{qtl(slip.ticket_net_kg)} q</dd>
        </div>
        {slip.early_payment && <p className="col-span-2">Early payment (cash discount at the early-payment rate)</p>}
        {slip.status === "paid" && <p className="col-span-2 font-bold text-[#14632f]">PAID</p>}
      </dl>
    </article>
  );
}
