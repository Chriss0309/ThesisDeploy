import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("returns merged classes, so links styled as outline buttons keep their border", () => {
    const classes = buttonVariants({ variant: "outline", size: "sm" }).split(" ");
    expect(classes).toContain("border-input");
    expect(classes).not.toContain("border-transparent");
  });

  it("keeps the transparent border for variants that don't set one", () => {
    expect(buttonVariants({ size: "sm" }).split(" ")).toContain("border-transparent");
  });
});
