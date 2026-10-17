import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "pi-template",
  description: "Chat with the harness agent and edit its workspace files.",
};

// System fonts: `next/font/google` would fetch from Google on every dev start of a local app.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className="h-full font-sans antialiased" lang="en" suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
