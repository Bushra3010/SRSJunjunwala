import type { Metadata } from "next";
import { Geist_Mono, Nunito } from "next/font/google";
import "./globals.css";

const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SRS Overseas Factory ERP",
  description: "Weighbridge, QC, orders, processing and inventory for Shree Rani Sati Overseas",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${nunito.variable} ${geistMono.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
