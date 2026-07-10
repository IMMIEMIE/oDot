import type { Metadata } from "next";
import { IBM_Plex_Mono, Noto_Sans, Noto_Sans_JP, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const sans = Noto_Sans({ variable: "--font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const sansSc = Noto_Sans_SC({ variable: "--font-sans-sc", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const sansJp = Noto_Sans_JP({ variable: "--font-sans-jp", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500", "600"] });
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "oDot — Stay in the flow",
  description: "An IDE-agnostic, open-source AI coding assistant that keeps the agent close and your attention in the code.",
  icons: { icon: `${basePath}/favicon.png`, shortcut: `${basePath}/favicon.png`, apple: `${basePath}/favicon.png` },
  openGraph: {
    title: "oDot — Stay in the flow",
    description: "Your attention was never meant to fragment. Meet the IDE-agnostic AI coding assistant.",
    type: "website",
    locale: "zh_CN",
    alternateLocale: ["en_US", "ja_JP"],
  },
  twitter: { card: "summary_large_image", title: "oDot — Stay in the flow", description: "The IDE-agnostic AI coding assistant." },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${sans.variable} ${sansSc.variable} ${sansJp.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
