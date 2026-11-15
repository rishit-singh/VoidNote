import { createJSONStorage, type StateStorage } from "zustand/middleware";

const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

export const createSafeJsonStorage = () =>
  createJSONStorage(() => (typeof window === "undefined" ? noopStorage : window.localStorage));
