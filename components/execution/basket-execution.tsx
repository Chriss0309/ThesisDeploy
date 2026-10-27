"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

import { ExecutionPanel, type ExecutionState } from "@/components/execution/execution-panel";
import { LinkPendingStatus } from "@/components/loader/pending";
import { buttonVariants } from "@/components/ui/button";
import type { ExecutionView } from "@/lib/execution/types";

/** The basket page's execution: resumes pending paper legs on open and refreshes the ledger once settled. */
export function BasketExecution({ execution, studioPath }: { execution: ExecutionView; studioPath?: string }) {
  const router = useRouter();
  const seen = useRef({ active: true, filled: -1 });
  const onStateChange = useCallback(
    ({ active, execution: current }: ExecutionState) => {
      const filled = current.legs.filter((leg) => leg.status === "executed" || leg.status === "partial").length;
      const changed = seen.current.filled >= 0 && (filled !== seen.current.filled || active !== seen.current.active);
      seen.current = { active, filled };
      if (changed) router.refresh();
    },
    [router],
  );
  return (
    <ExecutionPanel
      initial={execution}
      autoResume={execution.mode === "paper"}
      onStateChange={onStateChange}
      actions={
        studioPath ? (
          <Link href={studioPath} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Build another basket
            <LinkPendingStatus variant="scan" label="Opening Thesis Studio…" />
          </Link>
        ) : undefined
      }
    />
  );
}
