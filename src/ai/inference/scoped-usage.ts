import { observeSummaryUsage } from "../summary/usage";
import type { InferenceUsage } from "./pricing";

/** Pin receipt identity before each binding invocation, including late stream usage. */
export function observeScopedInferenceUsage<Scope>(
  binding: Ai,
  capture: () => Scope,
  observe: (scope: Scope, usage: InferenceUsage) => Promise<void>,
): Ai {
  return new Proxy(binding, {
    get(target, property) {
      if (property === "run") {
        return (...args: Parameters<Ai["run"]>) => {
          const scope = capture();

          const observed = observeSummaryUsage(target, (usage) => observe(scope, usage));

          return Reflect.apply(observed.run.bind(observed), observed, args);
        };
      }

      const value: unknown = Reflect.get(target, property, target);

      const bound: unknown = typeof value === "function" ? value.bind(target) : value;

      return bound;
    },
  });
}
