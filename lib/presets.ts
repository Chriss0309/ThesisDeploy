export type ThesisPreset = {
  key: string;
  label: string;
  prompt: string;
};

export const THESIS_PRESETS: ThesisPreset[] = [
  {
    key: "ai-power-nuclear",
    label: "AI power & nuclear",
    prompt:
      "Data center power grid bottleneck and nuclear energy utilities in North America",
  },
  {
    key: "critical-minerals",
    label: "Critical minerals",
    prompt:
      "Canadian and US critical minerals miners feeding the EV battery supply chain",
  },
  {
    key: "ai-cybersecurity",
    label: "AI-era cybersecurity",
    prompt:
      "Cybersecurity platforms that benefit as AI expands the corporate attack surface",
  },
];
