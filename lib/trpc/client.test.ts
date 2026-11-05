import { MutationObserver, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeQueryClient } from "@/lib/trpc/client";

describe("the query client while offline", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("fails a mutation at once instead of holding it for reconnect, so an order can't send itself later", async () => {
    onlineManager.setOnline(false);
    const mutationFn = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const observer = new MutationObserver(makeQueryClient(), { mutationFn });

    await expect(observer.mutate(undefined)).rejects.toThrow("Failed to fetch");

    expect(mutationFn).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().isPaused).toBe(false);
  });
});
