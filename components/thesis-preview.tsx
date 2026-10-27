"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { THESIS_PRESETS } from "@/lib/presets";

export function ThesisPreview({ footer }: { footer: ReactNode }) {
  const [thesis, setThesis] = useState("");

  return (
    <Card className="w-full shadow-md">
      <CardHeader>
        <p className="eyebrow text-muted-foreground">► Thesis</p>
        <CardTitle className="font-display text-xl font-semibold">Start with a conviction</CardTitle>
        <CardDescription>
          One sentence is enough. Pick a preset or write your own.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Textarea
          aria-label="Investment thesis"
          placeholder="e.g. Utilities and grid suppliers that win as AI data centers strain North American power"
          value={thesis}
          maxLength={500}
          rows={3}
          onChange={(event) => setThesis(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {THESIS_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              variant={thesis === preset.prompt ? "default" : "outline"}
              aria-pressed={thesis === preset.prompt}
              size="sm"
              className="rounded-full"
              onClick={() => setThesis(preset.prompt)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </CardContent>
      <CardFooter>{footer}</CardFooter>
    </Card>
  );
}
