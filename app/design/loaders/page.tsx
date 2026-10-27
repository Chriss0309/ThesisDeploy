import type { Metadata } from "next";

import { LoaderGallery } from "@/components/loader/gallery";
import { PageShell } from "@/components/portfolio/page-shell";

export const metadata: Metadata = {
  title: "Loaders · ThesisDeploy",
  robots: { index: false },
};

export default function LoadersPage() {
  return (
    <PageShell
      eyebrow="Design system"
      title="Loaders"
      description="Every loading motif, rendered by the shared three.js engine. See docs/design-system.md."
    >
      <LoaderGallery />
    </PageShell>
  );
}
