"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeButton() {
  const { setTheme, theme } = useTheme();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return (
    <Button aria-label="Cycle color theme" onClick={() => setTheme(next)} size="icon-sm" variant="ghost">
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </Button>
  );
}
