import { redirect } from "next/navigation";

/** The former "Processing" placeholder now lives in the Production module. */
export default function ProcessingPage() {
  redirect("/production");
}
