import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "landholder — site intelligence",
  description:
    "Type an address or parcel number. Get a feasibility-grade Site Profile: zoning, flood, soil, water, terrain, demographics, amenities.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
