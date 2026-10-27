import "react";

type MotifAttributes = import("react").HTMLAttributes<HTMLElement> & {
  ref?: import("react").Ref<HTMLElement>;
  variant?: string;
  pose?: string;
  mode?: "mark";
  reveal?: "data";
  legs?: string;
  delay?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "td-motif": MotifAttributes;
      "td-reveal": import("react").HTMLAttributes<HTMLElement> & { legs?: string };
    }
  }
}
