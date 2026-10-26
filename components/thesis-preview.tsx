"use client";

import { useState } from "react";

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

export function ThesisPreview() {
  const [thesis, setThesis] = useState("");

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
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button size="lg" disabled>
          Sign in with SnapTrade
        </Button>
        <p className="text-xs text-muted-foreground">
          Sign-in is next on the roadmap. Paper mode will work without a funded
          account.
        </p>
      </CardFooter>
    </Card>
  );
}
