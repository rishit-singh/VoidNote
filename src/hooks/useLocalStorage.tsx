import { useState } from "react";

export function useLocalStorage<T>(key: string, initialValue: T, parse: (value: unknown) => T) {
  // Read once during hook initialization, then keep React state and storage in sync.
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      if (typeof window === "undefined") {
        return initialValue;
      }
      const item = window.localStorage.getItem(key);
      return item ? parse(JSON.parse(item) as unknown) : initialValue;
    } catch (error) {
      console.log(error);
      return initialValue;
    }
  });
  // Mirror the useState setter API while persisting every accepted value.
  const setValue = (value: T | ((val: T) => T)) => {
    try {
      // Allow value to be a function so we have same API as useState
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      console.log(error);
    }
  };

  return [storedValue, setValue] as const;
}
