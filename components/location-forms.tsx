"use client";

import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { UNREACHABLE_MESSAGE } from "@/constants/execution";
import { PendingForm } from "@/components/loader/pending";
import type { LoaderVariant } from "@/components/loader/timing";
import { useTRPC } from "@/lib/trpc/client";
import { readClientError } from "@/lib/trpc/errors";

const describeFailure = (caught: unknown) => readClientError(caught)?.message ?? UNREACHABLE_MESSAGE;

export function SignOutForm({
  disconnect,
  pendingLabel,
  children,
}: {
  disconnect: boolean;
  pendingLabel: string;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const logout = useMutation(trpc.auth.logout.mutationOptions());
  return (
    <PendingForm
      run={() => logout.mutateAsync({ disconnect })}
      describeFailure={describeFailure}
      pendingLabel={pendingLabel}
    >
      {children}
    </PendingForm>
  );
}

export function RefreshAccountForm({
  accountId,
  pendingLabel,
  variant,
  children,
}: {
  accountId: string;
  pendingLabel: string;
  variant?: LoaderVariant;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const refresh = useMutation(trpc.portfolio.refreshAccount.mutationOptions());
  return (
    <PendingForm
      run={() => refresh.mutateAsync({ accountId })}
      describeFailure={describeFailure}
      pendingLabel={pendingLabel}
      variant={variant}
    >
      {children}
    </PendingForm>
  );
}
