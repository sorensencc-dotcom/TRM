export const title = "TRM lineage append integrity";

export const colors = {
  healthy: "teal",
  danger: "orange",
};

export const state = (v) => {
  if (v.returned === 2) return "Both appends persisted";
  const phases = Object.values(v.phase);
  if (phases.every((phase) => phase === "ready")) return "No append started";
  if (v.lock !== "" && v.returned === 0 && phases.every((phase) => phase === "read")) return "Topic lock held";
  if (phases.some((phase) => phase === "read" || phase === "computed")) {
    return "Append prepared from a snapshot";
  }
  return "One append persisted";
};

export const group = (v) =>
  v.returned > Object.keys(v.operations).length ? "danger" : "healthy";

export const step = (action) => {
  if (action.includes("Acquire")) return "a process acquires the topic lock";
  if (action.includes("Read")) return "a process reads the lineage file";
  if (action.includes("Compute")) return "a process prepares its operation";
  if (action.includes("Write")) return "a process writes its snapshot";
  return null;
};
