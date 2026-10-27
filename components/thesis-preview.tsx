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
  const chosen = THESIS_PRESETS.find((preset) => preset.prompt === thesis);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Start with a conviction</CardTitle>
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
              variant={thesis === preset.prompt ? "secondary" : "outline"}
              size="sm"
              onClick={() => setThesis(preset.prompt)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        {chosen && (
          <a href={`/demo/studio?preset=${chosen.key}`} className="text-sm font-medium underline underline-offset-4">
            Build this basket in the demo Studio
          </a>
        )}
      </CardContent>
      <CardFooter>{footer}</CardFooter>
    </Card>
  );
}
