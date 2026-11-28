/** Request raw usage below adapters that omit stream_options from binding inputs. */
export function requestInferenceStreamUsage(binding: Ai): Ai {
  return new Proxy(binding, {
    get(target, property) {
      if (property === "run") {
        return (...[model, inputs, ...options]: Parameters<Ai["run"]>) => {
          if (
            inputs &&
            typeof inputs === "object" &&
            "stream" in inputs &&
            inputs.stream === true
          ) {
            const streamOptions = "stream_options" in inputs ? inputs.stream_options : undefined;

            return Reflect.apply(target.run.bind(target), target, [
              model,
              {
                ...inputs,
                stream_options: {
                  ...(streamOptions && typeof streamOptions === "object" ? streamOptions : {}),
                  include_usage: true,
                },
              },
              ...options,
            ]);
          }

          return Reflect.apply(target.run.bind(target), target, [model, inputs, ...options]);
        };
      }

      const value: unknown = Reflect.get(target, property, target);

      const bound: unknown = typeof value === "function" ? value.bind(target) : value;

      return bound;
    },
  });
}
